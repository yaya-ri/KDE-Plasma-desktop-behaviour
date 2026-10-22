/*
    Maximize to New Desktop: a window that gets maximized (or fullscreen) moves
    to a new virtual desktop right next to its own, and the view slides there
    (enable the "Slide" desktop switching effect for the animation).
    Restoring the window moves it back, slides back and removes the new desktop.

    SPDX-License-Identifier: GPL-2.0-or-later
*/

"use strict";

const TRIGGER_MAXIMIZE = 0;
const TRIGGER_FULLSCREEN = 1;
const MAXIMIZE_FULL = 3;
const STARTUP_GRACE_MS = 1500;  // ignore state restored together with the window
const REMOVE_DELAY_MS = 700;    // let the slide animation finish before removing

const spaces = new Map();       // window -> { origin, created }
const addedAt = new Map();      // window -> timestamp

function wantsOwnDesktop(window) {
    const trigger = readConfig("Trigger", TRIGGER_MAXIMIZE);
    const maximized = window.maximizeMode === MAXIMIZE_FULL;
    return ((trigger !== TRIGGER_FULLSCREEN) && maximized)
        || ((trigger !== TRIGGER_MAXIMIZE) && window.fullScreen);
}

function eligible(window) {
    return window.normalWindow && !window.onAllDesktops && window.desktops.length === 1;
}

function desktopExists(desktop) {
    return workspace.desktops.indexOf(desktop) !== -1;
}

function desktopIsEmpty(desktop) {
    return !workspace.windowList().some(w => w.desktops.indexOf(desktop) !== -1);
}

function removeIfEmpty(desktop) {
    if (desktopExists(desktop) && desktopIsEmpty(desktop) && workspace.desktops.length > 1) {
        workspace.removeDesktop(desktop);
    }
}

const pendingTimers = new Set();  // keep timers referenced until they fire

function removeLater(desktop) {
    const timer = new QTimer();
    timer.singleShot = true;
    timer.interval = REMOVE_DELAY_MS;
    timer.timeout.connect(() => {
        pendingTimers.delete(timer);
        removeIfEmpty(desktop);
    });
    pendingTimers.add(timer);
    timer.start();
}

function enter(window) {
    const origin = window.desktops[0];
    const index = workspace.desktops.indexOf(origin);
    if (index === -1) {
        return;
    }
    workspace.createDesktop(index + 1, window.caption.substring(0, 32));
    const created = workspace.desktops[index + 1];
    if (!created) {
        return;
    }
    spaces.set(window, { origin: origin, created: created });
    window.desktops = [created];
    workspace.currentDesktop = created;
    workspace.activeWindow = window;
}

function leave(window) {
    const space = spaces.get(window);
    spaces.delete(window);
    if (desktopExists(space.origin)) {
        window.desktops = [space.origin];
        // Only pull the view back if the user is still looking at the window's desktop.
        if (workspace.currentDesktop === space.created) {
            workspace.currentDesktop = space.origin;
            workspace.activeWindow = window;
        }
    }
    removeLater(space.created);
}

function onStateChanged(window) {
    const space = spaces.get(window);
    const want = wantsOwnDesktop(window);
    if (want && !space) {
        if (eligible(window) && Date.now() - (addedAt.get(window) || 0) > STARTUP_GRACE_MS) {
            enter(window);
        }
    } else if (!want && space) {
        leave(window);
    }
}

// The user moved the window elsewhere by hand: forget about it, tidy up.
function onDesktopsChanged(window) {
    const space = spaces.get(window);
    if (space && !(window.desktops.length === 1 && window.desktops[0] === space.created)) {
        spaces.delete(window);
        removeLater(space.created);
    }
}

function manage(window) {
    addedAt.set(window, Date.now());
    window.maximizedChanged.connect(() => onStateChanged(window));
    window.fullScreenChanged.connect(() => onStateChanged(window));
    window.desktopsChanged.connect(() => onDesktopsChanged(window));
}

function onWindowRemoved(window) {
    addedAt.delete(window);
    const space = spaces.get(window);
    if (!space) {
        return;
    }
    spaces.delete(window);
    if (workspace.currentDesktop === space.created && desktopExists(space.origin)) {
        workspace.currentDesktop = space.origin;
    }
    removeLater(space.created);
}

workspace.windowAdded.connect(manage);
workspace.windowRemoved.connect(onWindowRemoved);
workspace.windowList().forEach(w => {
    manage(w);
    addedAt.set(w, 0);
});
