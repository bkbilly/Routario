/**
 * Routario - Sensor History Modal Controller
 * Provides tabular sensor history audit trail and quick shortcut to the full sensor graphs report.
 */
'use strict';

(function () {
    const state = {
        deviceId: null,
        sensorKey: null,
        sensorLabel: null,
        rangeHours: 24, // 24, 'today', 168 (7d), 720 (30d)
        onlyChanges: true, // Default to showing only value changes
        startTimeIso: null,
        endTimeIso: null,
        data: null,
        page: 1,
        pageSize: 50,
        abortController: null,
        pulseLayer: null,
    };

    function _stripHtml(html) {
        return String(html ?? '').replace(/<[^>]*>/g, '').trim();
    }

    function _formatDateTime(isoStr) {
        if (!isoStr) return '—';
        const d = new Date(isoStr.endsWith('Z') ? isoStr : isoStr + 'Z');
        if (isNaN(d.getTime())) return isoStr;
        const dateStr = typeof formatDateValue === 'function'
            ? formatDateValue(d)
            : d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
        const timeStr = typeof formatTimeValue === 'function'
            ? formatTimeValue(d, { withSeconds: true })
            : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return `<div style="line-height:1.2;">
            <div style="font-weight:600;color:var(--text-primary);">${dateStr}</div>
            <div style="font-size:0.75rem;color:var(--text-muted);font-family:JetBrains Mono,monospace;">${timeStr}</div>
        </div>`;
    }

    function _formatDuration(seconds, isOngoing = false) {
        if (seconds === null || seconds === undefined || isNaN(seconds)) return '<span style="color:var(--text-muted);">—</span>';
        const s = Math.round(seconds);
        let res = '';
        if (s < 60) {
            res = `${Math.max(1, s)}s`;
        } else if (s < 3600) {
            const m = Math.floor(s / 60);
            const remS = s % 60;
            res = remS > 0 ? `${m}m ${remS}s` : `${m}m`;
        } else if (s < 86400) {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            res = m > 0 ? `${h}h ${m}m` : `${h}h`;
        } else {
            const d = Math.floor(s / 86400);
            const h = Math.floor((s % 86400) / 3600);
            res = h > 0 ? `${d}d ${h}h` : `${d}d`;
        }
        if (isOngoing) {
            return `<span style="font-family:JetBrains Mono,monospace;font-size:0.8rem;font-weight:600;color:var(--text-primary);">${res}</span> <span style="font-size:0.7rem;color:var(--accent-primary);font-weight:600;">(ongoing)</span>`;
        }
        return `<span style="font-family:JetBrains Mono,monospace;font-size:0.8rem;color:var(--text-primary);">${res}</span>`;
    }

    function _formatSensorValue(val, unit, isNumeric) {
        if (val === null || val === undefined) return '<span style="color:var(--text-muted);">—</span>';
        if (typeof val === 'boolean') {
            const color = val ? '#10b981' : '#ef4444';
            const bg = val ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)';
            return `<span style="display:inline-block;padding:0.15rem 0.5rem;border-radius:4px;font-weight:700;font-size:0.75rem;color:${color};background:${bg};">${val ? 'ON' : 'OFF'}</span>`;
        }
        if (typeof val === 'number') {
            const formatted = isNumeric ? val.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(val);
            return `<span style="font-family:JetBrains Mono,monospace;font-weight:600;color:var(--text-primary);">${formatted}</span>${unit ? ` <span style="font-size:0.75rem;color:var(--text-muted);">${_esc(unit)}</span>` : ''}`;
        }
        if (typeof val === 'object') {
            return `<span style="font-family:JetBrains Mono,monospace;font-size:0.72rem;color:var(--text-muted);">${_esc(JSON.stringify(val))}</span>`;
        }
        return `<span style="font-family:JetBrains Mono,monospace;color:var(--text-primary);">${_esc(String(val))}</span>`;
    }

    function _formatDelta(delta, unit) {
        if (delta === null || delta === undefined) return '<span style="color:var(--text-muted);">—</span>';
        if (typeof delta === 'number') {
            if (delta > 0) {
                return `<span style="color:#10b981;font-weight:600;font-family:JetBrains Mono,monospace;font-size:0.78rem;">+${delta}${unit ? ' ' + _esc(unit) : ''}</span>`;
            } else if (delta < 0) {
                return `<span style="color:#ef4444;font-weight:600;font-family:JetBrains Mono,monospace;font-size:0.78rem;">${delta}${unit ? ' ' + _esc(unit) : ''}</span>`;
            }
            return `<span style="color:var(--text-muted);font-size:0.78rem;font-family:JetBrains Mono,monospace;">0</span>`;
        }
        if (delta === 'ON' || delta === 'OFF') {
            const color = delta === 'ON' ? '#10b981' : '#ef4444';
            return `<span style="color:${color};font-weight:600;font-size:0.75rem;">→ ${delta}</span>`;
        }
        return `<span style="color:var(--text-muted);font-size:0.75rem;">${_esc(String(delta))}</span>`;
    }

    async function loadSensorHistory() {
        if (!state.deviceId || !state.sensorKey) return;

        if (state.abortController) {
            state.abortController.abort();
            state.abortController = null;
        }
        state.abortController = new AbortController();

        const tableBody = document.getElementById('sensorHistoryTableBody');
        const statsBar = document.getElementById('sensorHistoryStatsBar');
        const timeRangeText = document.getElementById('sensorHistoryTimeRangeText');

        if (tableBody) {
            const cols = state.onlyChanges ? 5 : 4;
            tableBody.innerHTML = `<tr><td colspan="${cols}" style="text-align:center;padding:3rem 1rem;color:var(--text-muted);"><i class="mdi mdi-loading mdi-spin" style="font-size:1.5rem;display:block;margin-bottom:0.5rem;color:var(--accent-primary);"></i>Loading sensor history…</td></tr>`;
        }
        if (statsBar) {
            statsBar.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:0.75rem;color:var(--text-muted);font-size:0.8rem;"><i class="mdi mdi-loading mdi-spin"></i> Calculating statistics…</div>`;
        }

        const now = new Date();
        let start;
        if (state.rangeHours === 'today') {
            start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        } else {
            const hrs = Number(state.rangeHours) || 24;
            start = new Date(now.getTime() - hrs * 3600 * 1000);
        }

        state.startTimeIso = start.toISOString();
        state.endTimeIso = now.toISOString();

        if (timeRangeText) {
            const fmtStart = typeof formatDateValue === 'function' ? `${formatDateValue(start)} ${formatTimeValue(start, { withSeconds: false })}` : start.toLocaleString();
            const fmtEnd = typeof formatDateValue === 'function' ? `${formatDateValue(now)} ${formatTimeValue(now, { withSeconds: false })}` : now.toLocaleString();
            timeRangeText.textContent = `${fmtStart} — ${fmtEnd}`;
        }

        try {
            const params = new URLSearchParams({
                start_time: state.startTimeIso,
                end_time: state.endTimeIso,
                limit: '1000',
            });
            const url = `${API_BASE}/devices/${state.deviceId}/sensors/${encodeURIComponent(state.sensorKey)}/history?${params}`;
            const res = await apiFetch(url, { signal: state.abortController.signal });

            if (!res.ok) {
                const cols = state.onlyChanges ? 5 : 4;
                if (tableBody) tableBody.innerHTML = `<tr><td colspan="${cols}" style="text-align:center;padding:2rem;color:var(--danger-color);"><i class="mdi mdi-alert-circle"></i> Failed to load sensor history.</td></tr>`;
                if (statsBar) statsBar.innerHTML = '';
                return;
            }

            const data = await res.json();
            state.data = data;
            state.page = 1;

            _renderStats(data);
            _renderTable();
        } catch (err) {
            if (err.name === 'AbortError') return;
            console.error('Error loading sensor history:', err);
            const cols = state.onlyChanges ? 5 : 4;
            if (tableBody) tableBody.innerHTML = `<tr><td colspan="${cols}" style="text-align:center;padding:2rem;color:var(--danger-color);"><i class="mdi mdi-alert-circle"></i> An error occurred while loading sensor readings.</td></tr>`;
            if (statsBar) statsBar.innerHTML = '';
        }
    }

    function _renderStats(data) {
        const statsBar = document.getElementById('sensorHistoryStatsBar');
        if (!statsBar) return;

        const summary = data.summary || {};
        const unit = data.unit || '';
        const isNumeric = summary.is_numeric;

        function card(label, val, icon = 'mdi-chart-bar', extraStyle = '') {
            const plainVal = _stripHtml(val);
            const plainLabel = _stripHtml(label);
            const tooltip = `${plainLabel}: ${plainVal}`;
            return `
                <div class="sensor-stat-card" title="${_esc(tooltip)}" style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:8px;padding:0.6rem 0.85rem;display:flex;align-items:center;gap:0.75rem;cursor:default;transition:border-color 0.15s, background 0.15s;${extraStyle}">
                    <div style="width:34px;height:34px;border-radius:6px;background:rgba(99,102,241,0.12);color:var(--accent-primary);display:flex;align-items:center;justify-content:center;font-size:1.15rem;flex-shrink:0;">
                        <i class="mdi ${icon}"></i>
                    </div>
                    <div style="min-width:0;flex:1;">
                        <div title="${_esc(plainLabel)}" style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(label)}</div>
                        <div title="${_esc(plainVal)}" style="font-size:0.95rem;font-weight:700;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:JetBrains Mono,Outfit,sans-serif;">${val}</div>
                    </div>
                </div>`;
        }

        const cards = [];

        // Latest reading
        if (summary.latest !== null && summary.latest !== undefined) {
            cards.push(card('Current Value', _formatSensorValue(summary.latest, unit, isNumeric), 'mdi-gauge'));
        }

        if (isNumeric) {
            if (summary.min !== null) cards.push(card('Minimum', `${summary.min}${unit ? ' ' + unit : ''}`, 'mdi-arrow-down-bold'));
            if (summary.max !== null) cards.push(card('Maximum', `${summary.max}${unit ? ' ' + unit : ''}`, 'mdi-arrow-up-bold'));
            if (summary.avg !== null) cards.push(card('Average', `${summary.avg}${unit ? ' ' + unit : ''}`, 'mdi-calculator'));
        } else if (summary.on_count !== undefined && summary.off_count !== undefined && (summary.on_count > 0 || summary.off_count > 0)) {
            cards.push(card('Active (ON)', summary.on_count, 'mdi-power', 'border-left:3px solid #10b981;'));
            cards.push(card('Inactive (OFF)', summary.off_count, 'mdi-power-off', 'border-left:3px solid #ef4444;'));
            cards.push(card('State Changes', summary.changes_count || 0, 'mdi-swap-horizontal'));
        } else {
            cards.push(card('Value Changes', summary.changes_count || 0, 'mdi-swap-horizontal'));
        }

        cards.push(card('Total Points', summary.count || 0, 'mdi-database'));

        statsBar.innerHTML = cards.join('');
    }

    function _renderTable() {
        const thead = document.getElementById('sensorHistoryTableHead');
        const tableBody = document.getElementById('sensorHistoryTableBody');
        const countInfo = document.getElementById('sensorHistoryCountInfo');
        const pageInfo = document.getElementById('sensorHistPageInfo');
        const prevBtn = document.getElementById('sensorHistPrevBtn');
        const nextBtn = document.getElementById('sensorHistNextBtn');

        if (!tableBody || !state.data) return;

        // Render header with or without Duration column
        if (thead) {
            thead.innerHTML = `
                <tr>
                    <th style="white-space:nowrap; width:180px;"><i class="mdi mdi-clock-outline"></i> Date & Time</th>
                    <th style="white-space:nowrap;"><i class="mdi mdi-gauge"></i> Reading / Value</th>
                    <th style="white-space:nowrap; width:120px;"><i class="mdi mdi-delta"></i> Change</th>
                    ${state.onlyChanges ? '<th style="white-space:nowrap; width:130px;"><i class="mdi mdi-timer-outline"></i> Duration</th>' : ''}
                    <th style="white-space:nowrap; width:140px; text-align:right;"><i class="mdi mdi-map-marker-outline"></i> Coordinates</th>
                </tr>`;
        }

        const allReadings = state.data.readings || [];
        const unit = state.data.unit || '';
        const isNumeric = state.data.summary?.is_numeric;

        if (allReadings.length === 0) {
            const cols = state.onlyChanges ? 5 : 4;
            tableBody.innerHTML = `<tr><td colspan="${cols}" style="text-align:center;padding:3rem 1rem;color:var(--text-muted);"><i class="mdi mdi-information-outline" style="font-size:1.8rem;display:block;margin-bottom:0.5rem;opacity:0.6;"></i>No sensor readings found for the selected time range.</td></tr>`;
            if (countInfo) countInfo.textContent = '0 records found';
            if (pageInfo) pageInfo.textContent = '0 / 0';
            if (prevBtn) prevBtn.disabled = true;
            if (nextBtn) nextBtn.disabled = true;
            return;
        }

        // Filter for changes if onlyChanges is enabled
        let readings = allReadings;
        if (state.onlyChanges) {
            readings = allReadings.filter((r, idx) => {
                if (typeof r.delta === 'number') {
                    return r.delta !== 0;
                }
                if (r.delta !== null && r.delta !== undefined) {
                    return true;
                }
                // Keep the baseline (earliest) record if no changes or to establish baseline
                return idx === allReadings.length - 1;
            });

            // Calculate duration for each state change across the full filtered list
            for (let i = 0; i < readings.length; i++) {
                const tStart = new Date(readings[i].time).getTime();
                let tEnd;
                let isOngoing = false;
                if (i === 0) {
                    tEnd = Math.min(Date.now(), new Date(state.endTimeIso || Date.now()).getTime());
                    isOngoing = true;
                } else {
                    tEnd = new Date(readings[i - 1].time).getTime();
                }
                const sec = Math.max(0, (tEnd - tStart) / 1000);
                readings[i]._durationSec = sec;
                readings[i]._isOngoing = isOngoing;
            }
        }

        if (readings.length === 0) {
            const cols = state.onlyChanges ? 5 : 4;
            tableBody.innerHTML = `<tr><td colspan="${cols}" style="text-align:center;padding:3rem 1rem;color:var(--text-muted);"><i class="mdi mdi-check-circle-outline" style="font-size:1.8rem;display:block;margin-bottom:0.5rem;opacity:0.6;color:var(--accent-primary);"></i>No value changes detected in this time range. Uncheck "Only changes" above to view all periodic readings.</td></tr>`;
            if (countInfo) countInfo.textContent = `0 changes (${allReadings.length} constant readings)`;
            if (pageInfo) pageInfo.textContent = '0 / 0';
            if (prevBtn) prevBtn.disabled = true;
            if (nextBtn) nextBtn.disabled = true;
            return;
        }

        const totalPages = Math.ceil(readings.length / state.pageSize);
        state.page = Math.max(1, Math.min(state.page, totalPages));

        const startIndex = (state.page - 1) * state.pageSize;
        const pageReadings = readings.slice(startIndex, startIndex + state.pageSize);

        const rowsHtml = pageReadings.map(r => {
            const coordsHtml = (r.latitude != null && r.longitude != null)
                ? `<button type="button" class="btn btn-sm btn-secondary" onclick="goToHistoryAtReading(${r.latitude}, ${r.longitude}, '${_esc(r.time)}')" style="font-size:0.75rem;padding:0.2rem 0.5rem;font-family:JetBrains Mono,monospace;white-space:nowrap;display:inline-flex;align-items:center;gap:0.25rem;" title="Go to history and move slider to this point"><i class="mdi mdi-history"></i> ${r.latitude.toFixed(4)}, ${r.longitude.toFixed(4)}</button>`
                : `<span style="color:var(--text-muted);font-size:0.75rem;">—</span>`;

            const durationTd = state.onlyChanges
                ? `<td style="white-space:nowrap;">${_formatDuration(r._durationSec, r._isOngoing)}</td>`
                : '';

            return `
                <tr>
                    <td style="white-space:nowrap;">${_formatDateTime(r.time)}</td>
                    <td style="white-space:nowrap;">${_formatSensorValue(r.value, unit, isNumeric)}</td>
                    <td style="white-space:nowrap;">${_formatDelta(r.delta, unit)}</td>
                    ${durationTd}
                    <td style="white-space:nowrap;text-align:right;">${coordsHtml}</td>
                </tr>`;
        }).join('');

        tableBody.innerHTML = rowsHtml;

        if (countInfo) {
            if (state.onlyChanges) {
                countInfo.textContent = `Showing ${startIndex + 1}–${Math.min(startIndex + state.pageSize, readings.length)} of ${readings.length} changes (${allReadings.length} total readings)${state.data.truncated ? ' [limit reached]' : ''}`;
            } else {
                countInfo.textContent = `Showing ${startIndex + 1}–${Math.min(startIndex + state.pageSize, readings.length)} of ${readings.length} records${state.data.truncated ? ' [limit reached]' : ''}`;
            }
        }
        if (pageInfo) {
            pageInfo.textContent = `${state.page} / ${totalPages}`;
        }
        if (prevBtn) prevBtn.disabled = state.page <= 1;
        if (nextBtn) nextBtn.disabled = state.page >= totalPages;
    }

    function toggleSensorHistOnlyChanges(enabled) {
        state.onlyChanges = Boolean(enabled);
        state.page = 1;
        _renderTable();
    }

    function changeSensorHistPage(dir) {
        if (!state.data || !state.data.readings) return;
        const total = state.onlyChanges
            ? state.data.readings.filter((r, idx) => (typeof r.delta === 'number' ? r.delta !== 0 : r.delta != null) || idx === state.data.readings.length - 1).length
            : state.data.readings.length;
        const totalPages = Math.ceil(total / state.pageSize);
        const newPage = state.page + dir;
        if (newPage >= 1 && newPage <= totalPages) {
            state.page = newPage;
            _renderTable();
            const body = document.getElementById('sensorHistoryBody');
            if (body) body.scrollTop = 0;
        }
    }

    function selectSensorHistoryRange(range, btn) {
        state.rangeHours = range;
        document.querySelectorAll('.sensor-range-btn').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');
        loadSensorHistory();
    }

    function openSensorHistoryModal(deviceId, sensorKey, label) {
        state.deviceId = Number(deviceId);
        state.sensorKey = String(sensorKey);
        state.sensorLabel = label || sensorKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        state.rangeHours = 24;
        state.onlyChanges = true; // Default to showing only changes
        state.page = 1;
        state.data = null;

        const dev = (typeof devices !== 'undefined' ? devices : []).find(d => d.id === state.deviceId);
        const icon = dev ? ((typeof VEHICLE_ICONS !== 'undefined' && VEHICLE_ICONS[dev.vehicle_type]) || { emoji: '🚗' }).emoji : '🚗';
        const devName = dev ? dev.name : `Device ${deviceId}`;

        const titleText = document.getElementById('sensorHistoryTitleText');
        const subtitle = document.getElementById('sensorHistoryModalSubtitle');

        if (titleText) titleText.textContent = `${state.sensorLabel} History`;
        if (subtitle) subtitle.innerHTML = `${icon} <strong>${_esc(devName)}</strong> &bull; Telemetry log`;

        document.querySelectorAll('.sensor-range-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.hours === '24');
        });

        const chk = document.getElementById('sensorHistOnlyChangesCheck');
        if (chk) chk.checked = true;

        const modal = document.getElementById('sensorHistoryModal');
        if (modal) modal.classList.add('active');

        loadSensorHistory();
    }

    function closeSensorHistoryModal() {
        if (state.abortController) {
            state.abortController.abort();
            state.abortController = null;
        }
        const modal = document.getElementById('sensorHistoryModal');
        if (modal) modal.classList.remove('active');
    }

    function openSensorFullReport() {
        if (!state.deviceId || !state.sensorKey) return;
        const params = new URLSearchParams({
            type: 'sensor_graphs',
            device_ids: String(state.deviceId),
            sensors: state.sensorKey,
            start: state.startTimeIso || '',
            end: state.endTimeIso || '',
            autorun: '1',
        });
        window.open(`reports.html?${params.toString()}`, '_blank');
    }

    function _pulseLocation(lat, lng) {
        if (typeof map === 'undefined' || !map || lat == null || lng == null) return;
        if (state.pulseLayer && map.hasLayer(state.pulseLayer)) {
            map.removeLayer(state.pulseLayer);
            state.pulseLayer = null;
        }
        state.pulseLayer = L.circleMarker([lat, lng], {
            radius: 14,
            color: '#6366f1',
            weight: 3,
            fillColor: '#818cf8',
            fillOpacity: 0.5,
        }).addTo(map);

        setTimeout(() => {
            if (state.pulseLayer && map.hasLayer(state.pulseLayer)) {
                map.removeLayer(state.pulseLayer);
                state.pulseLayer = null;
            }
        }, 3500);
    }

    async function goToHistoryAtReading(lat, lng, isoTimeStr) {
        const devId = state.deviceId;
        const startTimeStr = state.startTimeIso;
        const endTimeStr = state.endTimeIso;

        closeSensorHistoryModal();

        if (!devId || !isoTimeStr) {
            if (lat != null && lng != null) panToSensorLocation(lat, lng);
            return;
        }

        const targetMs = new Date(isoTimeStr.endsWith('Z') ? isoTimeStr : isoTimeStr + 'Z').getTime();

        const isHistoryLoadedForDev = (
            typeof historyDeviceId !== 'undefined' &&
            historyDeviceId === devId &&
            typeof historyData !== 'undefined' &&
            historyData &&
            historyData.length > 0
        );

        const isWithinRange = (
            isHistoryLoadedForDev &&
            typeof historyStartTime !== 'undefined' &&
            typeof historyEndTime !== 'undefined' &&
            targetMs >= (new Date(historyStartTime).getTime() - 120000) &&
            targetMs <= (new Date(historyEndTime).getTime() + 120000)
        );

        if (isWithinRange && typeof seekToHistoryTime === 'function') {
            seekToHistoryTime(isoTimeStr, { openPopup: true });
            _pulseLocation(lat, lng);
            return;
        }

        // If history is not loaded for this device or range, load history then seek
        if (typeof loadHistory === 'function') {
            const start = new Date(startTimeStr || (targetMs - 24 * 3600 * 1000));
            const end = new Date(endTimeStr || (targetMs + 3600 * 1000));
            const ok = await loadHistory(devId, start, end);
            if (ok && typeof seekToHistoryTime === 'function') {
                seekToHistoryTime(isoTimeStr, { openPopup: true });
                _pulseLocation(lat, lng);
            }
        } else {
            panToSensorLocation(lat, lng);
        }
    }

    function panToSensorLocation(lat, lng) {
        closeSensorHistoryModal();
        if (typeof map !== 'undefined' && map && lat != null && lng != null) {
            const targetZoom = Math.max(map.getZoom(), 16);
            const targetCenter = typeof applyLatLngOffset === 'function'
                ? applyLatLngOffset([lat, lng], targetZoom)
                : [lat, lng];

            map.setView(targetCenter, targetZoom, { animate: true });
            _pulseLocation(lat, lng);
        }
    }

    // Expose global controller functions
    window.openSensorHistoryModal = openSensorHistoryModal;
    window.closeSensorHistoryModal = closeSensorHistoryModal;
    window.selectSensorHistoryRange = selectSensorHistoryRange;
    window.changeSensorHistPage = changeSensorHistPage;
    window.toggleSensorHistOnlyChanges = toggleSensorHistOnlyChanges;
    window.openSensorFullReport = openSensorFullReport;
    window.panToSensorLocation = panToSensorLocation;
    window.goToHistoryAtReading = goToHistoryAtReading;

    // Handle ESC key to close modal
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            const modal = document.getElementById('sensorHistoryModal');
            if (modal && modal.classList.contains('active')) {
                closeSensorHistoryModal();
            }
        }
    });
})();
