/**
 * dashboard-history.js
 * History modal, playback controls, trip display, sensor graph, and CSV export.
 */

const SENSOR_COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
    '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'
];

const tripColors = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#84cc16'];

// --- HISTORY MODAL ---
function openHistoryModal(deviceId) {
    historyDeviceId = deviceId;
    setHistoryRange(24);
    document.getElementById('historyModal').classList.add('active');
}

function closeHistoryModal() { document.getElementById('historyModal').classList.remove('active'); }

function setHistoryRange(hours) {
    const now = new Date();
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000);

    const toLocalISO = (date) => {
        const tzOffset = date.getTimezoneOffset() * 60000;
        return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
    };

    document.getElementById('historyStart').value = toLocalISO(start);
    document.getElementById('historyEnd').value = toLocalISO(end);
}

async function handleHistorySubmit(e) {
    e.preventDefault();
    const start = new Date(document.getElementById('historyStart').value);
    const end = new Date(document.getElementById('historyEnd').value);
    await loadHistory(historyDeviceId, start, end);
    closeHistoryModal();
}

async function loadHistory(deviceId, startTime, endTime) {
    if (polylines['history']) {
        polylines['history'].eachLayer(l => map.removeLayer(l));
        delete polylines['history'];
    }
    if (markers['history_pos']) {
        map.removeLayer(markers['history_pos']);
        delete markers['history_pos'];
    }
    stopPlayback();

    // Hide live marker for this device when history loads
    if (markers[deviceId]) {
        markers[deviceId].remove();
    }

    try {
        const response = await apiFetch(`${API_BASE}/positions/history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_id: deviceId, start_time: startTime.toISOString(), end_time: endTime.toISOString(), max_points: 2000 })
        });
        const data = await response.json();
        historyData = data.features;
        historyIndex = 0;
        if (historyData.length === 0) { showAlert({ title: 'History', message: 'No data found.', type: 'warning' }); return; }
        document.getElementById('historySlider').max = historyData.length - 1;
        document.getElementById('historySlider').value = 0;

        // Draw trip polylines — each contiguous run of the same trip_id gets its own color.
        // Points between trips (trip_id: null) are drawn as a subtle dashed grey line.
        const allLayers = [];
        tripColorMap = {}; // reset shared state
        let tripColorIdx = 0;
        let currentTripId = undefined;
        let currentSegment = [];

        const flushSegment = () => {
            if (currentSegment.length < 2) { currentSegment = []; return; }
            if (currentTripId) {
                if (!(currentTripId in tripColorMap)) {
                    tripColorMap[currentTripId] = tripColors[tripColorIdx++ % tripColors.length];
                }
                const pl = L.polyline(currentSegment, {
                    color:   tripColorMap[currentTripId],
                    weight:  4,
                    opacity: 0.85,
                }).addTo(map);
                allLayers.push(pl);
            } else {
                const pl = L.polyline(currentSegment, {
                    color:   '#ef4444',
                    weight:  4,
                    opacity: 0.85,
                }).addTo(map);
                allLayers.push(pl);
            }
            currentSegment = [];
        };

        historyData.forEach(f => {
            const tripId = f.properties?.trip_id ?? null;
            const latlng = [f.geometry.coordinates[1], f.geometry.coordinates[0]];
            if (tripId !== currentTripId) {
                const lastPoint = currentSegment.length > 0 ? currentSegment[currentSegment.length - 1] : null;
                flushSegment();
                currentTripId = tripId;
                // Draw a thick red bridge between the two segments
                if (lastPoint) {
                    const bridge = L.polyline([lastPoint, latlng], {
                        color:   '#ef4444',
                        weight:  4,
                        opacity: 0.85,
                    }).addTo(map);
                    allLayers.push(bridge);
                }
            }
            currentSegment.push(latlng);
        });
        flushSegment();

        polylines['history'] = L.featureGroup(allLayers);
        if (allLayers.length > 0) map.fitBounds(polylines['history'].getBounds());

        const footer = document.getElementById('historyControls');
        if (footer) footer.style.display = 'flex';
        document.querySelector('.sidebar').classList.add('history-active');

        // Hide regular list
        document.getElementById('sidebarDeviceList').style.display = 'none';
        document.getElementById('sidebarNavRow').style.display = 'none';
        document.getElementById('sidebarUserProfile').style.display = 'none';

        // Show History Details section
        document.getElementById('sidebarHistoryDetails').style.display = 'block';

        const device = devices.find(d => d.id === deviceId);
        document.getElementById('historyDeviceName').textContent = device ? device.name : 'History Details';
        await loadTripsForHistory(deviceId, startTime, endTime);
        updatePlaybackUI();
    } catch (error) {
        console.log(error);
        showAlert({ title: 'Error', message: 'Failed to load history.', type: 'error' });
    }
}

function exitHistoryMode() {
    stopPlayback();
    if (polylines['history']) {
        polylines['history'].eachLayer(l => map.removeLayer(l));
        delete polylines['history'];
    }

    if (markers['history_pos']) {
        map.removeLayer(markers['history_pos']);
        delete markers['history_pos'];
    }
    if (sensorChart) { sensorChart.destroy(); sensorChart = null; }
    selectedSensorAttrs = new Set(['speed']);
    currentHistoryTab = 'trips';
    switchHistoryTab('trips');

    // Restore live marker when exiting history mode
    if (markers[historyDeviceId]) {
        markers[historyDeviceId].addTo(map);
    }

    // Hide history footer
    const footer = document.getElementById('historyControls');
    if (footer) footer.style.display = 'none';
    document.querySelector('.sidebar').classList.remove('history-active');

    historyTrips = [];
    const tripLabel = document.getElementById('historyTripLabel');
    if (tripLabel) tripLabel.textContent = '';
    const tripList = document.getElementById('tripListContent');
    if (tripList) tripList.innerHTML = '';
    document.getElementById('sidebarDeviceList').style.display = 'block';
    document.getElementById('sidebarNavRow').style.display = 'flex';
    document.getElementById('sidebarUserProfile').style.display = 'flex';
    document.getElementById('sidebarHistoryDetails').style.display = 'none';
}

function togglePlayback() { if (playbackInterval) stopPlayback(); else startPlayback(); }

function startPlayback() {
    if (historyData.length === 0) return;
    document.getElementById('playbackBtn').textContent = '⏸️';
    if (!markers['history_pos']) createHistoryMarker();
    playbackInterval = setInterval(() => {
        if (historyIndex >= historyData.length - 1) { stopPlayback(); return; }
        historyIndex++;
        updatePlaybackUI();
    }, 100);
}

function stopPlayback() {
    if (playbackInterval) { clearInterval(playbackInterval); playbackInterval = null; document.getElementById('playbackBtn').textContent = '▶️'; }
}

function seekHistory(value) { historyIndex = parseInt(value); stopPlayback(); updatePlaybackUI(); }

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
    const heading = p.course || 0;
    const device = devices.find(d => d.id === historyDeviceId);

    buildSensorAttrList();
    updateSensorChartCursor(historyIndex);
    document.getElementById('historySlider').value = historyIndex;
    document.getElementById('historyTimestamp').textContent = time;

    if (!markers['history_pos']) createHistoryMarker();

    const vehicle = VEHICLE_ICONS[device?.vehicle_type] || VEHICLE_ICONS['other'];
    const ignColor = p.ignition ? '#10b981' : '#ef4444';
    const historyPopup = `
        <div class="vp-popup">
            <div class="vp-header">
                <span class="vp-icon">${vehicle.emoji}</span>
                <span class="vp-name">${device?.name || 'History'}</span>
            </div>
            <div class="vp-grid">
                <span class="vp-label">Time</span>      <span class="vp-value vp-mono">${time}</span>
                <span class="vp-label">Speed</span>     <span class="vp-value">${Number(p.speed || 0).toFixed(1)} km/h</span>
                <span class="vp-label">Heading</span>   <span class="vp-value">${Number(p.course || 0).toFixed(0)}°</span>
                <span class="vp-label">Ignition</span>  <span class="vp-value" style="color:${ignColor};font-weight:700;">${p.ignition ? 'ON' : 'OFF'}</span>
                <span class="vp-label">Satellites</span><span class="vp-value">${p.satellites || 0}</span>
                <span class="vp-label">Altitude</span>  <span class="vp-value">${Number(p.altitude || 0).toFixed(0)} m</span>
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

    updatePointDetails(feature);

    // Trip label in floating controls
    const tripLabel = document.getElementById('historyTripLabel');
    const currentTrip = getCurrentTripForPoint(p.time);
    if (tripLabel) {
        if (currentTrip) {
            const tripIndex = historyTrips.length - historyTrips.indexOf(currentTrip);
            const dist = currentTrip.distance_km != null ? ` · ${currentTrip.distance_km.toFixed(1)} km` : '';
            tripLabel.textContent = `Trip ${tripIndex}${dist}`;
        } else {
            tripLabel.textContent = historyTrips.length ? 'Between trips' : '';
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

    let html = `
        <div class="detail-grid">
            <div class="detail-item"><span class="detail-key">Heading</span><div class="detail-val">${(p.course || 0).toFixed(0)}°</div></div>
            <div class="detail-item"><span class="detail-key">Speed</span><div class="detail-val">${(p.speed || 0).toFixed(1)} km/h</div></div>
            <div class="detail-item"><span class="detail-key">Lat/Lon</span><div class="detail-val">${feature.geometry.coordinates[1].toFixed(5)}, ${feature.geometry.coordinates[0].toFixed(5)}</div></div>
            <div class="detail-item"><span class="detail-key">Altitude</span><div class="detail-val">${(p.altitude || 0).toFixed(0)} m</div></div>
            <div class="detail-item"><span class="detail-key">Satellites</span><div class="detail-val">${p.satellites || 0}</div></div>
            <div class="detail-item"><span class="detail-key">Ignition</span><div class="detail-val" style="color: ${p.ignition ? 'var(--accent-success)' : 'var(--text-muted)'}">${p.ignition ? 'ON' : 'OFF'}</div></div>
        </div>
    `;
    if (p.sensors && Object.keys(p.sensors).length > 0) {
        html += '<h4 style="font-size: 0.8rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 0.5rem;">Attributes</h4>';
        html += '<table class="attr-table"><tbody>';
        Object.keys(p.sensors).sort().forEach(key => { html += `<tr><td class="attr-key">${key}</td><td class="attr-val">${p.sensors[key]}</td></tr>`; });
        html += '</tbody></table>';
    } else html += '<div style="text-align: center; color: var(--text-muted); padding: 1rem; font-size: 0.875rem;">No additional attributes</div>';
    content.innerHTML = html;
}

function createHistoryMarker() {
    const device = devices.find(d => d.id === historyDeviceId);
    const vehicleIcon = (VEHICLE_ICONS[device?.vehicle_type] || VEHICLE_ICONS['other']).emoji;
    const heading = historyData[historyIndex].properties.course || 0;
    const rotationStyle = (device?.vehicle_type === 'arrow') ?
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
        const trips = await res.json();
        historyTrips = trips;

        if (!trips.length) {
            container.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:0.5rem 0;text-align:center;">No trips detected in this period</div>';
            return;
        }

        container.innerHTML = trips.map((trip, i) => {
            const start = trip.start_time ? formatDateToLocal(trip.start_time) : '—';
            const end   = trip.end_time   ? formatDateToLocal(trip.end_time)   : 'Ongoing';
            const dist  = trip.distance_km != null ? `${trip.distance_km.toFixed(1)} km` : '—';
            const dur   = formatDuration(trip.duration_minutes);
            const from  = trip.start_address || 'Unknown start';
            const to    = trip.end_address   || (trip.end_time ? 'Unknown end' : 'In progress');
            const label = trips.length - i;
            const color = tripColorMap[trip.id] || tripColors[i % tripColors.length];

            return `
            <div class="trip-card" onclick="seekToTrip('${trip.start_time}')" title="Click to jump to this trip"
                 style="border-left: 3px solid ${color};">
                <div class="trip-card-header">
                    <span class="trip-index" style="color: ${color};">Trip ${label}</span>
                    <span class="trip-badges">
                        <span class="trip-badge">📍 ${dist}</span>
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