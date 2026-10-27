/*
    Separate Desktops per Monitor

    KWin has a single global "current desktop". To give every monitor its own
    current desktop this script emulates it:

    - The "host" monitor (where the cursor / active window is) uses KWin's real
      desktop switching, so the normal Slide animation still plays for it.
    - Windows on every other monitor are taken out of KWin's desktop switching:
      the ones that should be visible are put on all desktops, the ones that
      belong to another desktop are minimized (and also put on all desktops) by
      this script until their monitor shows their desktop again.
    - Moving the cursor / focus to another monitor hands the "host" role over.

    KWin keeps tiles per desktop and un-tiles a window that is on all desktops as soon
    as the current desktop changes, moving it to its old floating geometry. So a visible
    frozen window is detached from its tile first (its geometry is kept, nothing moves)
    and put back into the tile when its monitor becomes the active one again. (Hidden
    windows are left alone: nobody sees them, and KWin re-tiles them when shown again.)

    KWin also remembers a tile per desktop, and gives a window on all desktops the tile it
    has on the new current desktop whenever the desktop changes. A frozen window must not
    move, so such a tile is dropped right away and the window put back where it was frozen.

    Run the "Per-monitor desktops: restore normal behavior" shortcut (or the
    permonitordesktops-off helper) before disabling the script.

    SPDX-License-Identifier: GPL-2.0-or-later
*/

"use strict";

const DEBUG = false;
const POLL_MS = 100;
const SETTLE_MS = 800;           // longer than KWin's slide animation at normal speed
const MINIMIZE_MS = 400;         // longer than KWin's minimize animation at normal speed
const HOLD_MS = 50;

const shownDesktop = new Map();  // output name -> VirtualDesktop shown on that monitor
const logical = new Map();       // window -> VirtualDesktop it belongs to
const pinned = new Set();        // windows the user put on all desktops
const hiddenByUs = new Set();    // windows this script minimized to hide them
const watchedDesktops = new Set();
const detachedTiles = new Map(); // frozen window -> the tile it was detached from
const frozenAt = new Map();      // visible window on another monitor -> geometry it is frozen at
const transparent = new Map();   // window -> [opacity to restore, time it was made transparent]

let host = null;                 // output name that owns the real desktop switching
let lastCursorOutput = null;
let enabled = true;
let busy = 0;                    // > 0 while we change windows ourselves
let settling = null;             // new host still frozen while the desktop switch slides
let lastSwitch = 0;              // when the current desktop last changed
let lastDesktop = null;          // the current desktop as of that change

const poll = new QTimer();       // follows the cursor between monitors
poll.interval = POLL_MS;

const settle = new QTimer();     // ends `settling` once the slide is over
settle.singleShot = true;
settle.interval = SETTLE_MS;

const opaque = new QTimer();     // gives `transparent` windows their opacity back
opaque.interval = MINIMIZE_MS;

const hold = new QTimer();       // holds frozen windows again once KWin's own geometry changes landed
hold.singleShot = true;
hold.interval = HOLD_MS;

function log(...args) {
    if (DEBUG) {
        console.info("permonitordesktops: " + args.join(" "));
    }
}

function guarded(fn) {
    busy++;
    try {
        fn();
    } finally {
        busy--;
    }
}

function outputName(output) {
    return output ? output.name : null;
}

function isManaged(window) {
    return window.normalWindow;
}

// KWin plays the minimize animation even for a window on another desktop, so every
// (un)minimize done by this script happens while the window is fully transparent.
function setMinimized(window, minimized) {
    if (!transparent.has(window)) {
        transparent.set(window, [window.opacity, 0]);
        window.opacity = 0;
    }
    transparent.get(window)[1] = Date.now();
    window.minimized = minimized;
    if (!opaque.active) {
        opaque.start();
    }
}

function restoreOpacity(all) {
    const now = Date.now();
    transparent.forEach(([opacity, since], window) => {
        if (all || now - since >= MINIMIZE_MS) {
            window.opacity = opacity;
            transparent.delete(window);
        }
    });
    if (transparent.size === 0) {
        opaque.stop();
    }
}

function detachTile(window) {
    if (window.tile && !detachedTiles.has(window)) {
        // Dropping the tile can send the window back to its floating geometry (seen with
        // custom tiles), so put it right back where it is before anything is painted.
        const geometry = window.frameGeometry;
        detachedTiles.set(window, window.tile);
        window.tile = null;
        window.frameGeometry = geometry;
        log("detached tile of", window.caption);
    }
}

function rectText(rect) {
    return rect ? Math.round(rect.x) + "," + Math.round(rect.y) + " " + Math.round(rect.width) + "x" + Math.round(rect.height) : "-";
}

function sameRect(a, b) {
    return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1
        && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
}

function freeze(window) {
    if (!frozenAt.has(window)) {
        const g = window.frameGeometry;
        frozenAt.set(window, {x: g.x, y: g.y, width: g.width, height: g.height});
    }
}

// Undo whatever tile KWin gave a frozen window (see the top of this file).
function holdFrozen(window) {
    const geometry = frozenAt.get(window);
    if (!enabled || !geometry || (!window.tile && sameRect(window.frameGeometry, geometry))) {
        return;
    }
    log("hold frozen", window.caption, rectText(window.frameGeometry), "->", rectText(geometry), "tile", !!window.tile);
    guarded(() => {
        if (window.tile) {
            window.tile = null;
        }
        window.frameGeometry = geometry;
    });
}

// A tile belongs to one desktop and can only be used while that desktop is the current one.
function reattachTile(window) {
    const tile = detachedTiles.get(window);
    if (!tile) {
        return;
    }
    if (window.tile) {
        detachedTiles.delete(window);
        return;
    }
    if (window.onAllDesktops || logical.get(window) !== workspace.currentDesktop) {
        log("re-tile later", window.caption, "all", window.onAllDesktops,
            "logical", logical.get(window) ? logical.get(window).name : "-", "current", workspace.currentDesktop.name);
        return;
    }
    detachedTiles.delete(window);
    try {
        window.tile = tile;
        log("re-tiled", window.caption, "->", !!window.tile);
    } catch (error) {
        log("could not re-tile", window.caption, error);
    }
}

function reattachTiles() {
    if (!enabled) {
        return;
    }
    guarded(() => {
        detachedTiles.forEach((tile, window) => {
            if (outputName(window.output) === host) {
                reattachTile(window);
            }
        });
    });
}

function desktopExists(desktop) {
    return workspace.desktops.indexOf(desktop) !== -1;
}

function shown(name) {
    let desktop = shownDesktop.get(name);
    if (!desktop || !desktopExists(desktop)) {
        desktop = workspace.currentDesktop;
        shownDesktop.set(name, desktop);
    }
    return desktop;
}

function windowsOn(name) {
    return workspace.windowList().filter(w =>
        isManaged(w) && !pinned.has(w) && outputName(w.output) === name);
}

// Put a window into the state that matches what its monitor currently shows.
function place(window) {
    if (!enabled || !isManaged(window) || pinned.has(window)) {
        return;
    }
    const name = outputName(window.output);
    const want = logical.get(window);
    if (!name || !want) {
        return;
    }
    if (window.minimized && !hiddenByUs.has(window)) {
        return;  // minimized by the user, leave it alone
    }

    // While a new host settles, the windows of the desktop it shows stay frozen (they would
    // slide along) and hidden windows stay hidden (they could show up in the slide).
    const native = name === host
        && (name !== settling || (want !== shown(name) && !hiddenByUs.has(window)));

    guarded(() => {
        if (native) {
            // Host monitor: ordinary KWin desktops.
            frozenAt.delete(window);
            if (hiddenByUs.has(window)) {
                hiddenByUs.delete(window);
                window.desktops = [want];     // still minimized, so nothing flashes
                setMinimized(window, false);
            } else if (window.onAllDesktops || window.desktops.length !== 1 || window.desktops[0] !== want) {
                window.desktops = [want];
            }
            reattachTile(window);
        } else if (want === shown(name)) {
            // Other monitor, window belongs to the desktop shown there: always visible.
            if (hiddenByUs.has(window)) {
                hiddenByUs.delete(window);
                setMinimized(window, false);
            }
            // Taken before the tile is dropped: some windows (seen with Konsole) go back to
            // their floating geometry anyway and ignore detachTile() putting them back.
            freeze(window);
            if (!window.onAllDesktops) {
                detachTile(window);
                window.onAllDesktops = true;
            }
            holdFrozen(window);
            if (!hold.active) {
                hold.start();
            }
        } else if (!hiddenByUs.has(window)) {
            // Other monitor, window belongs to another desktop: hide it, and take it out of
            // desktop switching so it stays hidden whatever the host monitor shows.
            frozenAt.delete(window);
            if (window.minimizable) {
                setMinimized(window, true);
                hiddenByUs.add(window);
                window.onAllDesktops = true;
            }
        }
    });
    log("place", window.caption, "->", native ? "host" : "other", want.name);
}

function setHost(name) {
    if (!enabled || !name || name === host) {
        return;
    }
    const previous = host;
    host = name;
    log("host ->", name);
    guarded(() => {
        if (previous) {
            windowsOn(previous).forEach(place);       // freeze the monitor we leave
        }
        const target = shown(name);
        settling = null;
        if (workspace.currentDesktop !== target || Date.now() - lastSwitch < SETTLE_MS) {
            // Nothing native is on screen, but KWin still plays its slide animation (ours, or
            // one that is still running), and windows joining the native desktop while it
            // runs would slide along. So the new host stays frozen until the slide is over.
            settling = name;
            if (workspace.currentDesktop !== target) {
                workspace.currentDesktop = target;
            }
            settle.start();
        }
        windowsOn(name).forEach(place);               // hand the new host over to KWin
    });
}

function settled() {
    if (!enabled || !settling) {
        return;
    }
    settling = null;
    guarded(() => windowsOn(host).forEach(place));
}

function reconcile() {
    workspace.windowList().forEach(place);
}

function adopt(window) {
    window.tileChanged.connect(() => holdFrozen(window));
    window.interactiveMoveResizeFinished.connect(() => {
        if (frozenAt.has(window)) {
            frozenAt.delete(window);  // moved by the user: freeze it where it was dropped
            freeze(window);
        }
    });
    if (DEBUG) {
        window.frameGeometryChanged.connect(old => log("geometry", window.caption, rectText(old), "->",
            rectText(window.frameGeometry), "tile", !!window.tile, "all", window.onAllDesktops, "busy", busy));
    }
    window.desktopsChanged.connect(() => onDesktopsChanged(window));
    window.outputChanged.connect(() => onOutputChanged(window));
    window.minimizedChanged.connect(() => onMinimizedChanged(window));
    if (!isManaged(window)) {
        return;
    }
    if (window.onAllDesktops) {
        pinned.add(window);
    } else if (window.desktops.length > 0) {
        logical.set(window, window.desktops[0]);
        place(window);
    }
}

function onDesktopsChanged(window) {
    if (busy || !enabled || !isManaged(window)) {
        return;
    }
    // Anything that is not our own doing is the user's (or another script's) intent.
    if (window.onAllDesktops) {
        if (!hiddenByUs.has(window)) {
            pinned.add(window);
        }
        return;
    }
    pinned.delete(window);
    hiddenByUs.delete(window);
    if (window.desktops.length > 0) {
        logical.set(window, window.desktops[0]);
    }
    place(window);
}

function onOutputChanged(window) {
    if (busy || !enabled || !isManaged(window) || pinned.has(window)) {
        return;
    }
    const name = outputName(window.output);
    if (!name) {
        return;
    }
    // A window dragged to another monitor joins whatever that monitor shows.
    logical.set(window, shown(name));
    place(window);
}

function onMinimizedChanged(window) {
    if (busy || !enabled || window.minimized || !hiddenByUs.has(window)) {
        return;
    }
    // A window we hid was restored (e.g. from the task manager): show its desktop on its monitor.
    hiddenByUs.delete(window);
    const name = outputName(window.output);
    shownDesktop.set(name, logical.get(window));
    if (name === host) {
        windowsOn(name).forEach(place);
    } else {
        setHost(name);
    }
}

function onDesktopGone(desktop) {
    const list = workspace.desktops;
    const index = list.indexOf(desktop);
    const replacement = list[index > 0 ? index - 1 : 1];
    if (!replacement) {
        return;
    }
    shownDesktop.forEach((value, name) => {
        if (value === desktop) {
            shownDesktop.set(name, replacement);
        }
    });
    logical.forEach((value, window) => {
        if (value === desktop) {
            logical.set(window, replacement);
        }
    });
}

function watchDesktops() {
    workspace.desktops.forEach(desktop => {
        if (!watchedDesktops.has(desktop)) {
            watchedDesktops.add(desktop);
            desktop.aboutToBeDestroyed.connect(() => {
                watchedDesktops.delete(desktop);
                onDesktopGone(desktop);
            });
        }
    });
}

function cursorOutput() {
    const output = workspace.screenAt(workspace.cursorPos);
    return output ? output.name : null;
}

function pollCursor() {
    if (!enabled || busy) {
        return;
    }
    const active = workspace.activeWindow;
    if (active && active.move) {
        return;  // follow the cursor once the drag is over
    }
    const name = cursorOutput();
    if (name && name !== lastCursorOutput) {
        lastCursorOutput = name;
        setHost(name);
    }
}

function restoreNormalBehavior() {
    enabled = false;
    poll.stop();
    settle.stop();
    hold.stop();
    settling = null;
    restoreOpacity(true);
    guarded(() => {
        workspace.windowList().forEach(window => {
            const want = logical.get(window);
            if (!isManaged(window) || pinned.has(window) || !want) {
                return;
            }
            window.desktops = [want];
            if (hiddenByUs.has(window)) {
                window.minimized = false;
            }
        });
        hiddenByUs.clear();
        frozenAt.clear();
        workspace.windowList().forEach(reattachTile);
        detachedTiles.clear();
    });
}

function main() {
    poll.timeout.connect(pollCursor);
    settle.timeout.connect(settled);
    opaque.timeout.connect(() => restoreOpacity(false));
    hold.timeout.connect(() => frozenAt.forEach((geometry, window) => holdFrozen(window)));
    workspace.screens.forEach(screen => shownDesktop.set(screen.name, workspace.currentDesktop));
    lastCursorOutput = cursorOutput();
    host = lastCursorOutput || outputName(workspace.activeScreen) || workspace.screens[0].name;

    watchDesktops();
    workspace.windowList().forEach(adopt);

    workspace.windowAdded.connect(window => {
        adopt(window);
        const name = outputName(window.output);
        if (isManaged(window) && name && !pinned.has(window)) {
            logical.set(window, shown(name));
            place(window);
        }
    });
    workspace.windowRemoved.connect(window => {
        logical.delete(window);
        pinned.delete(window);
        hiddenByUs.delete(window);
        detachedTiles.delete(window);
        frozenAt.delete(window);
        transparent.delete(window);
    });
    workspace.windowActivated.connect(window => {
        log("activated", window ? window.caption : "none", "busy", busy);
        if (busy || !enabled || !window || !isManaged(window) || pinned.has(window) || hiddenByUs.has(window)) {
            return;
        }
        setHost(outputName(window.output));
    });
    lastDesktop = workspace.currentDesktop;
    workspace.currentDesktopChanged.connect(() => {
        if (workspace.currentDesktop === lastDesktop) {
            return;  // KWin sometimes reports a change that did not change anything
        }
        lastDesktop = workspace.currentDesktop;
        lastSwitch = Date.now();
        if (!busy && enabled) {
            // The user switched desktops on the host while it was still settling: hand it to
            // KWin right away so its windows slide along.
            settling = null;
            shownDesktop.set(host, workspace.currentDesktop);
            windowsOn(host).forEach(place);
        }
        frozenAt.forEach((geometry, window) => holdFrozen(window));
        reattachTiles();
    });
    workspace.desktopsChanged.connect(() => {
        if (!busy && enabled) {
            watchDesktops();
            reconcile();
        }
    });
    workspace.screensChanged.connect(() => {
        const names = workspace.screens.map(screen => screen.name);
        names.forEach(name => {
            if (!shownDesktop.has(name)) {
                shownDesktop.set(name, workspace.currentDesktop);
            }
        });
        if (names.indexOf(host) === -1) {
            host = null;
            setHost(names[0]);
        }
    });

    registerShortcut("PerMonitorDesktopsRestore",
                     "Per-monitor desktops: restore normal behavior",
                     "", restoreNormalBehavior);

    poll.start();
}

main();
