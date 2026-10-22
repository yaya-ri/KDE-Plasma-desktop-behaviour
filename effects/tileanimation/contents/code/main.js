/*
    Tile Animation: animate windows when they are quick-tiled, snapped to a
    screen edge or restored, similar to macOS window tiling.

    Based on KWin's built-in "Stretch" (maximize) effect.

    SPDX-License-Identifier: GPL-2.0-or-later
*/

"use strict";

const EDGE_TOLERANCE = 80;  // px, covers tile padding and a panel on any edge
const MIN_DELTA = 4;        // px, ignore smaller geometry changes
const DESKTOP_EVENT_MS = 50; // a desktop change can announce a geometry change that never happens

class TileAnimationEffect {
    constructor() {
        effect.configChanged.connect(this.loadConfig.bind(this));
        effect.animationEnded.connect(this.restoreForceBlurState.bind(this));

        effects.windowAdded.connect(this.manage.bind(this));
        for (const window of effects.stackingOrder) {
            this.manage(window);
        }

        this.loadConfig();
    }

    loadConfig() {
        this.duration = animationTime(effect.readConfig("Duration", 300));
        this.crossFade = effect.readConfig("CrossFade", true);
        this.snappedOnly = effect.readConfig("SnappedOnly", true);
    }

    manage(window) {
        window.windowFrameGeometryAboutToChange.connect(this.onAboutToChange.bind(this));
        window.windowFrameGeometryChanged.connect(this.onGeometryChanged.bind(this));
        window.windowDesktopsChanged.connect(this.onDesktopsChanged.bind(this));
        // The built-in Stretch effect owns maximize/restore, stay out of its way.
        window.windowMaximizedStateAboutToChange.connect(w => { w.tileAnimSkip = true; });
        window.windowMaximizedStateChanged.connect(w => { w.tileAnimSkip = false; });
    }

    eligible(window) {
        return this.duration > 0
            && window.visible
            && window.normalWindow
            && !window.minimized
            && !window.fullScreen
            && !window.move
            && !window.resize
            && !window.tileAnimSkip;
    }

    isSnapped(rect, area) {
        const touching = [
            Math.abs(rect.x - area.x),
            Math.abs(rect.x + rect.width - (area.x + area.width)),
            Math.abs(rect.y - area.y),
            Math.abs(rect.y + rect.height - (area.y + area.height))
        ].filter(d => d <= EDGE_TOLERANCE).length;
        return touching >= 2;
    }

    // Where the window currently appears on screen if an earlier animation is still running.
    visualGeometry(window, fallback) {
        const a = window.tileAnim;
        if (a) {
            const p = (Date.now() - a.start) / this.duration;
            if (p < 1) {
                const e = 1 - Math.pow(1 - Math.max(p, 0), 3);  // OutCubic
                return {
                    x: a.from.x + (a.to.x - a.from.x) * e,
                    y: a.from.y + (a.to.y - a.from.y) * e,
                    width: a.from.width + (a.to.width - a.from.width) * e,
                    height: a.from.height + (a.to.height - a.from.height) * e
                };
            }
        }
        return fallback;
    }

    cancelFade(window) {
        if (window.tileFade) {
            cancel(window.tileFade);
            delete window.tileFade;
        }
    }

    // Moving a window between desktops (or putting it on all of them) makes KWin emit
    // frameGeometryAboutToChange although the geometry stays the same. A cross-fade started
    // for that would run for nothing and make the window stutter, so drop it.
    onDesktopsChanged(window) {
        window.tileDesktopsChangedAt = Date.now();
        if (window.tileFade && !window.tileFadeUsed) {
            this.cancelFade(window);
        }
    }

    onAboutToChange(window) {
        if (!this.eligible(window) || !this.crossFade
                || Date.now() - (window.tileDesktopsChangedAt || 0) < DESKTOP_EVENT_MS) {
            return;
        }
        this.cancelFade(window);
        window.tileFadeUsed = false;
        window.tileFade = animate({
            window: window,
            duration: this.duration,
            animations: [{
                type: Effect.CrossFadePrevious,
                to: 1.0,
                from: 0.0,
                curve: QEasingCurve.OutCubic
            }]
        });
    }

    onGeometryChanged(window, oldGeometry) {
        const newGeometry = window.geometry;
        const from = this.visualGeometry(window, oldGeometry);

        const unchanged = Math.abs(newGeometry.x - oldGeometry.x) < MIN_DELTA
            && Math.abs(newGeometry.y - oldGeometry.y) < MIN_DELTA
            && Math.abs(newGeometry.width - oldGeometry.width) < MIN_DELTA
            && Math.abs(newGeometry.height - oldGeometry.height) < MIN_DELTA;

        if (!this.eligible(window) || unchanged) {
            this.cancelFade(window);
            return;
        }

        if (this.snappedOnly) {
            const area = window.screen.geometry;
            if (!this.isSnapped(newGeometry, area) && !this.isSnapped(oldGeometry, area)) {
                this.cancelFade(window);
                return;
            }
        }

        if (window.tileSize) {
            cancel(window.tileSize);
        }

        window.setData(Effect.WindowForceBlurRole, true);
        window.tileAnim = {
            from: { x: from.x, y: from.y, width: from.width, height: from.height },
            to: { x: newGeometry.x, y: newGeometry.y, width: newGeometry.width, height: newGeometry.height },
            start: Date.now()
        };
        window.tileSize = animate({
            window: window,
            duration: this.duration,
            animations: [{
                type: Effect.Size,
                to: {
                    value1: newGeometry.width,
                    value2: newGeometry.height
                },
                from: {
                    value1: from.width,
                    value2: from.height
                },
                curve: QEasingCurve.OutCubic
            }, {
                type: Effect.Translation,
                to: {
                    value1: 0,
                    value2: 0
                },
                from: {
                    value1: from.x - newGeometry.x - (newGeometry.width / 2 - from.width / 2),
                    value2: from.y - newGeometry.y - (newGeometry.height / 2 - from.height / 2)
                },
                curve: QEasingCurve.OutCubic
            }]
        });

        // Make both animations end on the same frame so the forced blur is not dropped early.
        if (window.tileFade) {
            window.tileFadeUsed = true;
            retarget(window.tileFade, 1.0, this.duration);
        }
    }

    restoreForceBlurState(window) {
        window.setData(Effect.WindowForceBlurRole, null);
    }
}

new TileAnimationEffect();
