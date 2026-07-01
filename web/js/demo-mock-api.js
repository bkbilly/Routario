'use strict';

(() => {
    window.ROUTARIO_DEMO = true;
    window.initPWA = async function initPWA() { return null; };
    window.enablePushNotifications = async function enablePushNotifications() { return false; };

    class DemoWebSocket extends EventTarget {
        constructor() {
            super();
            this.readyState = DemoWebSocket.CONNECTING;
            setTimeout(() => {
                this.readyState = DemoWebSocket.OPEN;
                this.onopen?.({ type: 'open' });
                this.dispatchEvent(new Event('open'));
            }, 25);
        }
        send() {}
        close() {
            this.readyState = DemoWebSocket.CLOSED;
            this.onclose?.({ type: 'close', reason: 'demo' });
            this.dispatchEvent(new Event('close'));
        }
    }
    DemoWebSocket.CONNECTING = 0;
    DemoWebSocket.OPEN = 1;
    DemoWebSocket.CLOSING = 2;
    DemoWebSocket.CLOSED = 3;
    window.WebSocket = DemoWebSocket;

    const DEMO_USER = {
        id: 1,
        username: 'demo',
        email: 'demo@routario.local',
        is_admin: true,
        is_company_admin: true,
        company_id: null,
        units: 'metric',
        currency: 'EUR',
        timezone: 'Europe/Athens',
        notification_channels: [
            { name: 'Ops Email', url: 'mailto:ops@example.com' },
            { name: 'Dispatch Slack', url: 'slack://demo/webhook' },
        ],
        permissions: [
            'view_management', 'view_devices', 'edit_devices', 'manage_alerts',
            'manage_geofences', 'view_history', 'view_reports', 'manage_routes',
            'manage_users', 'manage_integrations', 'send_commands', 'view_audit',
            'view_health', 'manage_backups',
        ],
    };

    const now = new Date();
    const iso = minutesAgo => new Date(now.getTime() - minutesAgo * 60000).toISOString();
    const devices = [
        {
            id: 1, name: 'Athens Van 12', imei: 'demo-0001', protocol: 'teltonika',
            vehicle_type: 'van', license_plate: 'ATH-1201', company_id: null,
            supports_commands: true, is_active: true,
            custom_attributes: { department: 'Operations' },
            config: {
                offline_timeout_hours: 24,
                trip_merge_gap_minutes: 5,
                alert_rows: [
                    { alertKey: 'speed_tolerance', params: { overspeed_percent: 10, duration_seconds: 30 }, channels: ['Ops Email'], schedule: null, notify_user_ids: [1] },
                    { alertKey: 'offline_detection', params: { timeout_hours: 4 }, channels: ['Dispatch Slack'], schedule: null, notify_user_ids: [1] },
                ],
                alert_channels: { speed_tolerance: ['Ops Email'], offline_detection: ['Dispatch Slack'] },
            },
            state: {
                device_id: 1, last_latitude: 37.9838, last_longitude: 23.7275, last_speed: 38,
                last_course: 84, ignition_on: true, is_online: true, total_odometer: 24819.4,
                last_altitude: 84, satellites: 12,
                last_update: iso(3), current_driver: { id: 1, name: 'Nikos Demo' },
                sensors: { ignition: true, fuel_level: 62, battery_voltage: 12.7, last_known_satellites: 12, last_gps_time: iso(3), accuracy: 12 },
            },
        },
        {
            id: 2, name: 'Piraeus Truck 4', imei: 'demo-0002', protocol: 'gt06',
            vehicle_type: 'truck', license_plate: 'PIR-4040', company_id: null,
            supports_commands: false, is_active: true,
            custom_attributes: { department: 'Logistics' },
            config: {
                offline_timeout_hours: 24,
                trip_merge_gap_minutes: 10,
                alert_rows: [
                    { alertKey: 'idle_timeout_minutes', params: { timeout_minutes: 12, speed_threshold: 2 }, channels: ['Ops Email'], schedule: null, notify_user_ids: [1] },
                ],
                alert_channels: { idle_timeout_minutes: ['Ops Email'] },
            },
            state: {
                device_id: 2, last_latitude: 37.942, last_longitude: 23.646, last_speed: 0,
                last_course: 182, ignition_on: false, is_online: true, total_odometer: 88120.8,
                last_altitude: 26, satellites: 10,
                last_update: iso(8), current_driver: { id: 2, name: 'Maria Demo' },
                sensors: { ignition: false, fuel_level: 44, temperature: 21, last_known_satellites: 10, last_gps_time: iso(8), accuracy: 18 },
            },
        },
        {
            id: 3, name: 'Thessaloniki Car 7', imei: 'demo-0003', protocol: 'osmand',
            vehicle_type: 'car', license_plate: 'SKG-7007', company_id: null,
            supports_commands: false, is_active: true,
            custom_attributes: { department: 'Sales' },
            config: { offline_timeout_hours: 12, trip_merge_gap_minutes: 0, alert_rows: [], alert_channels: {} },
            state: {
                device_id: 3, last_latitude: 40.6401, last_longitude: 22.9444, last_speed: 74,
                last_course: 31, ignition_on: true, is_online: false, total_odometer: 15790.2,
                last_altitude: 32, satellites: 9,
                last_update: iso(95), current_driver: null,
                sensors: { ignition: true, battery_voltage: 12.3, last_known_satellites: 9, last_gps_time: iso(95), accuracy: 22 },
            },
        },
    ];

    const users = [
        DEMO_USER,
        { id: 2, username: 'dispatcher', email: 'dispatch@routario.local', is_admin: false, is_company_admin: false, company_id: null, permissions: ['view_reports', 'view_devices'], units: 'metric', currency: 'EUR' },
    ];
    const drivers = [
        { id: 1, name: 'Nikos Demo', phone: '+30 210 000 1001', license_number: 'DEMO-A1', assigned_device_id: 1 },
        { id: 2, name: 'Maria Demo', phone: '+30 210 000 1002', license_number: 'DEMO-B2', assigned_device_id: 2 },
    ];
    let voiceMessages = [
        { id: 1, sender_id: 2, sender_name: 'dispatcher', recipient_ids: [1], created_at: iso(18), duration_seconds: 7, is_read: false },
        { id: 2, sender_id: 1, sender_name: 'demo', recipient_ids: [], created_at: iso(95), duration_seconds: 4, is_read: true },
    ];
    let schedules = [
        {
            id: 1, name: 'Weekly fleet summary', report_type: 'summary',
            filter_device_ids: [], filter_user_ids: [], options: {},
            notification_channels: ['Ops Email'], attach_results: true, attach_documents: false,
            sensors_historical: false, date_range: 'last_7_days', frequency: 'weekly',
            run_time: '07:00', day_of_week: 1, day_of_month: 1, timezone: 'Europe/Athens',
            keep_runs: 10, is_active: true, next_run: iso(-1200), run_count: 2,
        },
    ];

    const reportDefs = [
        { key: 'summary', label: 'Fleet Summary', description: 'Totals per vehicle for the selected period.', renderer: 'summary', needs_date_range: true, supports_vehicle_filter: true, schedule_supported: true },
        { key: 'trips', label: 'Trips', description: 'Trip list with distance, duration, and speed.', renderer: 'table', needs_date_range: true, supports_vehicle_filter: true, supports_driver_filter: true, schedule_supported: true },
        { key: 'alerts', label: 'Alerts', description: 'Alert history over a selected period.', renderer: 'table', needs_date_range: true, supports_vehicle_filter: true, supports_user_filter: true, schedule_supported: true },
        { key: 'users', label: 'User Fleet', description: 'User readiness and alert delivery status.', renderer: 'table', needs_date_range: true, supports_user_filter: true, schedule_supported: true, schedule_uses_user_filter: true },
    ];

    const alertTypes = {
        speed_tolerance: {
            label: 'Speed Limit Alert', icon: '⚡', severity: 'warning',
            desc: "Fires when the vehicle exceeds the road's actual speed limit by more than the configured tolerance.",
            fields: [
                { key: 'overspeed_percent', label: 'Overspeed Tolerance', field_type: 'number', default: 10, unit: '%', min_value: 0, max_value: 50 },
                { key: 'duration_seconds', label: 'Confirmation Duration', field_type: 'number', default: 30, unit: 'seconds', min_value: 0, max_value: 3600 },
            ],
        },
        idle_timeout_minutes: {
            label: 'Idle Timeout Alert', icon: '🅿️', severity: 'info',
            desc: 'Fires when the vehicle idles longer than the configured duration.',
            fields: [
                { key: 'timeout_minutes', label: 'Idle Timeout', field_type: 'number', default: 10, unit: 'minutes', min_value: 1, max_value: 120 },
                { key: 'speed_threshold', label: 'Speed Threshold', field_type: 'number', default: 2, unit: 'km/h', min_value: 0, max_value: 10, required: false },
            ],
        },
        geofence_alert: {
            label: 'Geofence Alert', icon: '📍', severity: 'warning',
            desc: 'Fires when the vehicle enters or exits a specific geofence.',
            fields: [
                { key: 'geofence_id', label: 'Geofence', field_type: 'select', default: null, required: true, options: [] },
                { key: 'event_type', label: 'Trigger On', field_type: 'select', default: 'both', required: true, options: [{ value: 'enter', label: 'Enter only' }, { value: 'exit', label: 'Exit only' }, { value: 'both', label: 'Enter & Exit' }] },
            ],
        },
        offline_detection: {
            label: 'Offline Detection', icon: '📴', severity: 'warning',
            desc: 'Fires when the device has not reported for a configurable number of hours.',
            fields: [{ key: 'timeout_hours', label: 'Offline Timeout', field_type: 'number', default: 24, unit: 'hours', min_value: 1, max_value: 720 }],
        },
        towing_threshold_meters: {
            label: 'Towing Alert', icon: '🚨', severity: 'critical',
            desc: 'Fires when the vehicle moves significantly while the ignition is off.',
            fields: [
                { key: 'threshold_meters', label: 'Movement Threshold', field_type: 'number', default: 100, unit: 'meters', min_value: 10, max_value: 1000 },
                { key: 'reset_on_ignition', label: 'Reset anchor when ignition turns on', field_type: 'checkbox', default: true, required: false },
            ],
        },
        low_battery: {
            label: 'Low Battery Alert', icon: '🪫', severity: 'warning',
            desc: 'Fires when the vehicle battery voltage drops below the configured threshold.',
            fields: [
                { key: 'battery_type', label: 'Battery Type', field_type: 'select', default: 'lead_acid', updates_field: 'voltage_threshold', options: [{ value: 'lead_acid', label: 'Lead Acid', threshold: 12.2 }, { value: 'agm', label: 'AGM', threshold: 12.3 }, { value: 'lithium', label: 'Lithium (LiFePO4)', threshold: 13.1 }] },
                { key: 'voltage_threshold', label: 'Voltage Threshold', field_type: 'number', default: 12.2, unit: 'V', min_value: 5, max_value: 32 },
                { key: 'voltage_sensor', label: 'Voltage Sensor', field_type: 'text', default: 'external_voltage' },
            ],
        },
        maintenance_alert: {
            label: 'Maintenance Due', icon: '🔧', severity: 'info',
            desc: 'Fires when a maintenance interval is approaching or due.',
            fields: [
                { key: 'maintenance_type', label: 'Maintenance Type', field_type: 'select', default: 'service', required: true, options: [{ value: 'service', label: '🔧 Service' }, { value: 'oil_change', label: '🛢️ Oil Change' }, { value: 'tire_change', label: '🔄 Tire Change' }, { value: 'brake_service', label: '🛑 Brake Service' }, { value: 'air_filter', label: '💨 Air Filter' }, { value: 'custom', label: '⚙️ Custom' }] },
                { key: 'tracking_mode', label: 'Track By', field_type: 'select', default: 'km', required: true, options: [{ value: 'km', label: 'Mileage only' }, { value: 'days', label: 'Time only' }, { value: 'both', label: 'Either' }] },
                { key: 'interval_km', label: 'Interval', field_type: 'number', default: 10000, unit: 'km', required: false },
                { key: 'interval_days', label: 'Interval', field_type: 'number', default: 180, unit: 'days', required: false },
            ],
        },
        no_driver: {
            label: 'No / Unexpected Driver', icon: '🧑‍✈️', severity: 'warning',
            desc: 'Fires when the vehicle is moving without the expected driver.',
            fields: [
                { key: 'min_speed', label: 'Minimum speed', field_type: 'number', default: 5, unit: 'km/h', min_value: 0, max_value: 200 },
                { key: 'duration_seconds', label: 'Missing driver duration', field_type: 'number', default: 0, unit: 'seconds', min_value: 0, max_value: 86400, required: false },
                { key: 'expected_driver', label: 'Expected driver', field_type: 'driver_select', default: '', required: false },
            ],
        },
        route_waypoint_skipped: {
            label: 'Route Point Skipped', icon: '↷', severity: 'warning',
            desc: 'Fires when a later route point is completed before an earlier point.',
            fields: [{ key: 'point_scope', label: 'Check', field_type: 'select', default: 'all', options: [{ value: 'all', label: 'Stops and waypoints' }, { value: 'stops', label: 'Stops only' }, { value: 'waypoints', label: 'Waypoints only' }] }],
        },
        route_off_route: {
            label: 'Route Deviation Alert', icon: '🧭', severity: 'warning',
            desc: 'Fires when a vehicle remains farther than the configured distance from the route path.',
            fields: [
                { key: 'distance_meters', label: 'Allowed Deviation', field_type: 'number', default: 150, unit: 'meters', min_value: 10, max_value: 5000 },
                { key: 'duration_seconds', label: 'Confirmation Duration', field_type: 'number', default: 60, unit: 'seconds', min_value: 0, max_value: 3600 },
            ],
        },
    };

    function json(data, status = 200) {
        return new Response(JSON.stringify(data), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    function text(data, status = 200, contentType = 'text/plain') {
        return new Response(data, { status, headers: { 'Content-Type': contentType } });
    }

    function emptyAudio() {
        return new Response(new Uint8Array(), { status: 200, headers: { 'Content-Type': 'audio/webm' } });
    }

    function pathOf(input) {
        return new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    }

    function queryOf(input) {
        return new URL(typeof input === 'string' ? input : input.url, location.href).searchParams;
    }

    function methodOf(options = {}) {
        return String(options.method || 'GET').toUpperCase();
    }

    function filteredDevices(input) {
        const ids = (queryOf(input).get('device_ids') || '').split(',').map(v => parseInt(v, 10)).filter(Boolean);
        return ids.length ? devices.filter(d => ids.includes(d.id)) : devices;
    }

    function reportPayload(type, input) {
        if (type === 'trips') {
            const rows = filteredDevices(input).flatMap((d, idx) => [
                { device_id: d.id, device_name: d.name, license_plate: d.license_plate, driver_id: idx + 1, driver_name: drivers[idx % drivers.length]?.name, start_time: iso(1440 + idx * 60), end_time: iso(1380 + idx * 60), distance_km: 42.8 + idx * 9, duration_minutes: 58 + idx * 7, max_speed: 94 + idx * 3, avg_speed: 54 + idx * 2 },
                { device_id: d.id, device_name: d.name, license_plate: d.license_plate, driver_id: idx + 1, driver_name: drivers[idx % drivers.length]?.name, start_time: iso(720 + idx * 45), end_time: iso(660 + idx * 45), distance_km: 26.5 + idx * 5, duration_minutes: 41 + idx * 4, max_speed: 88 + idx * 2, avg_speed: 47 + idx },
            ]);
            return table('trips', rows, [
                ['device_name', 'Vehicle'], ['license_plate', 'Plate'], ['driver_name', 'Driver'], ['start_time', 'Start', 'datetime_split'], ['end_time', 'End', 'datetime_split'], ['distance_km', 'Distance (km)', 'number'], ['duration_minutes', 'Duration', 'duration_minutes'], ['max_speed', 'Top Speed', 'number'],
            ], [{ label: 'Trips', value: rows.length }, { label: 'Distance (km)', value: rows.reduce((a, r) => a + r.distance_km, 0).toFixed(1) }], { key: 'start_time', dir: -1 });
        }
        if (type === 'alerts') {
            const rows = [
                { created_at: iso(30), device_name: 'Athens Van 12', alert_type: 'speeding', severity: 'warning', message: 'Vehicle exceeded 90 km/h', is_read: false, username: 'demo' },
                { created_at: iso(300), device_name: 'Piraeus Truck 4', alert_type: 'idling', severity: 'info', message: 'Idling for 12 minutes', is_read: true, username: 'dispatcher' },
            ];
            return table('alerts', rows, [
                ['created_at', 'Time', 'datetime_split'], ['device_name', 'Vehicle'], ['alert_type', 'Type'], ['severity', 'Severity', 'severity'], ['message', 'Message'], ['username', 'User'], ['is_read', 'Status', 'read_status'],
            ], [{ label: 'Total Alerts', value: rows.length }, { label: 'Unread', value: 1 }], { key: 'created_at', dir: -1 });
        }
        if (type === 'users') {
            const rows = users.map(u => ({ username: u.username, email: u.email, assigned_devices: u.id === 1 ? 3 : 1, push_enabled: u.id === 1, notification_channel_count: u.id === 1 ? 2 : 0, webhook_count: 1, unread_alerts: u.id === 1 ? 1 : 0, last_activity: iso(u.id * 45) }));
            return table('users', rows, [
                ['username', 'User'], ['email', 'Email'], ['assigned_devices', 'Devices', 'integer'], ['push_enabled', 'Push', 'bool_active'], ['notification_channel_count', 'Channels', 'integer'], ['webhook_count', 'Webhooks', 'integer'], ['unread_alerts', 'Unread', 'integer'], ['last_activity', 'Last Activity', 'datetime_split'],
            ], [{ label: 'Users', value: rows.length }, { label: 'Unread Alerts', value: 1 }]);
        }
        const rows = filteredDevices(input).map((d, idx) => ({
            device_id: d.id, device_name: d.name, license_plate: d.license_plate,
            driver_name: d.state.current_driver?.name || null,
            trips: 4 + idx, distance_km: 180.5 + idx * 42, driving_minutes: 245 + idx * 55,
            max_speed: 104 - idx * 4, avg_speed: 52 + idx * 3,
        }));
        return table('summary', rows, [
            ['device_name', 'Vehicle'], ['license_plate', 'Plate'], ['driver_name', 'Driver'], ['trips', 'Trips', 'integer'], ['distance_km', 'Distance (km)', 'number'], ['driving_minutes', 'Drive Time', 'duration_minutes'], ['avg_speed', 'Avg Speed', 'number'], ['max_speed', 'Top Speed', 'number'],
        ], [
            { label: 'Vehicles', value: rows.length },
            { label: 'Total Trips', value: rows.reduce((a, r) => a + r.trips, 0) },
            { label: 'Distance (km)', value: rows.reduce((a, r) => a + r.distance_km, 0).toFixed(1) },
        ]);
    }

    function table(type, rows, columns, summary = [], defaultSort = null) {
        return {
            type,
            columns: columns.map(([key, label, colType]) => ({ key, label, type: colType || 'text' })),
            summary,
            rows,
            default_sort: defaultSort || { key: columns[0][0], dir: 1 },
            csv_filename: `${type}_demo.csv`,
        };
    }

    function historyPositions(params = {}) {
        const deviceId = parseInt(params.device_id || '1', 10);
        const d = devices.find(item => item.id === deviceId) || devices[0];
        const baseLat = d.state.last_latitude;
        const baseLng = d.state.last_longitude;
        return Array.from({ length: 16 }, (_, i) => {
            const time = iso(240 - i * 10);
            return {
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [baseLng + i * 0.003, baseLat + i * 0.002],
                },
                properties: {
                    id: i + 1,
                    device_id: d.id,
                    time,
                    device_time: time,
                    server_time: iso(239 - i * 10),
                    speed: 35 + (i % 5) * 8,
                    course: (d.state.last_course + i * 8) % 360,
                    altitude: 80 + i,
                    satellites: 12,
                    ignition: i % 4 !== 0,
                    trip_id: i < 8 ? 101 : 102,
                    driver_name: d.state.current_driver?.name || null,
                    sensors: { ...d.state.sensors, rpm: 1800 + i * 45, fuel_level: Math.max(20, 62 - i) },
                },
            };
        });
    }

    function historyTrips(deviceId) {
        const d = devices.find(item => item.id === deviceId) || devices[0];
        const driverName = d.state.current_driver?.name || drivers[0]?.name || null;
        return [
            {
                id: 102,
                device_id: d.id,
                device_name: d.name,
                driver_name: driverName,
                start_time: iso(160),
                end_time: iso(90),
                distance_km: 12.4,
                duration_minutes: 70,
                max_speed: 72,
                avg_speed: 39,
            },
            {
                id: 101,
                device_id: d.id,
                device_name: d.name,
                driver_name: driverName,
                start_time: iso(240),
                end_time: iso(170),
                distance_km: 10.8,
                duration_minutes: 70,
                max_speed: 68,
                avg_speed: 36,
            },
        ];
    }

    async function mockFetch(input, options = {}) {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        const path = url.pathname;
        const method = methodOf(options);
        const body = options.body ? JSON.parse(options.body || '{}') : {};

        if (path.endsWith('/api/login') && method === 'POST') {
            if ((body.username === 'demo' || body.username === 'demo@routario.local') && body.password === 'demo') {
                return json({ access_token: 'demo-token', user_id: 1, username: 'demo', is_admin: true, is_company_admin: true, company_id: null, units: 'metric', currency: 'EUR', permissions: DEMO_USER.permissions });
            }
            return json({ detail: 'Invalid credentials' }, 401);
        }
        if (path.endsWith('/health/ready')) return json({ ok: true, checks: { database: { ok: true, latency_ms: 2, database_type: 'mock' }, redis: { ok: true, optional: true, mode: 'in_process' }, runtime: { ok: true, app_version: 'demo', python_version: 'n/a', uptime_seconds: 3600 } } });
        if (path.includes('/branding/')) return json({ app_name: 'Routario Demo', branding_version: 1, icon_url: null });
        if (!path.includes('/api/')) return null;

        const apiPath = path.slice(path.indexOf('/api/') + 4);
        if (apiPath === '/users/1') return json(DEMO_USER);
        if (apiPath === '/users') return json(users);
        if (apiPath.match(/^\/users\/\d+$/)) return json(users.find(u => u.id === Number(apiPath.split('/').pop())) || DEMO_USER);
        if (apiPath === '/devices' || apiPath === '/devices/all') return json(devices);
        if (apiPath.match(/^\/devices\/\d+$/)) {
            const id = Number(apiPath.split('/')[2]);
            const d = devices.find(item => item.id === id);
            if (!d) return json({ detail: 'Not found' }, 404);
            if (method === 'PUT') Object.assign(d, body);
            return json(d);
        }
        if (apiPath.match(/^\/devices\/\d+\/trips$/)) return json(historyTrips(Number(apiPath.split('/')[2])));
        if (apiPath.match(/^\/devices\/\d+\/state$/)) return json(devices.find(d => d.id === Number(apiPath.split('/')[2]))?.state || {});
        if (apiPath.match(/^\/devices\/\d+\/users$/)) return json(users);
        if (apiPath === '/drivers') return json(drivers);
        if (apiPath === '/companies') return json([{ id: 1, name: 'Demo Fleet', user_count: users.length, device_count: devices.length, created_at: iso(10000) }]);
        if (apiPath === '/protocols') return json({ protocols: ['teltonika', 'gt06', 'osmand'], protocol_info: { teltonika: { port: 5027, protocol_types: ['tcp'] }, gt06: { port: 5023, protocol_types: ['tcp'] }, osmand: { port: 5055, protocol_types: ['http'] } } });
        if (apiPath === '/integrations/providers' || apiPath === '/integrations/accounts') return json([]);
        if (apiPath === '/alerts/types') return json(alertTypes);
        if (apiPath.startsWith('/alerts')) return json([{ id: 1, device_id: 1, device_name: 'Athens Van 12', alert_type: 'speeding', severity: 'warning', message: 'Vehicle exceeded 90 km/h', created_at: iso(30), is_read: false }]);
        if (apiPath === '/voice/users') return json(users.map(u => ({ id: u.id, username: u.username, is_admin: !!u.is_admin, is_company_admin: !!u.is_company_admin })));
        if (apiPath === '/voice/messages') {
            if (method === 'DELETE') {
                voiceMessages = [];
                return text('', 204);
            }
            const page = parseInt(url.searchParams.get('page') || '1', 10);
            const pageSize = parseInt(url.searchParams.get('page_size') || '20', 10);
            const start = Math.max(0, (page - 1) * pageSize);
            const items = voiceMessages.slice(start, start + pageSize);
            return json({ items, total: voiceMessages.length, pages: Math.max(1, Math.ceil(voiceMessages.length / pageSize)), page });
        }
        if (apiPath === '/voice/messages/read-all') {
            voiceMessages = voiceMessages.map(m => ({ ...m, is_read: true }));
            return json({ ok: true });
        }
        if (apiPath.match(/^\/voice\/messages\/\d+\/read$/)) {
            const id = Number(apiPath.split('/')[3]);
            voiceMessages = voiceMessages.map(m => m.id === id ? { ...m, is_read: true } : m);
            return json({ ok: true });
        }
        if (apiPath.match(/^\/voice\/messages\/\d+\/audio$/)) return emptyAudio();
        if (apiPath.match(/^\/voice\/messages\/\d+$/)) {
            const id = Number(apiPath.split('/')[3]);
            if (method === 'DELETE') {
                voiceMessages = voiceMessages.filter(m => m.id !== id);
                return text('', 204);
            }
            return json(voiceMessages.find(m => m.id === id) || { detail: 'Not found' }, voiceMessages.some(m => m.id === id) ? 200 : 404);
        }
        if (apiPath === '/geofences' || apiPath.startsWith('/geofences?')) return json([{ id: 1, name: 'Athens Depot', color: '#3b82f6', type: 'circle', coordinates: [[37.9838, 23.7275]], radius: 450 }]);
        if (apiPath === '/positions/history') {
            const points = historyPositions(body);
            return json({
                type: 'FeatureCollection',
                features: points,
                truncated: false,
                count: points.length,
            });
        }
        if (apiPath === '/planned-routes') return json([]);
        if (apiPath === '/planned-routes/preview') return json({ distance_km: 18.4, duration_minutes: 32, geometry: [[37.9838, 23.7275], [37.942, 23.646]] });
        if (apiPath === '/reports/types') return json(reportDefs);
        if (apiPath.startsWith('/reports/export/pdf') || apiPath.endsWith('/pdf')) return text('Routario demo PDF export placeholder', 200, 'application/pdf');
        if (apiPath.startsWith('/reports/billing/details')) return json(table('billing_detail', [], [], []));
        if (apiPath.startsWith('/reports/')) return json(reportPayload(apiPath.split('/')[2], input));
        if (apiPath === '/report-schedules') {
            if (method === 'POST') {
                const schedule = { id: Date.now(), ...body, run_count: 0, next_run: iso(-1440) };
                schedules.push(schedule);
                return json(schedule);
            }
            return json(schedules);
        }
        if (apiPath.match(/^\/report-schedules\/\d+$/)) {
            const id = Number(apiPath.split('/')[2]);
            if (method === 'DELETE') {
                schedules = schedules.filter(s => s.id !== id);
                return text('', 204);
            }
            const idx = schedules.findIndex(s => s.id === id);
            if (idx >= 0 && method === 'PUT') schedules[idx] = { ...schedules[idx], ...body };
            return json(schedules[idx] || { detail: 'Not found' }, idx >= 0 ? 200 : 404);
        }
        if (apiPath.match(/^\/report-schedules\/\d+\/runs/)) return json([{ id: 1, run_at: iso(120), status: 'success', row_count: 3, error: null }]);
        if (apiPath === '/api-keys/scopes') return json(DEMO_USER.permissions);
        if (apiPath === '/api-keys') return json([]);
        if (apiPath === '/billing/plans') return json([]);
        if (apiPath === '/currency/rates') return json({ base: 'EUR', rates: { EUR: 1, USD: 1.08 }, updated_at: iso(60) });
        if (apiPath.startsWith('/dashcam/clips')) return json([]);
        if (apiPath.startsWith('/share')) return json([]);

        return json({ detail: `Demo mock endpoint not implemented: ${apiPath}` }, method === 'GET' ? 200 : 201);
    }

    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, options = {}) => {
        const mocked = await mockFetch(input, options).catch(error => json({ detail: error.message }, 500));
        return mocked || realFetch(input, options);
    };

    window.addEventListener('DOMContentLoaded', () => {
        document.body.classList.add('demo-mode');
        if (location.pathname.endsWith('login.html')) {
            const username = document.getElementById('username');
            const password = document.getElementById('password');
            if (username && !username.value) username.value = 'demo';
            if (password && !password.value) password.value = 'demo';
            const card = document.querySelector('.login-card');
            if (card && !document.getElementById('demoLoginHint')) {
                const hint = document.createElement('div');
                hint.id = 'demoLoginHint';
                hint.style.cssText = 'margin:-0.75rem 0 1.25rem;color:#9ca3af;font-size:0.85rem;';
                hint.innerHTML = 'Demo login: <strong>demo</strong> / <strong>demo</strong>';
                card.querySelector('form')?.prepend(hint);
            }
        }
    });
})();
