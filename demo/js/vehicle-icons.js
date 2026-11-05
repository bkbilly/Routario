const VEHICLE_ICONS = {
    // ── Arrows (SVG on map, colored triangle emoji everywhere else) ──
    arrow:        { label: 'Arrow (blue)',    arrow: true, color: '#3b82f6', emoji: '🔵', offset: 0 },
    arrow_red:    { label: 'Arrow (red)',     arrow: true, color: '#ef4444', emoji: '🔴', offset: 0 },
    arrow_green:  { label: 'Arrow (green)',   arrow: true, color: '#22c55e', emoji: '🟢', offset: 0 },
    arrow_yellow: { label: 'Arrow (yellow)',  arrow: true, color: '#eab308', emoji: '🟡', offset: 0 },
    arrow_purple: { label: 'Arrow (purple)',  arrow: true, color: '#a855f7', emoji: '🟣', offset: 0 },
    arrow_orange: { label: 'Arrow (orange)',  arrow: true, color: '#f97316', emoji: '🟠', offset: 0 },
    arrow_white:  { label: 'Arrow (white)',   arrow: true, color: '#f1f5f9', emoji: '⚪', offset: 0 },

    // ── Emoji vehicles ────────────────────────────────────────────
    car:          { label: 'Car',             emoji: '🚗',  offset:  90 },
    motorcycle:   { label: 'Motorcycle',      emoji: '🏍️',  offset:  90 },
    truck:        { label: 'Truck',           emoji: '🚛',  offset:  90 },
    tractor:      { label: 'Tractor',         emoji: '🚜',  offset:  90 },
    van:          { label: 'Van',             emoji: '🚐',  offset:  90 },
    bus:          { label: 'Bus',             emoji: '🚌',  offset:  90 },
    animal:       { label: 'Animal',          emoji: '🐾',  offset:   5 },
    person:       { label: 'Personal Tracker',emoji: '🚶',  offset:   0 },
    bicycle:      { label: 'Bicycle',         emoji: '🚲',  offset:  90 },
    scooter:      { label: 'Scooter',         emoji: '🛴',  offset:  90 },
    rocket:       { label: 'Rocket',          emoji: '🚀',  offset: -45 },
    airplane:     { label: 'Airplane',        emoji: '✈️',  offset: -45 },
    helicopter:   { label: 'Helicopter',      emoji: '🚁',  offset:  90 },
    boat:         { label: 'Boat',            emoji: '🛥️',  offset:  90 },
    steam_train:  { label: 'Train',           emoji: '🚂',  offset:  90 },
    other:        { label: 'Other',           emoji: '📍',  offset:   0 },

};

/**
 * Populate a <select> element with all vehicle types.
 * Arrow variants are grouped under an <optgroup>.
 * @param {HTMLSelectElement} selectEl  - the <select> to fill
 * @param {string}            [current] - pre-selected value
 */
function populateVehicleTypeSelect(selectEl, current) {
    selectEl.innerHTML = '';

    const arrowGroup  = document.createElement('optgroup');
    arrowGroup.label  = '▲ Arrows';
    const vehicleGroup = document.createElement('optgroup');
    vehicleGroup.label = 'Vehicles';

    Object.entries(VEHICLE_ICONS).forEach(([key, cfg]) => {
        const opt = document.createElement('option');
        opt.value       = key;
        opt.textContent = `${cfg.emoji}  ${cfg.label}`;
        if (key === current) opt.selected = true;
        (cfg.arrow ? arrowGroup : vehicleGroup).appendChild(opt);
    });

    selectEl.appendChild(arrowGroup);
    selectEl.appendChild(vehicleGroup);
}

/**
 * Build the HTML string for a Leaflet divIcon marker.
 * Arrow color comes from the VEHICLE_ICONS entry — no extra parameter needed.
 * @param {string}  type       - vehicle_type key (falls back to 'other')
 * @param {boolean} ignitionOn - reserved for future use
 * @param {number}  [heading]  - course in degrees (0 = north)
 */
function getMarkerHtml(type, ignitionOn, heading = null) {
    const cfg = VEHICLE_ICONS[type] || VEHICLE_ICONS['other'];
    let iconContent;

    if (cfg.arrow) {
        const color = cfg.color || '#3b82f6';
        if (heading != null) {
            iconContent = `
                <svg class="marker-svg" width="32" height="32" viewBox="0 0 24 24" fill="none"
                     xmlns="http://www.w3.org/2000/svg"
                     style="transform:rotate(${heading}deg);filter:drop-shadow(0px 2px 2px rgba(0,0,0,0.5));">
                    <path d="M12 2L4.5 20.29L5.21 21L12 18L18.79 21L19.5 20.29L12 2Z"
                          fill="${color}" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
                </svg>`;
        } else {
            iconContent = `
                <svg class="marker-svg" width="32" height="32" viewBox="0 0 24 24" fill="none"
                     xmlns="http://www.w3.org/2000/svg"
                     style="filter:drop-shadow(0px 2px 2px rgba(0,0,0,0.5));">
                    <circle cx="12" cy="12" r="9" fill="${color}" stroke="white" stroke-width="1.5"/>
                    <circle cx="12" cy="12" r="3" fill="white"/>
                </svg>`;
        }
    } else {
        const rotation = heading != null ? heading + cfg.offset : 0;
        iconContent = `<div class="marker-svg" style="font-size:28px;transform:rotate(${rotation}deg);display:inline-block;">${cfg.emoji}</div>`;
    }

    return `<div class="marker-container" style="position:relative;display:flex;align-items:center;justify-content:center;">${iconContent}</div>`;
}
