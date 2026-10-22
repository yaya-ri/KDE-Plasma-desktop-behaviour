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
    as the current desktop changes. To keep visible frozen windows exactly where they are,
    their geometry is remembered and put back right when that happens. (Hidden windows
    are left alone: nobody sees them, and KWin re-tiles them when they are shown again.)

    Run the "Per-monitor desktops: restore normal behavior" shortcut (or the
    permonitordesktops-off helper) before disabling the script.

    SPDX-License-Identifier: GPL-2.0-or-later
*/

"use strict";

const DEBUG = false;
const POLL_MS = 100;

const shownDesktop = new Map();  // output name -> VirtualDesktop shown on that monitor
const logical = new Map();       // window -> VirtualDesktop it belongs to
const pinned = new Set();        // windows the user put on all desktops
const hiddenByUs = new Set();    // windows this script minimized to hide them
const watchedDesktops = new Set();
const anchors = new Map();       // frozen window -> { geometry, tiled }

let host = null;                 // output name that owns the real desktop switching
let lastCursorOutput = null;
let enabled = true;
let busy = 0;                    // > 0 while we change windows ourselves

const poll = new QTimer();       // follows the cursor between monitors
poll.interval = POLL_MS;

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

function rectOf(geometry) {
    return { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
}

// Remember where a visible window sits before it is taken out of KWin's desktop switching.
function freeze(window) {
    if (!anchors.has(window)) {
        anchors.set(window, { geometry: rectOf(window.frameGeometry), tiled: !!window.tile });
    }
}

// KWin un-tiles frozen windows when the current desktop changes (their tile belongs to
// one desktop) and would move them to their old floating geometry a frame later.
function restoreFrozenGeometry() {
    if (!enabled) {
        return;
    }
    anchors.forEach((anchor, window) => {
        if (anchor.tiled && !window.tile) {
            window.frameGeometry = anchor.geometry;
        }
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

    guarded(() => {
        if (name === host) {
            // Host monitor: ordinary KWin desktops.
            anchors.delete(window);
            if (hiddenByUs.has(window)) {
                hiddenByUs.delete(window);
                window.desktops = [want];     // still minimized, so nothing flashes
                window.minimized = false;
            } else if (window.onAllDesktops || window.desktops.length !== 1 || window.desktops[0] !== want) {
                window.desktops = [want];
            }
        } else if (want === shown(name)) {
            // Other monitor, window belongs to the desktop shown there: always visible.
            if (hiddenByUs.has(window)) {
                hiddenByUs.delete(window);
                window.minimized = false;
            }
            if (!window.onAllDesktops) {
                freeze(window);
                window.onAllDesktops = true;
            }
        } else if (!hiddenByUs.has(window)) {
            // Other monitor, window belongs to another desktop: hide it.
            // Minimize first while it is still invisible on its own desktop, only then
            // detach it from desktop switching, so no animation or flash shows up.
            if (window.minimizable) {
                anchors.delete(window);  // invisible: KWin may un-tile it, it is re-tiled when shown again
                window.minimized = true;
                hiddenByUs.add(window);
                window.onAllDesktops = true;
            }
        }
    });
    log("place", window.caption, "->", name === host ? "host" : "other", want.name);
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
        if (workspace.currentDesktop !== target) {
            workspace.currentDesktop = target;        // nothing native on screen: no visible slide
        }
        windowsOn(name).forEach(place);               // hand the new host over to KWin
    });
}

function reconcile() {
    workspace.windowList().forEach(place);
}

function adopt(window) {
    window.desktopsChanged.connect(() => onDesktopsChanged(window));
    window.outputChanged.connect(() => onOutputChanged(window));
    window.minimizedChanged.connect(() => onMinimizedChanged(window));
    window.frameGeometryChanged.connect(() => onGeometryChanged(window));
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

// A frozen window that changes on its own (not by our restore) keeps its new place.
function onGeometryChanged(window) {
    const anchor = anchors.get(window);
    if (anchor && !busy && !window.move && !window.resize) {
        anchor.geometry = rectOf(window.frameGeometry);
        anchor.tiled = !!window.tile;
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
        anchors.clear();
    });
}

function main() {
    poll.timeout.connect(pollCursor);
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
        anchors.delete(window);
    });
    workspace.windowActivated.connect(window => {
        if (busy || !enabled || !window || !isManaged(window) || pinned.has(window) || hiddenByUs.has(window)) {
            return;
        }
        setHost(outputName(window.output));
    });
    workspace.currentDesktopChanged.connect(() => {
        guarded(restoreFrozenGeometry);
        if (!busy && enabled) {
            shownDesktop.set(host, workspace.currentDesktop);
        }
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
