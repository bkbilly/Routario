/**
 * dashboard-history.js
 * History modal, playback controls, trip display, sensor graph, and CSV export.
 */

let historyLineMode = 'static'; // 'static' | 'ant'
let historyClips = [];

const PLAYBACK_SPEEDS = [1, 2, 5, 10];
let playbackSpeedIdx = 0;

const SENSOR_COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
    '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
];

const tripColors = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#84cc16'];

// --- HISTORY MODAL ---
function openHistoryModal(deviceId) {
    historyDeviceId = deviceId;

    // Reset all cycle buttons to their first option
    document.querySelectorAll('.history-quick-btn[data-group]').forEach(btn => {
        const steps = HISTORY_QUICK_GROUPS[btn.dataset.group];
        if (steps && steps.length) { btn.dataset.step = '0'; btn.textContent = steps[0].label; }
    });

    const device = devices.find(d => d.id === deviceId);
    const icon = device ? (VEHICLE_ICONS[device.vehicle_type] || VEHICLE_ICONS['other']).emoji : '🚗';
    const name = device ? device.name : `Device ${deviceId}`;
    document.getElementById('historyModalDeviceName').textContent = `${icon} ${name}`;

    document.getElementById('historyModal').classList.add('active');
    const defaultBtn = document.querySelector('.history-quick-btn[data-group="days"]');
    _setRangeHours(24);
    _setActiveQuickBtn(defaultBtn);
}

function closeHistoryModal() {
    document.getElementById('historyModal').classList.remove('active');
    _setActiveQuickBtn(null);
}

const toLocalISO = (date) => {
    const tzOffset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
};

function _setActiveQuickBtn(btn) {
    document.querySelectorAll('.history-quick-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    _validateHistoryRange();
}

const HISTORY_QUICK_GROUPS = {
    'today-yesterday': [
        {
            label: 'Today',
            set() {
                const start = new Date(); start.setHours(0, 0, 0, 0);
                const end   = new Date(); end.setHours(23, 59, 59, 999);
                document.getElementById('historyStart').value = toLocalISO(start);
                document.getElementById('historyEnd').value   = toLocalISO(end);
            }
        },
        {
            label: 'Yesterday',
            set() {
                const start = new Date(); start.setDate(start.getDate() - 1); start.setHours(0, 0, 0, 0);
                const end   = new Date(); end.setDate(end.getDate() - 1);     end.setHours(23, 59, 59, 999);
                document.getElementById('historyStart').value = toLocalISO(start);
                document.getElementById('historyEnd').value   = toLocalISO(end);
            }
        },
        {
            label: '2 Days Ago',
            set() {
                const start = new Date(); start.setDate(start.getDate() - 2); start.setHours(0, 0, 0, 0);
                const end   = new Date(); end.setDate(end.getDate() - 2);     end.setHours(23, 59, 59, 999);
                document.getElementById('historyStart').value = toLocalISO(start);
                document.getElementById('historyEnd').value   = toLocalISO(end);
            }
        },
    ],
    'hours': [
        { label: '1 Hour',  set() { _setRangeHours(1);  } },
        { label: '2 Hours', set() { _setRangeHours(2);  } },
        { label: '6 Hours', set() { _setRangeHours(6);  } },
    ],
    'days': [
        { label: '1 Day',  set() { _setRangeHours(24);  } },
        { label: '2 Days', set() { _setRangeHours(48);  } },
        { label: '7 Days', set() { _setRangeHours(168); } },
    ],
    'months': [], // populated in DOMContentLoaded
};

function _setRangeHours(hours) {
    const now   = new Date();
    const end   = new Date(); end.setHours(23, 59, 59, 999);
    const start = new Date(now.getTime() - hours * 3600000);
    document.getElementById('historyStart').value = toLocalISO(start);
    document.getElementById('historyEnd').value   = toLocalISO(end);
}

function cycleHistoryGroup(btn, groupKey) {
    const steps = HISTORY_QUICK_GROUPS[groupKey];
    if (!steps || !steps.length) return;
    const isActive = btn.classList.contains('active');
    const currentStep = parseInt(btn.dataset.step || '0');
    const step = isActive ? (currentStep + 1) % steps.length : currentStep;
    btn.dataset.step = step;
    btn.textContent  = steps[step].label;
    steps[step].set();
    _setActiveQuickBtn(btn);
}

function _validateHistoryRange() {
    const start = document.getElementById('historyStart').value;
    const end = document.getElementById('historyEnd').value;
    const invalid = start && end && start >= end;
    document.getElementById('historySubmitBtn').disabled = invalid;
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('historyStart').addEventListener('input', () => { _setActiveQuickBtn(null); _validateHistoryRange(); });
    document.getElementById('historyEnd').addEventListener('input', () => { _setActiveQuickBtn(null); _validateHistoryRange(); });

    HISTORY_QUICK_GROUPS.months = [
        {
            label: 'This Month',
            set() {
                const n = new Date();
                const start = new Date(n.getFullYear(), n.getMonth(), 1, 0, 0, 0, 0);
                const end   = new Date(n.getFullYear(), n.getMonth() + 1, 0, 23, 59, 59, 999);
                document.getElementById('historyStart').value = toLocalISO(start);
                document.getElementById('historyEnd').value   = toLocalISO(end);
            }
        },
        {
            label: 'Last Month',
            set() {
                const n = new Date();
                const start = new Date(n.getFullYear(), n.getMonth() - 1, 1, 0, 0, 0, 0);
                const end   = new Date(n.getFullYear(), n.getMonth(), 0, 23, 59, 59, 999);
                document.getElementById('historyStart').value = toLocalISO(start);
                document.getElementById('historyEnd').value   = toLocalISO(end);
            }
        },
        {
            label: '2 Months Ago',
            set() {
                const n = new Date();
                const start = new Date(n.getFullYear(), n.getMonth() - 2, 1, 0, 0, 0, 0);
                const end   = new Date(n.getFullYear(), n.getMonth() - 1, 0, 23, 59, 59, 999);
                document.getElementById('historyStart').value = toLocalISO(start);
                document.getElementById('historyEnd').value   = toLocalISO(end);
            }
        },
    ];

    const monthsBtn = document.querySelector('.history-quick-btn[data-group="months"]');
    if (monthsBtn) monthsBtn.textContent = 'This Month';
});

async function handleHistorySubmit(e) {
    e.preventDefault();
    const btn = document.getElementById('historySubmitBtn');
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Loading...';
    try {
        const start = new Date(document.getElementById('historyStart').value);
        const end = new Date(document.getElementById('historyEnd').value);
        await loadHistory(historyDeviceId, start, end);
        closeHistoryModal();
    } finally {
        btn.disabled = false;
        btn.textContent = origText;
    }
}

async function loadHistory(deviceId, startTime, endTime, batchOffset = 0) {
    historyBatchOffset = batchOffset;

    if (polylines['history']) {
        polylines['history'].eachLayer(l => map.removeLayer(l));
        delete polylines['history'];
    }
    if (markers['history_pos']) {
        map.removeLayer(markers['history_pos']);
        delete markers['history_pos'];
    }
    stopPlayback();

    // Hide ALL live markers and accuracy circles when entering history mode
    devices.forEach(d => {
        if (markers[d.id] && clusterGroup.hasLayer(markers[d.id])) clusterGroup.removeLayer(markers[d.id]);
        if (accuracyCircles[d.id] && map.hasLayer(accuracyCircles[d.id])) map.removeLayer(accuracyCircles[d.id]);
    });

    try {
        const response = await apiFetch(`${API_BASE}/positions/history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: deviceId, start_time: startTime.toISOString(), end_time: endTime.toISOString(), max_points: HISTORY_BATCH_SIZE, offset: historyBatchOffset })
        });
        const data = await response.json();
        historyHasNext = data.truncated;
        historyData = data.features;
        historyIndex = 0;
        if (historyData.length === 0) {
            showAlert({ title: 'History', message: 'No data found.', type: 'warning' });
            // Restore live markers since we're not entering history mode
            devices.forEach(d => {
                if (markers[d.id] && !clusterGroup.hasLayer(markers[d.id])) clusterGroup.addLayer(markers[d.id]);
                if (accuracyCircles[d.id] && !map.hasLayer(accuracyCircles[d.id])) accuracyCircles[d.id].addTo(map);
            });
            return;
        }
        document.getElementById('historySlider').max = historyData.length - 1;
        document.getElementById('historySlider').value = 0;

        tripColorMap = {}; // reset shared state
        const allLayers = _buildHistoryLayers();
        polylines['history'] = L.featureGroup(allLayers);

        const footer = document.getElementById('historyControls');
        if (footer) footer.style.display = 'flex';
        _updateLineModeBtn();
        _updateSpeedBtn();
        _updateSliderGradient();
        requestAnimationFrame(applyHistoryControlsPadding);
        _loadHistoryClips(deviceId, startTime, endTime);

        if (allLayers.length > 0) {
            requestAnimationFrame(() => {
                const bottomPad = (footer?.offsetHeight ?? 0) + 48; // 48 ≈ 2rem offset + gap
                map.fitBounds(polylines['history'].getBounds(), {
                    paddingTopLeft: [getSidebarOffset(), 16],
                    paddingBottomRight: [16, bottomPad],
                });
            });
        }
        document.querySelector('.sidebar').classList.add('history-active');

        // Hide regular list
        document.getElementById('sidebarDeviceList').style.display = 'none';

        // Show History Details section
        document.getElementById('sidebarHistoryDetails').style.display = 'block';

        const device = devices.find(d => d.id === deviceId);
        document.getElementById('historyDeviceName').textContent = device ? device.name : 'History Details';
        await loadTripsForHistory(deviceId, startTime, endTime);
        updatePlaybackUI();
        _updateBatchNav();
    } catch (error) {
        console.log(error);
        showAlert({ title: 'Error', message: 'Failed to load history.', type: 'error' });
        // Restore live markers since history mode was not entered
        devices.forEach(d => {
            if (markers[d.id] && !clusterGroup.hasLayer(markers[d.id])) clusterGroup.addLayer(markers[d.id]);
            if (accuracyCircles[d.id] && !map.hasLayer(accuracyCircles[d.id])) accuracyCircles[d.id].addTo(map);
        });
    }
}

function _buildHistoryLayers() {
    const ant = historyLineMode === 'ant';
    const allLayers = [];
    let tripColorIdx = 0;
    let currentTripId = undefined;
    let currentSegment = [];

    const makeLine = (coords, color, isBridge) => {
        if (ant) {
            return L.polyline.antPath(coords, {
                color, weight: 4, opacity: 0.85,
                delay: 2000, dashArray: [5, 80], pulseColor: '#ffffff',
            }).addTo(map);
        }
        if (isBridge) {
            return L.polyline(coords, { color, weight: 2, opacity: 0.45, dashArray: '6 10' }).addTo(map);
        }
        return L.polyline(coords, { color, weight: 4, opacity: 0.85 }).addTo(map);
    };

    const flushSegment = () => {
        if (currentSegment.length < 2) { currentSegment = []; return; }
        let color;
        if (currentTripId) {
            if (!(currentTripId in tripColorMap)) {
                tripColorMap[currentTripId] = tripColors[tripColorIdx++ % tripColors.length];
            }
            color = tripColorMap[currentTripId];
        } else {
            color = '#ef4444';
        }
        allLayers.push(makeLine(currentSegment, color, false));
        currentSegment = [];
    };

    historyData.forEach(f => {
        const tripId = f.properties?.trip_id ?? null;
        const latlng = [f.geometry.coordinates[1], f.geometry.coordinates[0]];
        if (tripId !== currentTripId) {
            const lastPoint = currentSegment.length > 0 ? currentSegment[currentSegment.length - 1] : null;
            flushSegment();
            currentTripId = tripId;
            if (lastPoint) allLayers.push(makeLine([lastPoint, latlng], '#ef4444', true));
        }
        currentSegment.push(latlng);
    });
    flushSegment();

    return allLayers;
}

function _redrawHistoryPolylines() {
    if (polylines['history']) {
        polylines['history'].eachLayer(l => map.removeLayer(l));
        delete polylines['history'];
    }
    tripColorMap = {};
    polylines['history'] = L.featureGroup(_buildHistoryLayers());
    _updateLineModeBtn();
    _updateSliderGradient();
}

function toggleHistoryLineMode() {
    historyLineMode = historyLineMode === 'static' ? 'ant' : 'static';
    if (historyData.length > 0) _redrawHistoryPolylines();
    else _updateLineModeBtn();
}

function _updateSliderGradient() {
    const slider = document.getElementById('historySlider');
    if (!slider) return;
    if (historyData.length < 2) { slider.style.removeProperty('--track-gradient'); return; }

    const total = historyData.length - 1;
    const stops = [];
    let i = 0;
    while (i < historyData.length) {
        const tripId = historyData[i].properties?.trip_id ?? null;
        const color = tripId ? (tripColorMap[tripId] || '#6b7280') : '#6b7280';
        let j = i + 1;
        while (j < historyData.length && (historyData[j].properties?.trip_id ?? null) === tripId) j++;
        const s = (i / total * 100).toFixed(1);
        const e = ((j - 1) / total * 100).toFixed(1);
        stops.push(`${color} ${s}%`, `${color} ${e}%`);
        i = j;
    }
    slider.style.setProperty('--track-gradient', `linear-gradient(to right, ${stops.join(', ')})`);
}

function _updateLineModeBtn() {
    const btn = document.getElementById('historyLineModeBtn');
    if (!btn) return;
    const isAnt = historyLineMode === 'ant';
    btn.classList.toggle('active', isAnt);
    btn.title = isAnt ? 'Switch to static lines' : 'Switch to animated lines';
}

function exitHistoryMode() {
    stopPlayback();
    _clearAlertHighlight();
    if (polylines['history']) {
        polylines['history'].eachLayer(l => map.removeLayer(l));
        delete polylines['history'];
    }

    if (markers['history_pos']) {
        map.removeLayer(markers['history_pos']);
        delete markers['history_pos'];
    }
    if (sensorChart) { sensorChart.destroy(); sensorChart = null; }
    selectedSensorAttrs = new Set([]);
    currentHistoryTab = 'trips';
    switchHistoryTab('trips');

    // Remove history accuracy circle
    if (accuracyCircles['history_pos']) {
        map.removeLayer(accuracyCircles['history_pos']);
        delete accuracyCircles['history_pos'];
    }

    // Restore ALL live markers and accuracy circles when exiting history mode
    devices.forEach(d => {
        if (markers[d.id] && !clusterGroup.hasLayer(markers[d.id])) clusterGroup.addLayer(markers[d.id]);
        if (accuracyCircles[d.id] && !map.hasLayer(accuracyCircles[d.id])) accuracyCircles[d.id].addTo(map);
    });

    // Hide history footer
    const footer = document.getElementById('historyControls');
    if (footer) footer.style.display = 'none';
    const details = document.getElementById('sidebarHistoryDetails');
    if (details) details.style.paddingBottom = '';
    document.querySelector('.sidebar').classList.remove('history-active');

    document.getElementById('historySlider')?.style.removeProperty('--track-gradient');
    historyClips = [];
    _renderClipMarkers();
    historyTrips = [];
    historyBatchOffset = 0;
    historyHasNext = false;
    const batchNav = document.getElementById('historyBatchNav');
    if (batchNav) batchNav.style.display = 'none';
    const tripLabel = document.getElementById('historyTripLabel');
    if (tripLabel) tripLabel.textContent = '';
    const tripList = document.getElementById('tripListContent');
    if (tripList) tripList.innerHTML = '';
    document.getElementById('sidebarDeviceList').style.display = 'block';
    document.getElementById('sidebarHistoryDetails').style.display = 'none';
}

function _updateBatchNav() {
    const hasPrev = historyBatchOffset > 0;
    const hasNext = historyHasNext;
    const nav     = document.getElementById('historyBatchNav');
    if (!nav) return;

    nav.style.display = (hasPrev || hasNext) ? 'flex' : 'none';
    document.getElementById('historyPrevBatch').style.visibility = hasPrev ? 'visible' : 'hidden';
    document.getElementById('historyNextBatch').style.visibility = hasNext ? 'visible' : 'hidden';

    const page = Math.floor(historyBatchOffset / HISTORY_BATCH_SIZE) + 1;
    document.getElementById('historyBatchLabel').textContent = `Batch ${page}`;

}

async function loadHistoryBatch(direction) {
    const newOffset = historyBatchOffset + direction * HISTORY_BATCH_SIZE;
    if (newOffset < 0) return;
    const start = new Date(document.getElementById('historyStart').value);
    const end   = new Date(document.getElementById('historyEnd').value);
    await loadHistory(historyDeviceId, start, end, newOffset);
}

function togglePlayback() { if (playbackInterval) stopPlayback(); else startPlayback(); }

function startPlayback() {
    if (historyData.length === 0) return;
    document.getElementById('playbackBtn').innerHTML = '<i class="mdi mdi-pause"></i>';
    if (!markers['history_pos']) createHistoryMarker();
    const interval = Math.round(100 / PLAYBACK_SPEEDS[playbackSpeedIdx]);
    playbackInterval = setInterval(() => {
        if (historyIndex >= historyData.length - 1) { stopPlayback(); return; }
        historyIndex++;
        updatePlaybackUI();
    }, interval);
}

function cyclePlaybackSpeed() {
    playbackSpeedIdx = (playbackSpeedIdx + 1) % PLAYBACK_SPEEDS.length;
    _updateSpeedBtn();
    if (playbackInterval) { stopPlayback(); startPlayback(); }
}

function _updateSpeedBtn() {
    const btn = document.getElementById('historySpeedBtn');
    if (!btn) return;
    const speed = PLAYBACK_SPEEDS[playbackSpeedIdx];
    btn.textContent = `${speed}×`;
    btn.classList.toggle('active', speed > 1);
}

function stopPlayback() {
    if (playbackInterval) { clearInterval(playbackInterval); playbackInterval = null; document.getElementById('playbackBtn').innerHTML = '<i class="mdi mdi-play"></i>'; }
}

function seekHistory(value) { historyIndex = parseInt(value); stopPlayback(); updatePlaybackUI(); }

let _stepHoldTimer = null;
let _stepHoldInterval = null;

function _startStepHold(delta) {
    stepHistory(delta);
    _stepHoldTimer = setTimeout(() => {
        const interval = Math.round(100 / PLAYBACK_SPEEDS[playbackSpeedIdx]);
        _stepHoldInterval = setInterval(() => stepHistory(delta), interval);
    }, 350);
}

function _stopStepHold() {
    clearTimeout(_stepHoldTimer);
    clearInterval(_stepHoldInterval);
    _stepHoldTimer = null;
    _stepHoldInterval = null;
}

function stepHistory(delta) {
    stopPlayback();
    historyIndex = Math.max(0, Math.min(historyData.length - 1, historyIndex + delta));
    updatePlaybackUI();
}

function updatePlaybackUI() {
    if (historyData.length === 0) return;
    const feature = historyData[historyIndex];
    const p = feature.properties;
    const position = [feature.geometry.coordinates[1], feature.geometry.coordinates[0]];
    const time = formatDateToLocal(p.time);
    const heading = p.course ?? null;
    const device = devices.find(d => d.id === historyDeviceId);

    buildSensorAttrList();
    updateSensorChartCursor(historyIndex);
    document.getElementById('historySlider').value = historyIndex;
    document.getElementById('historyTimestamp').textContent = time;
    document.getElementById('historySliderCounter').textContent = `${historyIndex + 1} / ${historyData.length}`;

    if (!markers['history_pos']) createHistoryMarker();

    const vehicle = VEHICLE_ICONS[device?.vehicle_type] || VEHICLE_ICONS['other'];
    const ignColor = p.ignition === true ? '#10b981' : p.ignition === false ? '#ef4444' : '#6b7280';
    const historyPopup = `
        <div class="vp-popup">
            <div class="vp-header">
                <span class="vp-icon">${vehicle.emoji}</span>
                <span class="vp-name">${device?.name || 'History'}</span>
            </div>
            <div class="vp-grid">
                <span class="vp-label">Time</span>      <span class="vp-value vp-mono">${time}</span>
                <span class="vp-label">Speed</span>     <span class="vp-value">${p.speed != null ? fmtSpeed(p.speed) : '—'}</span>
                <span class="vp-label">Heading</span>   <span class="vp-value">${p.course != null ? Number(p.course).toFixed(0) + '°' : '—'}</span>
                <span class="vp-label">Ignition</span>  <span class="vp-value" style="color:${ignColor};font-weight:700;">${p.ignition === true ? 'ON' : p.ignition === false ? 'OFF' : '—'}</span>
                <span class="vp-label">Satellites</span><span class="vp-value">${p.satellites != null ? p.satellites : '—'}</span>
                <span class="vp-label">Altitude</span>  <span class="vp-value">${fmtAlt(p.altitude || 0)}</span>
                <span class="vp-label">Lat/Lng</span>   <span class="vp-value">${position[0].toFixed(5)}, ${position[1].toFixed(5)}</span>
            </div>
        </div>
    `;
    markers['history_pos'].setLatLng(position).setIcon(L.divIcon({
        html: getMarkerHtml(device?.vehicle_type, p.ignition, heading),
        className: 'history-marker',
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    })).bindPopup(historyPopup);

    // History accuracy circle
    const histAccuracy = p.sensors?.accuracy ?? null;
    if (histAccuracy != null && histAccuracy > 0) {
        if (accuracyCircles['history_pos']) {
            accuracyCircles['history_pos'].setLatLng(position).setRadius(histAccuracy);
        } else {
            accuracyCircles['history_pos'] = L.circle(position, {
                radius: histAccuracy,
                className: 'device-accuracy-circle',
                interactive: false,
            }).addTo(map);
            accuracyCircles['history_pos'].bringToBack();
        }
    } else if (accuracyCircles['history_pos']) {
        map.removeLayer(accuracyCircles['history_pos']);
        delete accuracyCircles['history_pos'];
    }

    updatePointDetails(feature);

    // Trip label in floating controls
    const tripLabel = document.getElementById('historyTripLabel');
    const currentTrip = getCurrentTripForPoint(p.time);
    if (tripLabel) {
        if (currentTrip) {
            const tripIndex = historyTrips.length - historyTrips.indexOf(currentTrip);
            const dist = currentTrip.distance_km != null ? ` · ${fmtDist(currentTrip.distance_km)}` : '';
            const color = tripColorMap[currentTrip.id] || 'var(--accent-secondary)';
            tripLabel.textContent = `Trip ${tripIndex}${dist}`;
            tripLabel.style.background = `color-mix(in srgb, ${color} 20%, transparent)`;
            tripLabel.style.borderColor = `color-mix(in srgb, ${color} 40%, transparent)`;
            tripLabel.style.color = color;
        } else {
            tripLabel.textContent = historyTrips.length ? 'Between trips' : '';
            tripLabel.style.background = '';
            tripLabel.style.borderColor = '';
            tripLabel.style.color = '';
        }
    }

    // Highlight active trip card in sidebar
    document.querySelectorAll('.trip-card').forEach((card, i) => {
        const isActive = currentTrip && historyTrips.indexOf(currentTrip) === i;
        card.classList.toggle('trip-card-active', isActive);
    });
}

function updatePointDetails(feature) {
    const p = feature.properties;
    const content = document.getElementById('pointDetailsContent');

    const di = (key, val, style = '') =>
        val != null ? `<div class="detail-item"><span class="detail-key">${key}</span><div class="detail-val"${style ? ` style="${style}"` : ''}>${val}</div></div>` : '';

    const ignStyle = p.ignition === true ? 'color:var(--accent-success)' : 'color:var(--accent-danger)';
    const ignVal   = p.ignition === true ? 'ON' : p.ignition === false ? 'OFF' : null;

    let html = `
        <div class="detail-grid">
            ${di('Lat/Lon', `${feature.geometry.coordinates[1].toFixed(5)}, ${feature.geometry.coordinates[0].toFixed(5)}`)}
            ${di('Speed',      p.speed      != null ? fmtSpeed(p.speed)        : null)}
            ${di('Heading',    p.course     != null ? p.course.toFixed(0) + '°': null)}
            ${di('Altitude',   p.altitude   != null ? fmtAlt(p.altitude)       : null)}
            ${di('Satellites', p.satellites != null ? p.satellites             : null)}
            ${di('Ignition',   ignVal, ignStyle)}
        </div>
    `;
    if (p.sensors && Object.keys(p.sensors).length > 0) {
        html += '<h4 style="font-size: 0.8rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 0.5rem;">Attributes</h4>';
        html += '<table class="attr-table" style="table-layout:fixed;"><tbody>';
        Object.keys(p.sensors).sort().forEach(key => {
            const v = p.sensors[key];
            let display;
            if (key === 'beacon_ids' && Array.isArray(v)) {
                display = v.map(b => `${b.id}${b.rssi !== undefined ? ` (${b.rssi}dBm)` : ''}`).join('<br>');
            } else if (Array.isArray(v) || (v !== null && typeof v === 'object')) {
                display = `<code style="font-size:0.75rem">${JSON.stringify(v)}</code>`;
            } else {
                display = v;
            }
            html += `<tr><td class="attr-key">${key}</td><td class="attr-val">${display}</td></tr>`;
        });
        html += '</tbody></table>';
    } else html += '<div style="text-align: center; color: var(--text-muted); padding: 1rem; font-size: 0.875rem;">No additional attributes</div>';
    content.innerHTML = html;
}

function createHistoryMarker() {
    const device = devices.find(d => d.id === historyDeviceId);
    const vehicleIcon = (VEHICLE_ICONS[device?.vehicle_type] || VEHICLE_ICONS['other']).emoji;
    const heading = historyData[historyIndex].properties.course ?? null;
    const rotationStyle = (device?.vehicle_type === 'arrow') && heading != null ?
        `transform: rotate(${heading}deg);` : '';

    const icon = L.divIcon({
        html: `<div style="font-size: 28px; ${rotationStyle}">${vehicleIcon}</div>`,
        className: 'history-marker',
        iconSize: [32, 32],
        iconAnchor: [16, 16]
    });
    const startPos = historyData[historyIndex].geometry.coordinates;
    markers['history_pos'] = L.marker([startPos[1], startPos[0]], { icon }).addTo(map);
}

// Load Trips for History Modal
async function loadTripsForHistory(deviceId, startTime, endTime) {
    const container = document.getElementById('tripListContent');
    if (!container) return;
    container.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:0.5rem 0;text-align:center;">Loading trips…</div>';

    try {
        const res = await apiFetch(
            `${API_BASE}/devices/${deviceId}/trips?start_date=${startTime.toISOString()}&end_date=${endTime.toISOString()}`
        );
        if (!res.ok) throw new Error('Failed to fetch trips');
        let trips = await res.json();

        // Deduplicate by id — guards against DB rows with different IDs
        // but identical start_time/distance (rapid ignition toggle artifacts)
        const seenIds = new Set();
        trips = trips.filter(t => {
            if (seenIds.has(t.id)) return false;
            seenIds.add(t.id);
            return true;
        });

        // Also deduplicate by start_time — two trips starting at the exact same
        // second are always duplicates regardless of their DB ids
        const seenTimes = new Set();
        trips = trips.filter(t => {
            const key = t.start_time;
            if (seenTimes.has(key)) return false;
            seenTimes.add(key);
            return true;
        });

        // Drop phantom trips: closed immediately with no meaningful movement
        trips = trips.filter(t => t.end_time || (t.distance_km != null && t.distance_km > 0.05));

        historyTrips = trips;

        // Build the set of trip IDs that have at least one point in the returned data
        const tripIdsWithPoints = new Set(
            historyData.map(f => f.properties?.trip_id).filter(id => id != null)
        );

        if (!trips.length) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:0.5rem 0;text-align:center;">No trips detected in this period</div>';
            switchHistoryTab('details');
            return;
        }

        // ── Summary calculations ──────────────────────────────────────────
        const totalDistKm   = trips.reduce((sum, t) => sum + (t.distance_km || 0), 0);
        const totalMinutes  = trips.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);

        // Period distance from historyData points (includes driving between trips)
        let periodDistKm = 0;
        if (historyData.length > 1) {
            // Already calculated server-side in summary — re-derive from point count heuristic
            // We use total odometer delta: first vs last point distance approximation
            // Better: just show total trip distance vs period label
        }

        // fmtDist is provided globally by units.js
        const fmtTime = (mins) => {
            const h = Math.floor(mins / 60);
            const m = Math.round(mins % 60);
            if (h === 0) return `${m} min`;
            if (m === 0) return `${h}h`;
            return `${h}h ${m}m`;
        };

        const summaryHtml = `
        <div class="detail-grid" style="margin-bottom:1rem;">
            <div class="detail-item">
                <span class="detail-key">Distance</span>
                <div class="detail-val">${fmtDist(totalDistKm)}</div>
            </div>
            <div class="detail-item">
                <span class="detail-key">Time</span>
                <div class="detail-val">${fmtTime(totalMinutes)}</div>
            </div>
        </div>`;
        container.innerHTML = summaryHtml + trips.map((trip, i) => {
            const start   = trip.start_time ? formatDateToLocal(trip.start_time) : '—';
            const end     = trip.end_time   ? formatDateToLocal(trip.end_time)   : 'Ongoing';
            const dist    = trip.distance_km != null ? fmtDist(trip.distance_km) : '—';
            const dur     = formatDuration(trip.duration_minutes);
            const label   = trips.length - i;
            const color   = tripColorMap[trip.id] || tripColors[i % tripColors.length];
            const hasData = tripIdsWithPoints.has(trip.id);
            const dimStyle   = hasData ? '' : 'opacity:0.4;';
            const titleAttr  = hasData ? 'Click to jump to this trip' : 'No map data — outside the 2,000-point limit';
            const clickAttr  = hasData ? `onclick="seekToTrip('${trip.start_time}')"` : '';

            return `
            <div class="trip-card" ${clickAttr} title="${titleAttr}"
                 style="border-left: 3px solid ${color}; ${dimStyle}${hasData ? 'cursor:pointer;' : 'cursor:default;'}">
                <div class="trip-card-header">
                    <span class="trip-index" style="color: ${color};">Trip ${label}</span>
                    <span class="trip-badges">
                        <span class="trip-badge"><i class="mdi mdi-map-marker"></i> ${dist}</span>
                        <span class="trip-badge">⏱ ${dur}</span>
                    </span>
                </div>
                <div class="trip-card-body">
                    <div class="trip-time">${start} → ${end}</div>
                </div>
            </div>`;
        }).join('');

    } catch (e) {
        historyTrips = [];
        container.innerHTML = '<div style="color:var(--accent-danger);font-size:0.8rem;padding:0.5rem 0;">Failed to load trips</div>';
    }
}

function seekToTrip(startTimeStr) {
    if (!historyData.length) return;
    const target = new Date(startTimeStr).getTime();
    let closest = 0;
    let closestDiff = Infinity;
    historyData.forEach((f, idx) => {
        const diff = Math.abs(new Date(f.properties.time).getTime() - target);
        if (diff < closestDiff) { closestDiff = diff; closest = idx; }
    });
    historyIndex = closest;
    stopPlayback();
    updatePlaybackUI();
    map.panTo([
        historyData[closest].geometry.coordinates[1],
        historyData[closest].geometry.coordinates[0]
    ]);
}

function getCurrentTripForPoint(isoTimeStr) {
    if (!historyTrips.length || !isoTimeStr) return null;
    const t = new Date(isoTimeStr).getTime();
    return historyTrips.find((trip, i) => {
        const start = new Date(trip.start_time).getTime();
        const end   = trip.end_time ? new Date(trip.end_time).getTime() : Infinity;
        return t >= start && t <= end;
    }) || null;
}

// ── Tab switcher ───────────────────────────────────────────────
function switchHistoryTab(tab) {
    currentHistoryTab = tab;
    document.getElementById('tabTrips').style.display   = tab === 'trips'   ? 'block' : 'none';
    document.getElementById('tabDetails').style.display = tab === 'details' ? 'block' : 'none';
    document.getElementById('tabGraph').style.display   = tab === 'graph'   ? 'block' : 'none';
    document.getElementById('tabBtnTrips').classList.toggle('active',   tab === 'trips');
    document.getElementById('tabBtnDetails').classList.toggle('active', tab === 'details');
    document.getElementById('tabBtnGraph').classList.toggle('active',   tab === 'graph');
    if (tab === 'graph') renderSensorGraph();
}

// ── Build attribute list from all historyData ──────────────────
function buildSensorAttrList() {
    if (!historyData || historyData.length === 0) return;

    // Collect all numeric keys across all points
    const attrSet = new Set();

    // Always include core fields if they are numeric
    const coreFields = ['speed', 'altitude', 'course', 'satellites'];
    coreFields.forEach(f => attrSet.add(f));

    historyData.forEach(feat => {
        const p = feat.properties;
        // Add sensor sub-keys
        if (p.sensors) {
            Object.entries(p.sensors).forEach(([k, v]) => {
                if (k !== 'raw' && !isNaN(parseFloat(v))) attrSet.add('sensors.' + k);
            });
        }
    });

    const container = document.getElementById('sensorAttrList');
    container.innerHTML = '';

    let colorIdx = 0;
    attrSet.forEach(attr => {
        const color = SENSOR_COLORS[colorIdx % SENSOR_COLORS.length];
        colorIdx++;

        const chip = document.createElement('button');
        chip.className = 'sensor-chip' + (selectedSensorAttrs.has(attr) ? ' selected' : '');
        chip.dataset.attr = attr;
        chip.dataset.color = color;
        chip.style.setProperty('--chip-color', color);
        chip.textContent = formatAttrLabel(attr);
        chip.onclick = () => toggleSensorAttr(attr, chip);
        container.appendChild(chip);
    });

    renderSensorGraph();
}

function formatAttrLabel(attr) {
    return attr
        .replace('sensors.', '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
}

function toggleSensorAttr(attr, chip) {
    if (selectedSensorAttrs.has(attr)) {
        selectedSensorAttrs.delete(attr);
        chip.classList.remove('selected');
    } else {
        selectedSensorAttrs.add(attr);
        chip.classList.add('selected');
    }
    renderSensorGraph();
}

// ── Render / update the Chart.js graph ────────────────────────
function renderSensorGraph() {
    if (!historyData || historyData.length === 0) return;

    const canvas = document.getElementById('sensorChart');
    const emptyMsg = document.getElementById('sensorChartEmpty');

    if (selectedSensorAttrs.size === 0) {
        canvas.style.display = 'none';
        emptyMsg.style.display = 'block';
        return;
    }
    canvas.style.display = 'block';
    emptyMsg.style.display = 'none';

    // Build labels (timestamps) and datasets
    const labels = historyData.map(f => {
        const d = new Date(f.properties.time);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    });

    const chips = document.querySelectorAll('.sensor-chip.selected');
    const colorMap = {};
    chips.forEach(c => { colorMap[c.dataset.attr] = c.dataset.color; });

    const datasets = Array.from(selectedSensorAttrs).map(attr => {
        const color = colorMap[attr] || '#3b82f6';
        const data = historyData.map(f => {
            const p = f.properties;
            if (attr.startsWith('sensors.')) {
                const key = attr.slice('sensors.'.length);
                const val = p.sensors?.[key];
                return val !== undefined ? parseFloat(val) : null;
            }
            const val = p[attr];
            return val !== undefined ? parseFloat(val) : null;
        });
        return {
            label: formatAttrLabel(attr),
            data,
            borderColor: color,
            backgroundColor: color + '22',
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            tension: 0.3,
            fill: false,
            yAxisID: 'y',
        };
    });

    if (sensorChart) {
        sensorChart.data.labels = labels;
        sensorChart.data.datasets = datasets;
        sensorChart.update('none');
    } else {
        sensorChart = new Chart(canvas, {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        display: true,
                        labels: {
                            color: '#9ca3af',
                            font: { family: 'JetBrains Mono', size: 10 },
                            boxWidth: 12,
                            padding: 8,
                        }
                    },
                    tooltip: {
                        backgroundColor: '#131825',
                        borderColor: '#374151',
                        borderWidth: 1,
                        titleColor: '#e5e7eb',
                        bodyColor: '#9ca3af',
                        titleFont: { family: 'JetBrains Mono', size: 11 },
                        bodyFont: { family: 'JetBrains Mono', size: 11 },
                    },
                    // Vertical cursor line plugin (defined below)
                    verticalLine: { index: historyIndex }
                },
                scales: {
                    x: {
                        ticks: {
                            color: '#6b7280',
                            font: { family: 'JetBrains Mono', size: 9 },
                            maxTicksLimit: 6,
                            maxRotation: 0,
                        },
                        grid: { color: '#374151' }
                    },
                    y: {
                        ticks: { color: '#6b7280', font: { family: 'JetBrains Mono', size: 10 } },
                        grid: { color: '#374151' }
                    }
                }
            },
            plugins: [verticalLinePlugin]
        });
    }

    updateSensorChartCursor(historyIndex);
}

// ── Vertical cursor line plugin ────────────────────────────────
const verticalLinePlugin = {
    id: 'verticalLine',
    afterDraw(chart) {
        const idx = chart.options.plugins.verticalLine?.index;
        if (idx == null || !chart.data.labels?.length) return;
        const meta = chart.getDatasetMeta(0);
        if (!meta || !meta.data[idx]) return;
        const x = meta.data[idx].x;
        const ctx = chart.ctx;
        const top = chart.chartArea.top;
        const bottom = chart.chartArea.bottom;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.restore();
    }
};

function updateSensorChartCursor(idx) {
    if (!sensorChart) return;
    sensorChart.options.plugins.verticalLine.index = idx;
    sensorChart.update('none');
}

// ── Export history data to CSV ─────────────────────────────────
function exportHistoryCSV() {
    if (!historyData || historyData.length === 0) {
        showAlert({ title: 'Export', message: 'No history data to export.', type: 'warning' });
        return;
    }

    // Collect all sensor keys across all points
    const sensorKeys = new Set();
    historyData.forEach(f => {
        if (f.properties.sensors) {
            Object.keys(f.properties.sensors).forEach(k => {
                if (k !== 'raw') sensorKeys.add(k);
            });
        }
    });

    const coreFields = ['time', 'latitude', 'longitude', 'speed', 'altitude', 'course', 'satellites', 'ignition'];
    const sensorCols = Array.from(sensorKeys).sort();
    const allHeaders = [...coreFields, ...sensorCols];

    // Build CSV rows
    const rows = historyData.map(f => {
        const p = f.properties;
        const coords = f.geometry.coordinates;
        const row = {
            time:       p.time || '',
            latitude:   coords[1],
            longitude:  coords[0],
            speed:      p.speed      ?? '',
            altitude:   p.altitude   ?? '',
            course:     p.course     ?? '',
            satellites: p.satellites ?? '',
            ignition:   p.ignition != null ? (p.ignition ? 'true' : 'false') : '',
        };
        sensorCols.forEach(k => {
            row[k] = p.sensors?.[k] ?? '';
        });
        return allHeaders.map(h => {
            const val = row[h] ?? '';
            // Wrap in quotes if value contains comma or quote
            const str = String(val);
            return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
        }).join(',');
    });

    const csvContent = [allHeaders.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const device = devices.find(d => d.id === historyDeviceId);
    const deviceName = (device?.name || 'device').replace(/\s+/g, '_');
    const now = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const filename = `history_${deviceName}_${now}.csv`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    showAlert({ title: 'Export', message: `Exported ${historyData.length} points to ${filename}`, type: 'success' });
}

// --- KEYBOARD SHORTCUTS (history mode only) ---
document.addEventListener('keydown', (e) => {
    // Only active when history is loaded and no input/textarea is focused
    if (!historyData.length) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepHistory(-1);
    } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepHistory(1);
    } else if (e.key === ' ') {
        e.preventDefault();
        togglePlayback();
    }
});

window.addEventListener('resize', () => {
    if (historyDeviceId) requestAnimationFrame(applyHistoryControlsPadding);
});

// In loadHistory, after: footer.style.display = 'flex';
function applyHistoryControlsPadding() {
    const footer = document.getElementById('historyControls');
    const details = document.getElementById('sidebarHistoryDetails');
    if (!footer || !details) return;
    const height = footer.offsetHeight;
    const bottomOffset = parseInt(getComputedStyle(footer).bottom) || 16;
    details.style.paddingBottom = (height + bottomOffset + 8) + 'px';
}

// ── Dashcam clip markers ──────────────────────────────────────────────────────

async function _loadHistoryClips(deviceId, startTime, endTime) {
    try {
        const res = await apiFetch(
            `${API_BASE}/dashcam/clips?device_id=${deviceId}&start=${startTime.toISOString()}&end=${endTime.toISOString()}`
        );
        if (!res.ok) return;
        historyClips = await res.json();
    } catch {
        historyClips = [];
    }
    _renderClipMarkers();
}

function _renderClipMarkers() {
    const row = document.querySelector('.history-slider-row');
    document.querySelectorAll('.history-clip-marker').forEach(el => el.remove());
    if (!row || !historyClips.length || historyData.length < 2) return;

    const total = historyData.length - 1;
    historyClips.forEach(clip => {
        const clipTs = new Date(clip.timestamp).getTime();
        // find nearest history point index
        let nearest = 0, minDiff = Infinity;
        historyData.forEach((f, i) => {
            const diff = Math.abs(new Date(f.properties.time).getTime() - clipTs);
            if (diff < minDiff) { minDiff = diff; nearest = i; }
        });
        const pct = (nearest / total) * 100;
        const btn = document.createElement('button');
        btn.className = 'history-clip-marker';
        btn.style.left = `${pct}%`;
        btn.title = `${clip.event_type.replace(/_/g, ' ')} · ${formatDateToLocal(clip.timestamp)}`;
        btn.innerHTML = '<i class="mdi mdi-video"></i>';
        btn.onclick = (e) => {
            e.stopPropagation();
            seekHistory(nearest);
            _openHistoryClipPlayer(clip);
        };
        row.appendChild(btn);
    });
}

function _openHistoryClipPlayer(clip) {
    let modal = document.getElementById('historyClipModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'historyClipModal';
        modal.className = 'modal';
        modal.style.zIndex = '3001';
        modal.innerHTML = `
            <div class="modal-content" style="max-width:640px;">
                <div class="modal-header">
                    <h2 class="modal-title" id="historyClipTitle">Video Clip</h2>
                    <button type="button" class="modal-close" onclick="document.getElementById('historyClipModal').style.display='none';document.getElementById('historyClipVideo').pause();"><i class="mdi mdi-close"></i></button>
                </div>
                <div style="padding:1rem;">
                    <video id="historyClipVideo" controls style="width:100%;border-radius:8px;background:#000;"></video>
                    <div id="historyClipMeta" style="margin-top:0.75rem;font-size:0.8rem;color:var(--text-muted);display:flex;gap:1rem;flex-wrap:wrap;"></div>
                </div>
            </div>`;
        document.body.appendChild(modal);
    }
    const ev = clip.event_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    document.getElementById('historyClipTitle').textContent = ev;
    document.getElementById('historyClipVideo').src = `${API_BASE}/dashcam/clips/${clip.id}/video`;
    document.getElementById('historyClipMeta').innerHTML = [
        `<span><i class="mdi mdi-clock-outline"></i> ${formatDateToLocal(clip.timestamp)}</span>`,
        `<span><i class="mdi mdi-video"></i> ${clip.camera}</span>`,
        clip.speed != null ? `<span><i class="mdi mdi-speedometer"></i> ${Number(clip.speed).toFixed(0)} km/h</span>` : '',
    ].filter(Boolean).join('');
    modal.style.display = 'flex';
    document.getElementById('historyClipVideo').play().catch(() => {});
}
