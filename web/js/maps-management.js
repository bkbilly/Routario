/**
 * Maps Management UI Component
 * Superadmin management for offline MBTiles maps, directory scanning, and live preview.
 */

(function () {
    'use strict';

    let _offlineMaps = [];
    let _previewMapInstance = null;
    let _previewTileLayer = null;

    function formatBytes(bytes, decimals = 1) {
        if (!+bytes) return '0 B';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    }

    function escapeHtml(str) {
        if (typeof RoutarioUI !== 'undefined' && RoutarioUI.escapeHtml) {
            return RoutarioUI.escapeHtml(str);
        }
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function showToast(message, type = 'success', duration = 3000) {
        if (typeof showAlert === 'function') {
            showAlert(message, type, duration);
        } else {
            alert(message);
        }
    }

    // ── 1. Initialization ────────────────────────────────────────────────────────

    async function initMapsSection() {
        const isAdmin = localStorage.getItem('is_admin') === 'true';
        if (!isAdmin) {
            const listContainer = document.getElementById('offlineMapsListContainer');
            if (listContainer) {
                listContainer.innerHTML = `
                    <div style="text-align:center;padding:2rem 1rem;color:var(--accent-danger);">
                        <i class="mdi mdi-shield-lock" style="font-size:24px;display:block;margin-bottom:0.5rem;"></i>
                        Super Admin privileges are required to manage offline maps.
                    </div>
                `;
            }
            return;
        }
        await loadOfflineMapsAdmin();
    }

    // ── 2. Data Loading & Rendering ─────────────────────────────────────────────

    let _mapsLoadedOnce = false;
    let _mapsLoading = false;

    async function loadOfflineMapsAdmin() {
        const listContainer = document.getElementById('offlineMapsListContainer');
        if (_mapsLoading) return;
        _mapsLoading = true;

        if (listContainer) {
            listContainer.innerHTML = `
                <div style="text-align:center;padding:1.5rem;color:var(--text-muted);">
                    <div class="loading" style="margin:0 auto 0.5rem;"></div>
                    Loading offline maps…
                </div>
            `;
        }

        try {
            const res = await apiFetch('/api/tiles/maps/admin');
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            _offlineMaps = await res.json();
            _mapsLoadedOnce = true;
            renderOfflineMapsAdmin();
        } catch (e) {
            if (listContainer) {
                listContainer.innerHTML = `
                    <div style="padding:1rem;color:var(--accent-danger);text-align:center;font-size:0.85rem;">
                        <i class="mdi mdi-alert-circle" style="font-size:1.25rem;display:block;margin-bottom:0.25rem;"></i>
                        Failed to load offline maps: ${escapeHtml(e.message)}
                    </div>
                `;
            }
        } finally {
            _mapsLoading = false;
        }
    }

    function renderOfflineMapsAdmin() {
        const listContainer = document.getElementById('offlineMapsListContainer');
        if (listContainer && !_mapsLoadedOnce && !_mapsLoading) {
            loadOfflineMapsAdmin();
            return;
        }
        filterOfflineMaps();
    }

    function filterOfflineMaps() {
        const listContainer = document.getElementById('offlineMapsListContainer');
        const badgeEl = document.getElementById('offlineMapsCountBadge');
        const searchInput = document.getElementById('mapSearch') || document.getElementById('systemSettingsSearch');
        const searchVal = (searchInput?.value || '').toLowerCase().trim();
        const isGeneralSearch = searchVal && ['map', 'maps', 'offline', 'tile', 'tiles', 'mbtile', 'mbtiles'].includes(searchVal);

        if (badgeEl) {
            badgeEl.textContent = `${_offlineMaps.length} MAP${_offlineMaps.length === 1 ? '' : 'S'}`;
        }

        if (!listContainer) return;

        const filtered = _offlineMaps.filter(m => {
            if (!searchVal || isGeneralSearch) return true;
            return (
                (m.name || '').toLowerCase().includes(searchVal) ||
                (m.filename || '').toLowerCase().includes(searchVal) ||
                (m.description || '').toLowerCase().includes(searchVal) ||
                (m.format || '').toLowerCase().includes(searchVal)
            );
        });

        if (filtered.length === 0) {
            listContainer.innerHTML = `
                <div style="text-align:center;padding:2rem 1rem;color:var(--text-muted);">
                    <i class="mdi mdi-map-plus" style="font-size:2rem;color:var(--text-secondary);opacity:0.6;display:block;margin-bottom:0.5rem;"></i>
                    <div style="font-weight:600;font-size:0.9rem;color:var(--text-primary);margin-bottom:0.25rem;">
                        ${_offlineMaps.length === 0 ? 'No offline maps installed yet' : 'No matching maps found'}
                    </div>
                    <div style="font-size:0.78rem;color:var(--text-muted);line-height:1.4;">
                        ${_offlineMaps.length === 0 ? 'Click <strong>Upload Map</strong> below or place <code>.mbtiles</code> files into <code>data/tiles/</code>.' : 'Try adjusting your search query.'}
                    </div>
                </div>
            `;
            return;
        }

        listContainer.innerHTML = filtered.map(m => {
            const isRaster = (m.format || '').toLowerCase() !== 'pbf';
            const formatBadge = isRaster
                ? `<span class="system-setting-badge" style="background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);font-size:0.68rem;">Raster ${escapeHtml(m.format.toUpperCase())}</span>`
                : `<span class="system-setting-badge" style="background:rgba(59,130,246,0.15);color:var(--accent-primary);border:1px solid rgba(59,130,246,0.3);font-size:0.68rem;">Vector PBF</span>`;

            const ctype = (m.container_type || 'mbtiles').toLowerCase();
            const ctypeLabels = {
                'mbtiles': 'MBTiles',
                'pmtiles': 'PMTiles',
                'gpkg': 'GeoPackage',
                'zip': 'Zip XYZ',
            };
            const containerBadge = `<span class="system-setting-badge" style="background:rgba(99,102,241,0.15);color:#818cf8;border:1px solid rgba(99,102,241,0.3);font-size:0.68rem;">${escapeHtml(ctypeLabels[ctype] || ctype.toUpperCase())}</span>`;

            const defaultBadge = m.is_default
                ? `<span class="system-setting-badge" style="background:rgba(245,158,11,0.18);color:#f59e0b;border:1px solid rgba(245,158,11,0.4);font-size:0.68rem;"><i class="mdi mdi-star"></i> Default</span>`
                : '';

            const zoomText = (m.min_zoom !== null && m.max_zoom !== null)
                ? `z${m.min_zoom}–z${m.max_zoom}`
                : 'All Zooms';

            return `
                <div class="system-setting-item" style="padding:0.75rem 0;border-bottom:1px solid rgba(255,255,255,0.06);">
                    <div class="system-setting-label-row">
                        <div style="display:flex;align-items:center;gap:0.45rem;min-width:0;flex:1;">
                            <i class="mdi mdi-map-outline" style="color:var(--accent-primary);font-size:1.1rem;flex-shrink:0;"></i>
                            <span class="system-setting-label" style="font-size:0.92rem;font-weight:700;word-break:break-word;">
                                ${escapeHtml(m.name)}
                            </span>
                            ${defaultBadge}
                        </div>
                        <label class="ticket-switch" style="flex-shrink:0;" title="${m.enabled ? 'Active in map picker' : 'Disabled'}">
                            <input type="checkbox" ${m.enabled ? 'checked' : ''} onchange="toggleOfflineMapEnabled('${escapeHtml(m.id)}', this.checked)">
                            <span class="ticket-switch-track"></span>
                            <span class="ticket-switch-status" style="font-size:0.76rem;color:var(--text-secondary);">${m.enabled ? 'Active' : 'Off'}</span>
                        </label>
                    </div>

                    <div class="system-setting-desc" style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;margin:0.25rem 0;">
                        <code style="font-size:0.76rem;background:var(--bg-tertiary);padding:1px 5px;border-radius:4px;color:var(--text-secondary);">${escapeHtml(m.filename)}</code>
                        <span>•</span>
                        <span>${formatBytes(m.size_bytes)}</span>
                        <span>•</span>
                        <span>${zoomText}</span>
                        <span>•</span>
                        ${containerBadge}
                        ${formatBadge}
                    </div>

                    ${m.description ? `<div style="font-size:0.76rem;color:var(--text-muted);margin-bottom:0.35rem;line-height:1.35;">${escapeHtml(m.description)}</div>` : ''}

                    <div style="display:flex;align-items:center;justify-content:flex-end;gap:0.4rem;margin-top:0.35rem;">
                        ${!m.is_default ? `
                            <button type="button" class="btn btn-secondary" onclick="setOfflineMapDefault('${escapeHtml(m.id)}')" style="font-size:0.74rem;padding:0.25rem 0.55rem;">
                                <i class="mdi mdi-star-outline"></i> Set Default
                            </button>
                        ` : ''}
                        <button type="button" class="btn btn-secondary" onclick="previewOfflineMap('${escapeHtml(m.id)}')" style="font-size:0.74rem;padding:0.25rem 0.55rem;" title="Preview on live map">
                            <i class="mdi mdi-eye"></i> Preview
                        </button>
                        <button type="button" class="btn btn-secondary" onclick="openEditMapModal('${escapeHtml(m.id)}')" style="font-size:0.74rem;padding:0.25rem 0.55rem;" title="Edit details">
                            <i class="mdi mdi-pencil"></i> Edit
                        </button>
                        <button type="button" class="btn btn-secondary" onclick="deleteOfflineMap('${escapeHtml(m.id)}')" style="font-size:0.74rem;padding:0.25rem 0.55rem;color:var(--accent-danger);border-color:rgba(239,68,68,0.3);" title="Delete map">
                            <i class="mdi mdi-delete"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    // ── 3. Scan Server Directory ────────────────────────────────────────────────

    async function scanOfflineMaps() {
        const scanBtn = document.querySelector('button[onclick="scanOfflineMaps()"]');
        const origHtml = scanBtn ? scanBtn.innerHTML : '';
        if (scanBtn) {
            scanBtn.disabled = true;
            scanBtn.innerHTML = `<i class="mdi mdi-loading mdi-spin"></i> Scanning…`;
        }

        try {
            const res = await apiFetch('/api/tiles/maps/scan', { method: 'POST' });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            _offlineMaps = await res.json();
            renderOfflineMapsAdmin();
            showToast(`Directory scanned successfully (${_offlineMaps.length} map${_offlineMaps.length === 1 ? '' : 's'} available)`);
        } catch (e) {
            showToast(`Scan failed: ${e.message}`, 'error');
        } finally {
            if (scanBtn) {
                scanBtn.disabled = false;
                scanBtn.innerHTML = origHtml;
            }
        }
    }

    // ── 4. Toggle & Default Actions ─────────────────────────────────────────────

    async function toggleOfflineMapEnabled(mapId, enabled) {
        try {
            const res = await apiFetch(`/api/tiles/maps/${encodeURIComponent(mapId)}`, {
                method: 'PATCH',
                body: JSON.stringify({ enabled })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            const updated = await res.json();
            const idx = _offlineMaps.findIndex(m => m.id === mapId);
            if (idx !== -1) _offlineMaps[idx] = updated;
            renderOfflineMapsAdmin();
            showToast(`Map "${updated.name}" ${enabled ? 'enabled' : 'disabled'}`);
        } catch (e) {
            showToast(`Failed to update map: ${e.message}`, 'error');
            await loadOfflineMapsAdmin();
        }
    }

    async function setOfflineMapDefault(mapId) {
        try {
            const res = await apiFetch(`/api/tiles/maps/${encodeURIComponent(mapId)}`, {
                method: 'PATCH',
                body: JSON.stringify({ is_default: true, enabled: true })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            showToast('Default offline map updated');
            await loadOfflineMapsAdmin();
        } catch (e) {
            showToast(`Failed to set default map: ${e.message}`, 'error');
        }
    }

    // ── 5. Edit Modal ───────────────────────────────────────────────────────────

    function openEditMapModal(mapId) {
        const map = _offlineMaps.find(m => m.id === mapId);
        if (!map) return;

        document.getElementById('editMapId').value = map.id;
        document.getElementById('editMapName').value = map.name || '';
        document.getElementById('editMapDescription').value = map.description || '';
        document.getElementById('editMapEnabled').checked = !!map.enabled;
        document.getElementById('editMapDefault').checked = !!map.is_default;

        document.getElementById('editMapFilename').textContent = map.filename;
        document.getElementById('editMapSize').textContent = formatBytes(map.size_bytes);
        document.getElementById('editMapFormat').textContent = `${(map.container_type || 'mbtiles').toUpperCase()} • ${map.format.toUpperCase()}`;
        document.getElementById('editMapZoom').textContent = (map.min_zoom !== null && map.max_zoom !== null)
            ? `z${map.min_zoom} – z${map.max_zoom}`
            : 'Unspecified';
        document.getElementById('editMapUrl').textContent = map.tile_url;

        const modal = document.getElementById('editMapModal');
        if (modal) {
            modal.classList.add('active');
            modal.classList.add('open');
        }
    }

    function closeEditMapModal() {
        const modal = document.getElementById('editMapModal');
        if (modal) {
            modal.classList.remove('active');
            modal.classList.remove('open');
        }
    }

    async function saveEditMapModal() {
        const mapId = document.getElementById('editMapId').value;
        const name = document.getElementById('editMapName').value.trim();
        const description = document.getElementById('editMapDescription').value.trim();
        const enabled = document.getElementById('editMapEnabled').checked;
        const isDefault = document.getElementById('editMapDefault').checked;

        if (!name) {
            showToast('Map name cannot be empty', 'error');
            return;
        }

        const saveBtn = document.getElementById('saveEditMapBtn');
        if (saveBtn) saveBtn.disabled = true;

        try {
            const res = await apiFetch(`/api/tiles/maps/${encodeURIComponent(mapId)}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    name,
                    description,
                    enabled,
                    is_default: isDefault
                })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            const updated = await res.json();
            const idx = _offlineMaps.findIndex(m => m.id === mapId);
            if (idx !== -1) _offlineMaps[idx] = updated;
            closeEditMapModal();
            renderOfflineMapsAdmin();
            showToast(`Map "${updated.name}" updated successfully`);
        } catch (e) {
            showToast(`Failed to update map: ${e.message}`, 'error');
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    // ── 6. Delete Action ────────────────────────────────────────────────────────

    async function deleteOfflineMap(mapId) {
        const map = _offlineMaps.find(m => m.id === mapId);
        if (!map) return;

        const confirmed = confirm(`Are you sure you want to permanently delete the offline map "${map.name}" (${map.filename}, ${formatBytes(map.size_bytes)})?\n\nThis will remove the file from the server.`);
        if (!confirmed) return;

        try {
            const res = await apiFetch(`/api/tiles/maps/${encodeURIComponent(mapId)}`, {
                method: 'DELETE'
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || `HTTP ${res.status}`);
            }
            _offlineMaps = _offlineMaps.filter(m => m.id !== mapId);
            renderOfflineMapsAdmin();
            showToast(`Map "${map.name}" deleted successfully`);
        } catch (e) {
            showToast(`Failed to delete map: ${e.message}`, 'error');
        }
    }

    // ── 7. Upload Modal & Streaming ─────────────────────────────────────────────

    function initDropzone() {
        const dropzone = document.querySelector('.map-dropzone');
        if (!dropzone || dropzone._dropzoneBound) return;
        dropzone._dropzoneBound = true;
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.style.borderColor = 'var(--accent-primary)';
            dropzone.style.background = 'var(--bg-hover)';
        });
        dropzone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dropzone.style.borderColor = 'var(--border-color)';
            dropzone.style.background = 'var(--bg-tertiary)';
        });
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.style.borderColor = 'var(--border-color)';
            dropzone.style.background = 'var(--bg-tertiary)';
            const files = e.dataTransfer?.files;
            if (files && files.length > 0) {
                const fileInput = document.getElementById('uploadMapFileInput');
                if (fileInput) {
                    fileInput.files = files;
                    handleMapFileSelected({ target: fileInput });
                }
            }
        });
    }

    function openUploadMapModal() {
        const modal = document.getElementById('uploadMapModal');
        if (!modal) {
            console.error('[OfflineTiles] uploadMapModal element not found');
            return;
        }

        // Reset fields
        const fileInput = document.getElementById('uploadMapFileInput');
        if (fileInput) fileInput.value = '';
        const nameInput = document.getElementById('uploadMapNameInput');
        if (nameInput) nameInput.value = '';
        const descInput = document.getElementById('uploadMapDescInput');
        if (descInput) descInput.value = '';
        const enabledInput = document.getElementById('uploadMapEnabledInput');
        if (enabledInput) enabledInput.checked = true;
        const defaultInput = document.getElementById('uploadMapDefaultInput');
        if (defaultInput) defaultInput.checked = false;

        const dropzoneText = document.getElementById('uploadDropzoneText');
        if (dropzoneText) dropzoneText.textContent = 'Drag & drop your .mbtiles, .pmtiles, .gpkg, or .zip file here, or click to browse';

        const progressContainer = document.getElementById('uploadMapProgressContainer');
        const progressBar = document.getElementById('uploadMapProgressBar');
        const progressPercent = document.getElementById('uploadMapProgressPercent');
        const progressStatus = document.getElementById('uploadMapProgressStatus');
        const uploadBtn = document.getElementById('confirmUploadMapBtn');

        if (progressContainer) progressContainer.style.display = 'none';

        const uploadBtnEl = document.getElementById('confirmUploadMapBtn');
        if (uploadBtnEl) {
            uploadBtnEl.disabled = false;
            uploadBtnEl.innerHTML = `<i class="mdi mdi-upload"></i> Upload Map`;
        }

        initDropzone();

        modal.classList.add('active');
        modal.classList.add('open');
    }

    function closeUploadMapModal() {
        const modal = document.getElementById('uploadMapModal');
        if (modal) {
            modal.classList.remove('active');
            modal.classList.remove('open');
        }
    }

    function handleMapFileSelected(event) {
        const file = event.target.files?.[0];
        if (!file) return;

        const dropzoneText = document.getElementById('uploadDropzoneText');
        if (dropzoneText) {
            dropzoneText.innerHTML = `<strong>${escapeHtml(file.name)}</strong> (${formatBytes(file.size)})`;
        }

        const nameInput = document.getElementById('uploadMapNameInput');
        if (nameInput && !nameInput.value.trim()) {
            const cleanName = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            nameInput.value = cleanName;
        }
    }

    async function handleUploadMapSubmit(event) {
        if (event) event.preventDefault();

        const fileInput = document.getElementById('uploadMapFileInput');
        const file = fileInput?.files?.[0];
        if (!file) {
            showToast('Please select a map file to upload (.mbtiles, .pmtiles, .gpkg, .zip)', 'error');
            return;
        }

        const allowed = ['.mbtiles', '.pmtiles', '.gpkg', '.zip'];
        const lower = file.name.toLowerCase();
        if (!allowed.some(ext => lower.endsWith(ext))) {
            showToast('Supported formats: .mbtiles, .pmtiles, .gpkg, .zip', 'error');
            return;
        }

        const name = document.getElementById('uploadMapNameInput').value.trim();
        const description = document.getElementById('uploadMapDescInput').value.trim();
        const enabled = document.getElementById('uploadMapEnabledInput').checked;
        const isDefault = document.getElementById('uploadMapDefaultInput').checked;

        const progressContainer = document.getElementById('uploadMapProgressContainer');
        const progressBar = document.getElementById('uploadMapProgressBar');
        const progressPercent = document.getElementById('uploadMapProgressPercent');
        const progressStatus = document.getElementById('uploadMapProgressStatus');
        const uploadBtn = document.getElementById('confirmUploadMapBtn');

        if (progressContainer) progressContainer.style.display = 'block';
        if (uploadBtn) {
            uploadBtn.disabled = true;
            uploadBtn.innerHTML = `<i class="mdi mdi-loading mdi-spin"></i> Uploading…`;
        }

        const formData = new FormData();
        formData.append('file', file);
        if (name) formData.append('name', name);
        if (description) formData.append('description', description);
        formData.append('enabled', enabled ? 'true' : 'false');
        formData.append('is_default', isDefault ? 'true' : 'false');

        // Use XMLHttpRequest for accurate upload progress reporting
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/tiles/maps/upload', true);

        const token = localStorage.getItem('auth_token');
        if (token) {
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        }

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                if (progressBar) progressBar.style.width = `${percent}%`;
                if (progressPercent) progressPercent.textContent = `${percent}%`;
                if (progressStatus) progressStatus.textContent = `Uploading ${formatBytes(e.loaded)} of ${formatBytes(e.total)}…`;
            }
        };

        xhr.onload = async () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                if (progressStatus) progressStatus.textContent = 'Processing and indexing tileset…';
                try {
                    const result = JSON.parse(xhr.responseText);
                    showToast(`Offline map "${result.name}" uploaded successfully!`);
                    closeUploadMapModal();
                    await loadOfflineMapsAdmin();
                } catch (e) {
                    showToast('Upload finished, refreshing map list…');
                    closeUploadMapModal();
                    await loadOfflineMapsAdmin();
                }
            } else {
                let errorMsg = `Upload failed (HTTP ${xhr.status})`;
                try {
                    const resJson = JSON.parse(xhr.responseText);
                    if (resJson.detail) errorMsg = resJson.detail;
                } catch (e) {}
                showToast(errorMsg, 'error');
                if (uploadBtn) {
                    uploadBtn.disabled = false;
                    uploadBtn.innerHTML = `<i class="mdi mdi-upload"></i> Try Again`;
                }
                if (progressStatus) progressStatus.textContent = errorMsg;
            }
        };

        xhr.onerror = () => {
            showToast('Network error during upload', 'error');
            if (uploadBtn) {
                uploadBtn.disabled = false;
                uploadBtn.innerHTML = `<i class="mdi mdi-upload"></i> Try Again`;
            }
            if (progressStatus) progressStatus.textContent = 'Network error occurred.';
        };

        xhr.send(formData);
    }

    // ── 8. Map Live Preview Modal ───────────────────────────────────────────────

    function previewOfflineMap(mapId) {
        const map = _offlineMaps.find(m => m.id === mapId);
        if (!map) return;

        const modal = document.getElementById('previewMapModal');
        const titleEl = document.getElementById('previewMapTitle');
        const container = document.getElementById('previewMapContainer');

        if (titleEl) titleEl.textContent = `Preview: ${map.name} (${map.format.toUpperCase()})`;
        if (modal) {
            modal.classList.add('active');
            modal.classList.add('open');
        }

        setTimeout(() => {
            if (!_previewMapInstance && container && typeof L !== 'undefined') {
                _previewMapInstance = L.map(container, {
                    zoomControl: true,
                    attributionControl: true
                });
            }

            if (_previewMapInstance) {
                if (_previewTileLayer) {
                    _previewMapInstance.removeLayer(_previewTileLayer);
                }

                _previewTileLayer = L.tileLayer(map.tile_url, {
                    minZoom: map.min_zoom ?? 0,
                    maxZoom: map.max_zoom ?? 18,
                    attribution: `© ${escapeHtml(map.name)}`,
                    crossOrigin: true
                }).addTo(_previewMapInstance);

                _previewMapInstance.invalidateSize();

                // Center view
                if (map.bounds && map.bounds.length === 4) {
                    // bounds: [min_lon, min_lat, max_lon, max_lat]
                    const southWest = L.latLng(map.bounds[1], map.bounds[0]);
                    const northEast = L.latLng(map.bounds[3], map.bounds[2]);
                    _previewMapInstance.fitBounds(L.latLngBounds(southWest, northEast));
                } else if (map.center && map.center.length >= 2) {
                    // center: [lon, lat, zoom]
                    _previewMapInstance.setView([map.center[1], map.center[0]], map.center[2] || 12);
                } else {
                    _previewMapInstance.setView([37.9838, 23.7275], 5);
                }
            }
        }, 150);
    }

    function closePreviewMapModal() {
        const modal = document.getElementById('previewMapModal');
        if (modal) {
            modal.classList.remove('active');
            modal.classList.remove('open');
        }
        if (_previewTileLayer && _previewMapInstance) {
            _previewMapInstance.removeLayer(_previewTileLayer);
            _previewTileLayer = null;
        }
    }

    // Close active offline map modals on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const uploadModal = document.getElementById('uploadMapModal');
        if (uploadModal && (uploadModal.classList.contains('active') || uploadModal.classList.contains('open'))) {
            closeUploadMapModal();
        }
        const editModal = document.getElementById('editMapModal');
        if (editModal && (editModal.classList.contains('active') || editModal.classList.contains('open'))) {
            closeEditMapModal();
        }
        const previewModal = document.getElementById('previewMapModal');
        if (previewModal && (previewModal.classList.contains('active') || previewModal.classList.contains('open'))) {
            closePreviewMapModal();
        }
    });

    function getOfflineMapsCardHtml(query = '') {
        const q = (query || '').toLowerCase().trim();
        if (q) {
            const matchesCategory = 'offline map layers mbtiles maps geocoding routing'.includes(q) || q.includes('map') || q.includes('tile') || q.includes('offline');
            const matchesAnyMap = _offlineMaps && _offlineMaps.some(m =>
                (m.name || '').toLowerCase().includes(q) ||
                (m.filename || '').toLowerCase().includes(q) ||
                (m.description || '').toLowerCase().includes(q) ||
                (m.format || '').toLowerCase().includes(q)
            );
            if (!matchesCategory && !matchesAnyMap) return null;
        }

        return `
            <div class="system-category-card" id="sysCard_offline_maps">
                <div class="system-category-header" style="justify-content: space-between; align-items: center;">
                    <div style="display: flex; align-items: center; gap: 0.6rem;">
                        <div class="system-category-icon" style="background: rgba(16, 185, 129, 0.12); color: #10b981;">
                            <i class="mdi mdi-map-legend"></i>
                        </div>
                        <div class="system-category-title">Offline Map Layers</div>
                    </div>
                    <span id="offlineMapsCountBadge" class="system-setting-badge" style="background: rgba(16, 185, 129, 0.12); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); font-size: 0.72rem;"></span>
                </div>
                <div class="system-setting-desc" style="margin-top:-0.35rem; line-height: 1.4;">
                    Self-hosted offline maps served directly from local <code style="font-size:0.76rem;background:var(--bg-tertiary);padding:1px 5px;border-radius:4px;color:var(--text-secondary);">data/tiles/</code> (.mbtiles, .pmtiles, .gpkg, .zip) without external services.
                </div>
                <div id="offlineMapsListContainer" style="display: flex; flex-direction: column;">
                    <div style="text-align:center;padding:1.5rem;color:var(--text-muted);">
                        <div class="loading" style="margin:0 auto 0.5rem;"></div>
                        Loading offline maps…
                    </div>
                </div>
                <div style="margin-top:auto;padding-top:0.85rem;border-top:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between;gap:0.5rem;flex-wrap:wrap;">
                    <button type="button" class="btn btn-secondary" onclick="scanOfflineMaps()" style="font-size:0.82rem;" title="Scan data/tiles/ on the server for newly placed .mbtiles files">
                        <i class="mdi mdi-folder-sync"></i> Scan Server
                    </button>
                    <button type="button" class="btn btn-primary" onclick="openUploadMapModal()" style="font-size:0.82rem;">
                        <i class="mdi mdi-upload"></i> Upload Map
                    </button>
                </div>
            </div>
        `;
    }

    // ── Export to window ────────────────────────────────────────────────────────
    window.initMapsSection = initMapsSection;
    window.getOfflineMapsCardHtml = getOfflineMapsCardHtml;
    window.loadOfflineMapsAdmin = loadOfflineMapsAdmin;
    window.renderOfflineMapsAdmin = renderOfflineMapsAdmin;
    window.filterOfflineMaps = filterOfflineMaps;
    window.scanOfflineMaps = scanOfflineMaps;
    window.toggleOfflineMapEnabled = toggleOfflineMapEnabled;
    window.setOfflineMapDefault = setOfflineMapDefault;
    window.openUploadMapModal = openUploadMapModal;
    window.closeUploadMapModal = closeUploadMapModal;
    window.handleMapFileSelected = handleMapFileSelected;
    window.handleUploadMapSubmit = handleUploadMapSubmit;
    window.openEditMapModal = openEditMapModal;
    window.closeEditMapModal = closeEditMapModal;
    window.saveEditMapModal = saveEditMapModal;
    window.deleteOfflineMap = deleteOfflineMap;
    window.previewOfflineMap = previewOfflineMap;
    window.closePreviewMapModal = closePreviewMapModal;
})();
