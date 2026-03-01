/**
 * dashboard-state.js
 * Shared global state for the dashboard.
 * All other dashboard modules read/write these variables.
 */

// ── Core State ────────────────────────────────────────────────────────────────
let map = null;
let currentTileLayer = null;
let devices = [];
let markers = {};
let polylines = {};
let selectedDevice = null;
let currentUser = null;
let ws = null;

// ── Sorting ───────────────────────────────────────────────────────────────────
let currentSort = 'name';

// ── Alerts ────────────────────────────────────────────────────────────────────
let loadedAlerts = [];

// ── History ───────────────────────────────────────────────────────────────────
let historyDeviceId = null;
let historyData = [];
let historyTrips = [];
let historyIndex = 0;
let playbackInterval = null;
let currentHistoryTab = 'trips';
let sensorChart = null;
let selectedSensorAttrs = new Set(['speed']);
let tripColorMap = {}; // trip_id → color, shared between loadHistory and loadTripsForHistory

// ── Marker animations ─────────────────────────────────────────────────────────
let markerAnimations = {};