/**
 * Routario - Mobile Bottom Bar & Resizable Sheet Controller
 * Converts the sidebar into a bottom bar on mobile viewports with sufficient height.
 * Enables resizing via dragging the top handle freely without content-height restrictions.
 * Clicking/tapping the handle toggles the sheet size (expanded vs compact peek).
 * Remembers user position across sessions via localStorage.
 * Height is maintained consistently across tab switches, orientation changes, and data updates.
 */

(function () {
    let _isDragging = false;
    let _startY = 0;
    let _startHeight = 0;
    let _currentHeight = null;
    let _lastExpandedHeight = null;
    let _rafId = null;
    let _movedDistance = 0;
    let _lastToggleTime = 0;
    let _dragListenersInitialized = false;

    const MIN_HEIGHT = 80; // Minimum peek height (drag handle + header/search accessible)
    const MOBILE_MAX_WIDTH = 768;
    const MIN_REQUIRED_HEIGHT = 500;

    const STORAGE_KEY_HEIGHT = 'routario_bottom_bar_height';
    const STORAGE_KEY_EXPANDED_HEIGHT = 'routario_bottom_bar_expanded_height';

    function getSavedHeight() {
        try {
            const val = localStorage.getItem(STORAGE_KEY_HEIGHT);
            if (val !== null) {
                const num = parseFloat(val);
                if (!isNaN(num) && num >= MIN_HEIGHT) {
                    return num;
                }
            }
        } catch (_) {}
        return null;
    }

    function getSavedExpandedHeight() {
        try {
            const val = localStorage.getItem(STORAGE_KEY_EXPANDED_HEIGHT);
            if (val !== null) {
                const num = parseFloat(val);
                if (!isNaN(num) && num > MIN_HEIGHT + 40) {
                    return num;
                }
            }
        } catch (_) {}
        return null;
    }

    function saveBottomBarState() {
        try {
            if (_currentHeight !== null) {
                localStorage.setItem(STORAGE_KEY_HEIGHT, String(Math.round(_currentHeight)));
            }
            if (_lastExpandedHeight !== null) {
                localStorage.setItem(STORAGE_KEY_EXPANDED_HEIGHT, String(Math.round(_lastExpandedHeight)));
            }
        } catch (_) {}
    }

    function shouldEnableBottomBar() {
        return window.innerWidth <= MOBILE_MAX_WIDTH && window.innerHeight >= MIN_REQUIRED_HEIGHT;
    }

    function isBottomBarActive() {
        const dashboard = document.querySelector('.dashboard');
        return Boolean(dashboard && dashboard.classList.contains('sidebar-bottom-mode'));
    }

    function getMaxViewportHeight() {
        // Allows dragging up freely while leaving room for the top header bar
        return Math.max(MIN_HEIGHT, Math.min(window.innerHeight - 60, Math.round(window.innerHeight * 0.88)));
    }

    function syncHistoryControlsPlacement() {
        const controls = document.getElementById('historyControls');
        const defaultSlot = document.getElementById('historyControlsDefaultSlot');
        const mergedSlot = document.getElementById('historyControlsMergedSlot');
        if (!controls || !defaultSlot || !mergedSlot) return;

        if (isBottomBarActive()) {
            if (controls.parentElement !== mergedSlot) {
                mergedSlot.appendChild(controls);
            }
        } else {
            if (controls.parentElement !== defaultSlot) {
                defaultSlot.appendChild(controls);
            }
        }
    }

    function setBottomBarHeight(h, shouldSave = true) {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;
        const maxViewport = getMaxViewportHeight();
        const clamped = Math.max(MIN_HEIGHT, Math.min(h, maxViewport));
        _currentHeight = clamped;
        if (clamped > MIN_HEIGHT + 40) {
            _lastExpandedHeight = clamped;
        }
        sidebar.style.setProperty('--bottom-bar-height', `${clamped}px`);
        if (shouldSave) {
            saveBottomBarState();
        }
    }

    function updateBottomBarMaxHeight() {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar || !isBottomBarActive()) return;

        const maxViewport = getMaxViewportHeight();
        sidebar.style.setProperty('--bottom-bar-max-height', `${maxViewport}px`);

        if (_currentHeight === null) {
            const savedH = getSavedHeight();
            const savedExpH = getSavedExpandedHeight();
            const defaultH = Math.min(maxViewport, Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.42)));

            _lastExpandedHeight = savedExpH !== null ? Math.min(maxViewport, Math.max(MIN_HEIGHT + 40, savedExpH)) : defaultH;
            const initialH = savedH !== null ? Math.max(MIN_HEIGHT, Math.min(savedH, maxViewport)) : defaultH;
            _currentHeight = initialH;
            sidebar.style.setProperty('--bottom-bar-height', `${initialH}px`);
        } else {
            // Viewport might have changed or window resized; clamp if needed and ensure property is set
            if (_currentHeight > maxViewport) {
                _currentHeight = maxViewport;
                saveBottomBarState();
            } else if (_currentHeight < MIN_HEIGHT) {
                _currentHeight = MIN_HEIGHT;
            }
            sidebar.style.setProperty('--bottom-bar-height', `${_currentHeight}px`);
        }
    }

    function updateBottomBarMode() {
        const dashboard = document.querySelector('.dashboard');
        const sidebar = document.querySelector('.sidebar');
        if (!dashboard || !sidebar) return;

        const enable = shouldEnableBottomBar();
        if (enable) {
            dashboard.classList.add('sidebar-bottom-mode');
            dashboard.classList.remove('sidebar-hidden');
            syncHistoryControlsPlacement();
            updateBottomBarMaxHeight();
        } else {
            dashboard.classList.remove('sidebar-bottom-mode');
            sidebar.style.removeProperty('--bottom-bar-height');
            sidebar.style.removeProperty('--bottom-bar-max-height');
            syncHistoryControlsPlacement();
        }

        if (typeof map !== 'undefined' && map && typeof map.invalidateSize === 'function') {
            setTimeout(() => map.invalidateSize(), 200);
        }
    }

    function toggleBottomBarCompact() {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar || !isBottomBarActive()) return;

        const now = Date.now();
        if (now - _lastToggleTime < 250) return;
        _lastToggleTime = now;

        const maxViewport = getMaxViewportHeight();
        if (_currentHeight && _currentHeight > MIN_HEIGHT + 35) {
            _lastExpandedHeight = _currentHeight;
            setBottomBarHeight(MIN_HEIGHT, true);
        } else {
            const restoreH = _lastExpandedHeight || Math.min(maxViewport, Math.round(window.innerHeight * 0.45));
            setBottomBarHeight(Math.max(restoreH, MIN_HEIGHT + 80), true);
        }

        if (typeof map !== 'undefined' && map && typeof map.invalidateSize === 'function') {
            setTimeout(() => map.invalidateSize(), 240);
        }
    }

    function initDragListeners() {
        if (_dragListenersInitialized) return;
        const sidebar = document.querySelector('.sidebar');
        const handle = document.getElementById('sidebarDragHandle');
        if (!sidebar || !handle) return;
        _dragListenersInitialized = true;

        function onPointerDown(e) {
            if (!isBottomBarActive()) return;
            if (e.button !== undefined && e.button !== 0) return;

            _isDragging = true;
            _startY = e.clientY;
            _startHeight = sidebar.offsetHeight;
            _movedDistance = 0;

            sidebar.classList.add('is-resizing');
            sidebar.style.transition = 'none';
            document.body.style.cursor = 'grabbing';
            document.body.style.userSelect = 'none';

            try {
                handle.setPointerCapture(e.pointerId);
            } catch (_) {}

            e.preventDefault();
        }

        function onPointerMove(e) {
            if (!_isDragging) return;

            const deltaY = _startY - e.clientY; // Dragging UP increases bottom sheet height
            _movedDistance = Math.max(_movedDistance, Math.abs(deltaY));
            const targetHeight = _startHeight + deltaY;

            if (_rafId) cancelAnimationFrame(_rafId);
            _rafId = requestAnimationFrame(() => {
                setBottomBarHeight(targetHeight, false);
            });
        }

        function onPointerUp(e) {
            if (!_isDragging) return;
            _isDragging = false;
            if (_rafId) {
                cancelAnimationFrame(_rafId);
                _rafId = null;
            }

            sidebar.classList.remove('is-resizing');
            sidebar.style.transition = '';
            document.body.style.cursor = '';
            document.body.style.userSelect = '';

            try {
                handle.releasePointerCapture(e.pointerId);
            } catch (_) {}

            // If user clicked or tapped without dragging (distance < 6px), toggle sheet size!
            if (_movedDistance < 6) {
                toggleBottomBarCompact();
            } else {
                saveBottomBarState();
                if (typeof map !== 'undefined' && map && typeof map.invalidateSize === 'function') {
                    map.invalidateSize();
                }
            }
        }

        handle.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointermove', onPointerMove, { passive: true });
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);

        // Click and keyboard accessibility (Enter/Space)
        handle.addEventListener('click', () => {
            if (!isBottomBarActive()) return;
            if (_movedDistance < 6) {
                toggleBottomBarCompact();
            }
        });
        handle.addEventListener('keydown', (e) => {
            if (!isBottomBarActive()) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleBottomBarCompact();
            }
        });
    }

    // Expose helpers globally
    window.isSidebarBottomBar = isBottomBarActive;
    window.shouldEnableBottomBar = shouldEnableBottomBar;
    window.updateBottomBarMode = updateBottomBarMode;
    window.updateBottomBarMaxHeight = updateBottomBarMaxHeight;
    window.setBottomBarHeight = setBottomBarHeight;
    window.toggleBottomBarCompact = toggleBottomBarCompact;
    window.syncHistoryControlsPlacement = syncHistoryControlsPlacement;

    window.addEventListener('resize', updateBottomBarMode);
    window.addEventListener('orientationchange', () => setTimeout(updateBottomBarMode, 100));

    // Initialize immediately if DOM is ready, or on DOMContentLoaded
    updateBottomBarMode();
    initDragListeners();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            updateBottomBarMode();
            initDragListeners();
        });
    }
})();
