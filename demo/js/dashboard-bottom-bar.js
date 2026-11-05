/**
 * Routario - Mobile Bottom Bar & Resizable Sheet Controller
 * Converts the sidebar into a bottom bar on mobile viewports with sufficient height.
 * Enables resizing via dragging the top handle freely without content-height restrictions.
 * Clicking/tapping the handle toggles the sheet size (expanded vs compact peek).
 * Height is maintained consistently across tab switches and data updates.
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

    const MIN_HEIGHT = 80; // Minimum peek height (drag handle + header/search accessible)
    const MOBILE_MAX_WIDTH = 768;
    const MIN_REQUIRED_HEIGHT = 500;

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

    function setBottomBarHeight(h) {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;
        const maxViewport = getMaxViewportHeight();
        const clamped = Math.max(MIN_HEIGHT, Math.min(h, maxViewport));
        _currentHeight = clamped;
        if (clamped > MIN_HEIGHT + 40) {
            _lastExpandedHeight = clamped;
        }
        sidebar.style.setProperty('--bottom-bar-height', `${clamped}px`);
    }

    function updateBottomBarMaxHeight() {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar || !isBottomBarActive()) return;

        const maxViewport = getMaxViewportHeight();
        sidebar.style.setProperty('--bottom-bar-max-height', `${maxViewport}px`);

        // If the viewport shrank smaller than current height, clamp it down
        if (_currentHeight !== null && _currentHeight > maxViewport) {
            _currentHeight = maxViewport;
            sidebar.style.setProperty('--bottom-bar-height', `${maxViewport}px`);
        } else if (_currentHeight === null) {
            // Initial default height
            const defaultH = Math.min(maxViewport, Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.42)));
            _currentHeight = defaultH;
            _lastExpandedHeight = defaultH;
            sidebar.style.setProperty('--bottom-bar-height', `${defaultH}px`);
        }
        // Note: Does NOT modify _currentHeight on tab switches or data updates.
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
            setBottomBarHeight(MIN_HEIGHT);
        } else {
            const restoreH = _lastExpandedHeight || Math.min(maxViewport, Math.round(window.innerHeight * 0.45));
            setBottomBarHeight(Math.max(restoreH, MIN_HEIGHT + 80));
        }

        if (typeof map !== 'undefined' && map && typeof map.invalidateSize === 'function') {
            setTimeout(() => map.invalidateSize(), 240);
        }
    }

    function initDragListeners() {
        const sidebar = document.querySelector('.sidebar');
        const handle = document.getElementById('sidebarDragHandle');
        if (!sidebar || !handle) return;

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
                setBottomBarHeight(targetHeight);
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            updateBottomBarMode();
            initDragListeners();
        });
    } else {
        updateBottomBarMode();
        initDragListeners();
    }
})();
