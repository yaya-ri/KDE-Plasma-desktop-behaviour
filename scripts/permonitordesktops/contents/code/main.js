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

    Run the "Per-monitor desktops: restore normal behavior" shortcut (or the
    permonitordesktops-off helper) before disabling the script.

    SPDX-License-Identifier: GPL-2.0-or-later
*/

"use strict";

const DEBUG = false;
const POLL_MS = 100;
const SETTLE_MS = 800;           // longer than KWin's slide and minimize animations at normal speed
const MINIMIZE_MS = 400;         // longer than KWin's minimize animation at normal speed

const shownDesktop = new Map();  // output name -> VirtualDesktop shown on that monitor
const logical = new Map();       // window -> VirtualDesktop it belongs to
const pinned = new Set();        // windows the user put on all desktops
const hiddenByUs = new Set();    // windows this script minimized to hide them
const watchedDesktops = new Set();
const detachedTiles = new Map(); // frozen window -> the tile it was detached from
const pendingDetach = new Set(); // hidden windows not yet put on all desktops

let host = null;                 // output name that owns the real desktop switching
let lastCursorOutput = null;
let enabled = true;
let busy = 0;                    // > 0 while we change windows ourselves
let settling = null;             // new host still frozen while the desktop switch slides

const poll = new QTimer();       // follows the cursor between monitors
poll.interval = POLL_MS;

const settle = new QTimer();     // ends `settling` once the slide is over
settle.singleShot = true;
settle.interval = SETTLE_MS;

const switchLater = new QTimer(); // switches to the settling host's desktop once minimizing is over
switchLater.singleShot = true;
switchLater.interval = MINIMIZE_MS;

const detach = new QTimer();     // handles `pendingDetach` once the minimize animation is over
detach.singleShot = true;
detach.interval = SETTLE_MS;

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
            if (hiddenByUs.has(window)) {
                hiddenByUs.delete(window);
                window.desktops = [want];     // still minimized, so nothing flashes
                window.minimized = false;
            } else if (window.onAllDesktops || window.desktops.length !== 1 || window.desktops[0] !== want) {
                window.desktops = [want];
            }
            reattachTile(window);
        } else if (want === shown(name)) {
            // Other monitor, window belongs to the desktop shown there: always visible.
            if (hiddenByUs.has(window)) {
                hiddenByUs.delete(window);
                window.minimized = false;
            }
            if (!window.onAllDesktops) {
                detachTile(window);
                window.onAllDesktops = true;
            }
        } else if (!hiddenByUs.has(window)) {
            // Other monitor, window belongs to another desktop: hide it.
            // Minimize it while it is still invisible on its own desktop, and detach it from
            // desktop switching only once the minimize animation is over: a window on all
            // desktops is painted, animation included.
            if (window.minimizable) {
                window.minimized = true;
                hiddenByUs.add(window);
                if (!window.onAllDesktops) {
                    pendingDetach.add(window);
                    detach.start();
                }
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
        switchLater.stop();
        if (workspace.currentDesktop !== target) {
            // Nothing native is on screen, but KWin still plays its slide animation, and
            // windows joining the native desktop while it runs would slide along. So the
            // new host stays frozen until the slide is over.
            settling = name;
            if (minimizingOn(target)) {
                switchLater.start();                  // or their animation shows up on it
            } else {
                switchDesktop();
            }
        }
        windowsOn(name).forEach(place);               // hand the new host over to KWin
    });
}

// Windows we just started to minimize on their own desktop: invisible until it becomes current.
function minimizingOn(desktop) {
    return Array.from(pendingDetach).some(w => w.minimized && w.desktops.indexOf(desktop) !== -1);
}

function switchDesktop() {
    if (!enabled || settling !== host) {
        return;
    }
    guarded(() => {
        workspace.currentDesktop = shown(host);
    });
    settle.start();
}

function settled() {
    if (!enabled || !settling) {
        return;
    }
    settling = null;
    guarded(() => windowsOn(host).forEach(place));
}

function detachHidden() {
    if (!enabled) {
        return;
    }
    guarded(() => {
        pendingDetach.forEach(window => {
            if (hiddenByUs.has(window) && window.minimized) {
                window.onAllDesktops = true;
            }
        });
    });
    pendingDetach.clear();
}

function reconcile() {
    workspace.windowList().forEach(place);
}

function adopt(window) {
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
    switchLater.stop();
    settling = null;
    detach.stop();
    pendingDetach.clear();
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
        workspace.windowList().forEach(reattachTile);
        detachedTiles.clear();
    });
}

function main() {
    poll.timeout.connect(pollCursor);
    settle.timeout.connect(settled);
    switchLater.timeout.connect(switchDesktop);
    detach.timeout.connect(detachHidden);
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
        pendingDetach.delete(window);
    });
    workspace.windowActivated.connect(window => {
        log("activated", window ? window.caption : "none", "busy", busy);
        if (busy || !enabled || !window || !isManaged(window) || pinned.has(window) || hiddenByUs.has(window)) {
            return;
        }
        setHost(outputName(window.output));
    });
    workspace.currentDesktopChanged.connect(() => {
        if (!busy && enabled) {
            // The user switched desktops on the host while it was still settling: hand it to
            // KWin right away so its windows slide along.
            switchLater.stop();
            settling = null;
            shownDesktop.set(host, workspace.currentDesktop);
            windowsOn(host).forEach(place);
        }
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
