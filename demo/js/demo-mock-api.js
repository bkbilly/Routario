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
            { id: 'nc_ops_email', name: 'Ops Email', url: 'mailto:ops@example.com' },
            { id: 'nc_dispatch_slack', name: 'Dispatch Slack', url: 'slack://demo/webhook' },
        ],
        webhook_urls: [
            'https://demo.routario.com/api/webhooks/telematics',
            'https://hooks.slack.com/services/demo/telemetry',
        ],
        permissions: [
            'view_dashboard', 'view_management', 'view_devices', 'edit_devices', 'send_commands',
            'manage_alerts', 'manage_integrations', 'manage_geofences', 'view_history',
            'manage_routes', 'manage_logbook', 'manage_fuel', 'manage_maintenance',
            'voice_ptt', 'live_share', 'manage_users', 'manage_drivers', 'manage_mfa',
            'view_reports', 'llm', 'view_health', 'view_audit',
            'manage_api_keys', 'manage_tickets', 'manage_webhooks', 'manage_backups',
        ],
    };

    const now = new Date();
    const iso = minutesAgo => new Date(now.getTime() - minutesAgo * 60000).toISOString();
    const dateIn = days => new Date(now.getTime() + days * 86400000).toISOString().split('T')[0];
    const devices = [
        {
            id: 1, name: 'Athens Van 12', imei: 'demo-0001', protocol: 'teltonika',
            vehicle_type: 'van', license_plate: 'ATH-1201', company_id: 1,
            supports_commands: true, is_active: true,
            custom_attributes: { department: 'Operations' },
            config: {
                offline_timeout_hours: 24,
                trip_merge_gap_minutes: 5,
                alert_rows: [
                    { alertKey: 'speed_tolerance', params: { overspeed_percent: 10, duration_seconds: 30 }, channels: ['Ops Email'], schedule: null, notify_user_ids: [1] },
                    { alertKey: 'offline_detection', params: { timeout_hours: 4 }, channels: ['Dispatch Slack'], schedule: null, notify_user_ids: [1] },
                    { alertKey: 'maintenance_alert', uid: 'demo-maint-van-service', params: { maintenance_type: 'service', custom_label: '', tracking_mode: 'km', next_service_km: 24825, interval_km: 5000, warning_km: 500 }, channels: ['Ops Email'], schedule: null, notify_user_ids: [1] },
                ],
                alert_channels: { speed_tolerance: ['Ops Email'], offline_detection: ['Dispatch Slack'], maintenance_alert: ['Ops Email'] },
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
            vehicle_type: 'truck', license_plate: 'PIR-4040', company_id: 1,
            supports_commands: false, is_active: true,
            custom_attributes: { department: 'Logistics' },
            config: {
                offline_timeout_hours: 24,
                trip_merge_gap_minutes: 10,
                alert_rows: [
                    { alertKey: 'idle_timeout_minutes', params: { timeout_minutes: 12, speed_threshold: 2 }, channels: ['Ops Email'], schedule: null, notify_user_ids: [1] },
                    { alertKey: 'maintenance_alert', uid: 'demo-maint-truck-oil', params: { maintenance_type: 'oil_change', custom_label: '', tracking_mode: 'both', next_service_km: 88100, interval_km: 10000, warning_km: 500, next_service_date: dateIn(-3), interval_days: 180, warning_days: 14 }, channels: ['Ops Email'], schedule: null, notify_user_ids: [1] },
                ],
                alert_channels: { idle_timeout_minutes: ['Ops Email'], maintenance_alert: ['Ops Email'] },
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
            vehicle_type: 'car', license_plate: 'SKG-7007', company_id: 1,
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

    const demoSystemSettingsCategories = {
        'Core System & Operations': [
            { key: 'log_level', label: 'System Log Level', type: 'str', category: 'Core System & Operations', description: 'Global logging verbosity level', secret: false, readonly: false, value: 'INFO', has_value: true, options: ['DEBUG', 'INFO', 'WARNING', 'ERROR'] },
            { key: 'offline_check_interval_seconds', label: 'Offline Check Interval (s)', type: 'int', category: 'Core System & Operations', description: 'Offline device detection check frequency in seconds', secret: false, readonly: false, value: 30, has_value: true },
            { key: 'enable_websockets', label: 'WebSockets Enabled', type: 'bool', category: 'Core System & Operations', description: 'Enable live WebSocket connection server', secret: false, readonly: false, value: true, has_value: true },
            { key: 'enable_notifications', label: 'Notifications Enabled', type: 'bool', category: 'Core System & Operations', description: 'Enable push notification delivery system', secret: false, readonly: false, value: true, has_value: true },
            { key: 'enable_command_queue', label: 'Command Queue Enabled', type: 'bool', category: 'Core System & Operations', description: 'Enable background queueing for device commands', secret: false, readonly: false, value: true, has_value: true }
        ],
        'Email & SMTP Notifications': [
            { key: 'smtp_enabled', label: 'SMTP Email Enabled', type: 'bool', category: 'Email & SMTP Notifications', description: 'Enable sending platform system emails for alerts and ticket assignments', secret: false, readonly: false, value: true, has_value: true },
            { key: 'smtp_host', label: 'SMTP Server Host', type: 'str', category: 'Email & SMTP Notifications', description: 'SMTP server host address (e.g. smtp.gmail.com)', secret: false, readonly: false, value: 'smtp.gmail.com', has_value: true },
            { key: 'smtp_port', label: 'SMTP Server Port', type: 'int', category: 'Email & SMTP Notifications', description: 'SMTP server port (usually 587 for TLS, 465 for SSL)', secret: false, readonly: false, value: 587, has_value: true },
            { key: 'smtp_username', label: 'SMTP Username / Email', type: 'str', category: 'Email & SMTP Notifications', description: 'Authentication username or email address', secret: false, readonly: false, value: 'alerts@routario.local', has_value: true },
            { key: 'smtp_password', label: 'SMTP Password', type: 'str', category: 'Email & SMTP Notifications', description: 'SMTP authentication password or app password', secret: true, readonly: false, value: '', has_value: true },
            { key: 'smtp_use_tls', label: 'Use STARTTLS', type: 'bool', category: 'Email & SMTP Notifications', description: 'Enable TLS encryption for outgoing emails', secret: false, readonly: false, value: true, has_value: true },
            { key: 'smtp_from_email', label: 'Sender Email (From)', type: 'str', category: 'Email & SMTP Notifications', description: 'Email address shown as the sender', secret: false, readonly: false, value: 'noreply@routario.local', has_value: true },
            { key: 'smtp_from_name', label: 'Sender Name', type: 'str', category: 'Email & SMTP Notifications', description: 'Display name for sent emails', secret: false, readonly: false, value: 'Routario Telematics', has_value: true }
        ],
        'AI Copilot & LLM Engine': [
            { key: 'llm_enabled', label: 'LLM Copilot Enabled', type: 'bool', category: 'AI Copilot & LLM Engine', description: 'Enable AI-driven custom reports and natural language queries', secret: false, readonly: false, value: true, has_value: true },
            { key: 'llm_active_provider', label: 'Active LLM Provider', type: 'str', category: 'AI Copilot & LLM Engine', description: 'Selected LLM backend service', secret: false, readonly: false, value: 'gemini', has_value: true, options: ['gemini', 'openai', 'claude'] },
            { key: 'llm_gemini_api_key', label: 'Gemini API Key', type: 'str', category: 'AI Copilot & LLM Engine', description: 'Google Gemini API key for AI custom report generation', secret: true, readonly: false, value: '', has_value: true },
            { key: 'llm_gemini_model', label: 'Gemini Model Version', type: 'str', category: 'AI Copilot & LLM Engine', description: 'Gemini model identifier', secret: false, readonly: false, value: 'gemini-2.5-flash-lite', has_value: true }
        ],
        'Web Push Notifications': [
            { key: 'vapid_public_key', label: 'VAPID Public Key', type: 'str', category: 'Web Push Notifications', description: 'Public key for browser push notifications', secret: false, readonly: false, value: 'BEl62iUYgUivxIkv69yViEuiBI788gY7U...', has_value: true },
            { key: 'vapid_mailto', label: 'VAPID Contact Email', type: 'str', category: 'Web Push Notifications', description: 'Admin contact mailto for push service providers', secret: false, readonly: false, value: 'mailto:admin@routario.local', has_value: true }
        ],
        'Telematics & Trip Rules': [
            { key: 'trip_min_distance_km', label: 'Min Trip Distance (km)', type: 'float', category: 'Telematics & Trip Rules', description: 'Minimum distance threshold to classify movement as a trip', secret: false, readonly: false, value: 0.1, has_value: true },
            { key: 'trip_min_duration_seconds', label: 'Min Trip Duration (s)', type: 'int', category: 'Telematics & Trip Rules', description: 'Minimum duration threshold in seconds to record a trip', secret: false, readonly: false, value: 60, has_value: true }
        ],
        'Maps, Geocoding & Routing': [
            { key: 'valhalla_enabled', label: 'Valhalla Routing Enabled', type: 'bool', category: 'Maps, Geocoding & Routing', description: 'Enable local Valhalla map routing and speed limit lookups', secret: false, readonly: false, value: true, has_value: true },
            { key: 'valhalla_url', label: 'Valhalla Server URL', type: 'str', category: 'Maps, Geocoding & Routing', description: 'URL of Valhalla routing server instance', secret: false, readonly: false, value: 'http://localhost:8002', has_value: true }
        ],
        'History Data & Retention': [
            { key: 'history_batch_size', label: 'History Batch Query Limit', type: 'int', category: 'History Data & Retention', description: 'Maximum position records retrieved per history query batch', secret: false, readonly: false, value: 2000, has_value: true },
            { key: 'history_max_api_limit', label: 'History API Record Limit', type: 'int', category: 'History Data & Retention', description: 'Hard limit for max positions returned via API', secret: false, readonly: false, value: 10000, has_value: true },
            { key: 'history_retention_enabled', label: 'History Retention Enabled', type: 'bool', category: 'History Data & Retention', description: 'Enable automatic purging of position records older than retention period', secret: false, readonly: false, value: false, has_value: true },
            { key: 'history_retention_days', label: 'Data Retention Period (Days)', type: 'int', category: 'History Data & Retention', description: 'Number of days to keep historical telemetry position logs', secret: false, readonly: false, value: 90, has_value: true }
        ],
        'Security & Token Policies': [
            { key: 'admin_username', label: 'Default Superuser Name', type: 'str', category: 'Security & Token Policies', description: 'Primary administrator username', secret: false, readonly: true, value: 'admin', has_value: true }
        ]
    };

    const users = [
        DEMO_USER,
        { id: 2, username: 'dispatcher', email: 'dispatch@routario.local', is_admin: false, is_company_admin: false, company_id: 1, permissions: ['view_reports', 'view_devices'], units: 'metric', currency: 'EUR' },
        {
            id: 3,
            username: 'fleetadmin',
            email: 'fleetadmin@routario.local',
            is_admin: false,
            is_company_admin: true,
            company_id: 1,
            permissions: [
                'view_management', 'view_devices', 'edit_devices', 'manage_alerts',
                'manage_geofences', 'view_history', 'view_reports', 'manage_routes',
                'manage_tickets', 'manage_users', 'send_commands', 'manage_drivers', 'manage_fuel',
                'manage_maintenance', 'manage_logbook', 'live_share',
            ],
            units: 'metric',
            currency: 'EUR',
        },
    ];
    let demoCompanies = [
        { id: 1, name: 'Demo Fleet', app_name: 'Routario Demo', login_slug: 'demo-fleet', billing_plan_id: 1, user_count: users.length, device_count: devices.length, created_at: iso(10000), branding_version: 1, icon_url: null, badge_url: null },
    ];
    let billingPlans = [
        {
            id: 1,
            name: 'Fleet Starter',
            currency: 'EUR',
            base_price_cents: 4900,
            included_devices: 5,
            included_positions: 250000,
            included_api_calls: 10000,
            price_per_device_cents: 900,
            price_per_1000_positions_cents: 12,
            price_per_1000_api_calls_cents: 30,
            is_active: true,
            created_at: iso(20000),
        },
        {
            id: 2,
            name: 'Operations Pro',
            currency: 'EUR',
            base_price_cents: 14900,
            included_devices: 25,
            included_positions: 1500000,
            included_api_calls: 100000,
            price_per_device_cents: 650,
            price_per_1000_positions_cents: 8,
            price_per_1000_api_calls_cents: 18,
            is_active: true,
            created_at: iso(18000),
        },
    ];
    let currencyRates = [
        { currency: 'EUR', rate: 1, source: 'system', updated_at: iso(60) },
        { currency: 'USD', rate: 1.08, source: 'manual', updated_at: iso(60) },
        { currency: 'GBP', rate: 0.86, source: 'manual', updated_at: iso(60) },
        { currency: 'CHF', rate: 0.95, source: 'manual', updated_at: iso(60) },
    ];
    let apiKeys = [
        {
            id: 1,
            name: 'Demo reporting key',
            user_id: 1,
            company_id: null,
            key_prefix: 'rt_demo_001',
            scopes: ['devices:read', 'positions:read', 'reports:read'],
            is_active: true,
            expires_at: null,
            last_used_at: iso(180),
            last_used_ip: '127.0.0.1',
            created_at: iso(5000),
            revoked_at: null,
        },
    ];
    let runtimeLogs = [
        { timestamp: iso(2), level: 'info', logger: 'routario.gateway', module: 'gateway', function: 'handle_position', line: 214, message: 'Accepted Teltonika position from Athens Van 12', exception: null },
        { timestamp: iso(6), level: 'debug', logger: 'routario.websocket', module: 'main', function: 'broadcast_position', line: 736, message: 'Broadcast position update to 3 dashboard clients', exception: null },
        { timestamp: iso(14), level: 'warning', logger: 'routario.integrations.traccar', module: 'engine', function: 'poll_account', line: 118, message: 'Traccar demo account returned no new positions', exception: null },
        { timestamp: iso(23), level: 'info', logger: 'routario.reports', module: 'schedule_runner', function: 'run_due_schedules', line: 302, message: 'Generated scheduled fleet summary for Demo Fleet', exception: null },
        { timestamp: iso(37), level: 'error', logger: 'routario.notifications.email', module: 'z_apprise', function: 'send', line: 91, message: 'Demo email notification failed for invalid recipient', exception: 'ValueError: invalid demo recipient address' },
        { timestamp: iso(55), level: 'info', logger: 'routario.tickets', module: 'tickets', function: 'create_ticket', line: 426, message: 'Support ticket #101 created by demo', exception: null },
        { timestamp: iso(68), level: 'debug', logger: 'routario.reports', module: 'reports', function: 'report_types', line: 74, message: 'Loaded 10 backend-defined report definitions', exception: null },
        { timestamp: iso(82), level: 'info', logger: 'routario.alerts', module: 'alert_engine', function: 'evaluate_device', line: 211, message: 'Evaluated 3 active alert rules for Piraeus Truck 4', exception: null },
        { timestamp: iso(96), level: 'warning', logger: 'routario.health', module: 'runtime_health', function: 'check_protocol_listeners', line: 156, message: 'GT06 listener is active but has not received data for 18 minutes', exception: null },
        { timestamp: iso(110), level: 'debug', logger: 'routario.auth', module: 'auth', function: 'get_current_user', line: 88, message: 'Resolved demo user permissions from token', exception: null },
        { timestamp: iso(126), level: 'info', logger: 'routario.routes', module: 'route_progress', function: 'update_route_progress', line: 264, message: 'Route progress updated for Piraeus Port Delivery Loop', exception: null },
        { timestamp: iso(142), level: 'error', logger: 'routario.gateway.teltonika', module: 'teltonika', function: 'decode_packet', line: 319, message: 'Rejected malformed demo AVL packet', exception: 'DecodeError: invalid codec id 0xff' },
        { timestamp: iso(158), level: 'critical', logger: 'routario.database', module: 'database', function: 'health_check', line: 184, message: 'Demo database pool exhausted during readiness check', exception: 'TimeoutError: connection pool checkout timed out' },
        { timestamp: iso(174), level: 'info', logger: 'routario.backup', module: 'backup', function: 'download_backup', line: 182, message: 'Company-scoped backup archive prepared for Demo Fleet', exception: null },
        { timestamp: iso(190), level: 'debug', logger: 'routario.push', module: 'push_notifications', function: 'send_web_push', line: 245, message: 'Skipped browser push for offline demo subscription endpoint', exception: null },
        { timestamp: iso(206), level: 'warning', logger: 'routario.tickets', module: 'tickets', function: 'store_upload', line: 234, message: 'Ticket attachment demo-invoice.pdf is near the configured upload size warning threshold', exception: null },
    ];
    let demoTickets = [
        {
            id: 101,
            title: 'Route completion report did not arrive',
            description: 'The scheduled route completion report for Piraeus Truck 4 did not send to the dispatch email this morning.',
            status: 'open',
            priority: 'high',
            category: 'route',
            related_type: 'device',
            related_id: 2,
            company_id: 1,
            created_by: 1,
            creator_name: 'demo',
            assigned_to: 3,
            assignee_name: 'fleetadmin',
            created_at: iso(240),
            updated_at: iso(55),
            internal_notes: 'Check notification channel and schedule history before closing.',
            attachments: [
                { name: 'missing-report-screenshot.png', size: 184320, url: '/uploads/tickets/demo/missing-report-screenshot.png' },
                { name: 'schedule-settings.csv', size: 9216, url: '/uploads/tickets/demo/schedule-settings.csv' },
            ],
            comments: [
                {
                    id: 1001,
                    ticket_id: 101,
                    author_id: 3,
                    author_name: 'fleetadmin',
                    body: 'I can see the schedule ran successfully, but the email channel rejected the recipient. I will update the channel and rerun the report.',
                    is_internal: false,
                    created_at: iso(90),
                    updated_at: iso(90),
                    attachments: [{ name: 'schedule-run-log.txt', size: 4096, url: '/uploads/tickets/demo/schedule-run-log.txt' }],
                },
            ],
        },
        {
            id: 102,
            title: 'Athens Van 12 shows stale fuel level',
            description: 'Fuel level has stayed at 62% since yesterday even though the vehicle was refueled.',
            status: 'in_progress',
            priority: 'normal',
            category: 'device',
            related_type: 'device',
            related_id: 1,
            company_id: 1,
            created_by: 2,
            creator_name: 'dispatcher',
            assigned_to: 1,
            assignee_name: 'demo',
            created_at: iso(720),
            updated_at: iso(180),
            internal_notes: '',
            attachments: [{ name: 'fuel-sensor-reading.jpg', size: 512000, url: '/uploads/tickets/demo/fuel-sensor-reading.jpg' }],
            comments: [
                {
                    id: 1002,
                    ticket_id: 102,
                    author_id: 1,
                    author_name: 'demo',
                    body: 'The last raw payload still contains the old fuel value. Please confirm the device wiring after the next ignition cycle.',
                    is_internal: false,
                    created_at: iso(180),
                    updated_at: iso(180),
                    attachments: [],
                },
            ],
        },
        {
            id: 103,
            title: 'Need access for new maintenance user',
            description: 'Please create access for the maintenance desk so they can upload service records and invoices.',
            status: 'waiting_on_user',
            priority: 'low',
            category: 'access',
            related_type: null,
            related_id: null,
            company_id: 1,
            created_by: 3,
            creator_name: 'fleetadmin',
            assigned_to: null,
            assignee_name: null,
            created_at: iso(1320),
            updated_at: iso(540),
            internal_notes: '',
            attachments: [],
            comments: [],
        },
    ];
    const apiKeyScopes = [
        'devices:read', 'devices:write', 'positions:read', 'commands:send',
        'reports:read', 'routes:read', 'routes:write', 'billing:read',
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
            sensors_historical: false, date_range: 'last_7_days', trigger_type: 'time',
            trigger_options: {}, frequency: 'weekly',
            run_time: '07:00', day_of_week: 1, day_of_month: 1, timezone: 'Europe/Athens',
            keep_runs: 10, is_active: true, next_run: iso(-1200), last_triggered_at: null, run_count: 2,
        },
    ];
    let demoAlerts = [
        {
            id: 1,
            device_id: 2,
            device_name: 'Piraeus Truck 4',
            alert_type: 'idling',
            severity: 'info',
            message: 'Idling for 12 minutes near Drapetsona',
            created_at: iso(100),
            latitude: 37.97,
            longitude: 23.688,
            address: 'Drapetsona, Piraeus',
            is_read: false,
            alert_metadata: { config_key: 'idle_timeout_minutes' },
        },
        {
            id: 2,
            device_id: 1,
            device_name: 'Athens Van 12',
            alert_type: 'speeding',
            severity: 'warning',
            message: 'Vehicle exceeded 90 km/h',
            created_at: iso(30),
            latitude: 38.0118,
            longitude: 23.7695,
            address: 'Leof. Kifisias, Athens',
            is_read: false,
            alert_metadata: { config_key: 'speed_tolerance' },
        },
    ];
    let plannedRoutes = [
        {
            id: 1,
            name: 'Piraeus Port Delivery Loop',
            device_id: 2,
            device_name: 'Piraeus Truck 4',
            status: 'active',
            distance_km: 8.6,
            duration_minutes: 24,
            created_at: iso(360),
            updated_at: iso(12),
            route_geometry: {
                provider: 'demo',
                coordinates: [
                    [23.646, 37.942],
                    [23.6515, 37.9475],
                    [23.6605, 37.9528],
                    [23.671, 37.9605],
                    [23.688, 37.97],
                ],
            },
            stops: [
                { id: 1, route_id: 1, sequence: 0, name: 'Piraeus Warehouse', stop_kind: 'stop', latitude: 37.942, longitude: 23.646, arrival_radius_m: 80, status: 'completed', arrived_at: iso(130), completed_at: iso(126), notes: 'Loaded pallets for port deliveries.' },
                { id: 2, route_id: 1, sequence: 1, name: 'Keratsini Checkpoint', stop_kind: 'waypoint', latitude: 37.9528, longitude: 23.6605, arrival_radius_m: 70, status: 'arrived', arrived_at: iso(104), completed_at: null, notes: 'Driver waiting for gate clearance.' },
                { id: 3, route_id: 1, sequence: 2, name: 'Drapetsona Drop-off', stop_kind: 'stop', latitude: 37.97, longitude: 23.688, arrival_radius_m: 90, status: 'pending', arrived_at: null, completed_at: null, notes: 'Final delivery point.' },
            ],
        },
    ];
    let demoGeofences = [
        {
            id: 1,
            user_id: 1,
            owner_username: 'demo',
            name: 'Lamia Transit Zone',
            description: 'Large demo geofence on the Athens-Thessaloniki corridor near Lamia.',
            color: '#10b981',
            geometry_type: 'polygon',
            coordinates: [
                [22.285, 39.010],
                [22.535, 39.040],
                [22.555, 38.865],
                [22.325, 38.820],
                [22.285, 39.010],
            ],
            created_at: iso(7200),
            updated_at: iso(60),
        },
    ];

    const reportDefs = [
        { key: 'alerts', label: 'Alerts', description: 'Alert history for the selected period. Admins can filter by user.', renderer: 'alerts', needs_date_range: true, supports_vehicle_filter: true, supports_user_filter: true, supports_driver_filter: false, supports_historical_toggle: false, schedule_supported: true, schedule_uses_device_filter: true, schedule_uses_user_filter: false, controls: [], schedule_controls: [] },
        { key: 'audit', label: 'Audit', description: 'System audit log for super admins.', renderer: 'table', needs_date_range: true, supports_vehicle_filter: false, supports_user_filter: false, supports_driver_filter: false, supports_historical_toggle: false, super_admin_required: true, schedule_supported: false, schedule_uses_device_filter: false, schedule_uses_user_filter: false, controls: [], schedule_controls: [] },
        { key: 'billing', label: 'Billing', description: 'Draft billing usage and totals by company for the selected billing period.', renderer: 'table', needs_date_range: false, supports_vehicle_filter: false, supports_user_filter: false, supports_driver_filter: false, supports_historical_toggle: false, company_admin_required: true, schedule_supported: true, schedule_uses_device_filter: false, schedule_uses_user_filter: false, controls: [
            { key: 'period_type', label: 'Billing Period', type: 'select', default: 'year', options: [{ value: 'year', label: 'Year' }, { value: 'month', label: 'Month' }] },
            { key: 'year', label: 'Year', type: 'number', default: now.getFullYear(), min: 1970, max: 2100, step: 1 },
            { key: 'month', label: 'Month', type: 'select', default: now.getMonth() + 1, visible_when: { key: 'period_type', value: 'month' }, options: [
                { value: 1, label: 'January' }, { value: 2, label: 'February' }, { value: 3, label: 'March' }, { value: 4, label: 'April' },
                { value: 5, label: 'May' }, { value: 6, label: 'June' }, { value: 7, label: 'July' }, { value: 8, label: 'August' },
                { value: 9, label: 'September' }, { value: 10, label: 'October' }, { value: 11, label: 'November' }, { value: 12, label: 'December' },
            ] },
        ], schedule_controls: [{ key: 'billing_period', label: 'Billing Period', type: 'select', default: 'this_month', options: [{ value: 'this_year', label: 'This year' }, { value: 'last_year', label: 'Last year' }, { value: 'this_month', label: 'This month' }, { value: 'last_month', label: 'Last month' }] }] },
        { key: 'daily', label: 'Daily Activity', description: 'Trip activity aggregated by day for the whole fleet, each vehicle, or each driver.', renderer: 'daily', needs_date_range: true, supports_vehicle_filter: true, supports_user_filter: false, supports_driver_filter: true, supports_historical_toggle: false, schedule_supported: true, schedule_uses_device_filter: true, schedule_uses_user_filter: false, controls: [{ key: 'group_by', label: 'Daily Breakdown', type: 'select', default: 'fleet', options: [{ value: 'fleet', label: 'Fleet total' }, { value: 'vehicles', label: 'Vehicles' }, { value: 'drivers', label: 'Drivers' }] }], schedule_controls: [] },
        { key: 'drivers', label: 'Driver Activity', description: 'Activity per driver for the selected period - trips, distance, driving time, and top speed.', renderer: 'drivers', needs_date_range: true, supports_vehicle_filter: true, supports_user_filter: false, supports_driver_filter: false, supports_historical_toggle: false, schedule_supported: true, schedule_uses_device_filter: true, schedule_uses_user_filter: false, controls: [], schedule_controls: [] },
        { key: 'geofences', label: 'Geofence Activity', description: 'Geofence enter and exit activity by vehicle, geofence, event, and recipient.', renderer: 'geofences', needs_date_range: true, supports_vehicle_filter: true, supports_user_filter: false, supports_driver_filter: false, supports_historical_toggle: false, schedule_supported: true, schedule_uses_device_filter: true, schedule_uses_user_filter: false, controls: [], schedule_controls: [] },
        { key: 'logbook', label: 'Logbook', description: 'Fuel or maintenance logbook reports for the selected vehicles and period.', renderer: 'logbook', needs_date_range: true, supports_vehicle_filter: true, supports_user_filter: false, supports_driver_filter: false, supports_historical_toggle: false, schedule_supported: true, schedule_uses_device_filter: true, schedule_uses_user_filter: false, controls: [{ key: 'logbook_type', label: 'Logbook Type', type: 'select', default: 'maintenance', options: [{ value: 'maintenance', label: 'Maintenance' }, { value: 'fuel', label: 'Fuel' }] }], schedule_controls: [] },
        { key: 'sensors', label: 'Vehicle Sensors', description: 'Current sensor readings for all vehicles. Enable historical data to view sensor values over a date range.', renderer: 'sensors', needs_date_range: false, supports_vehicle_filter: true, supports_user_filter: false, supports_driver_filter: false, supports_historical_toggle: true, schedule_supported: true, schedule_uses_device_filter: true, schedule_uses_user_filter: false, controls: [], schedule_controls: [] },
        { key: 'summary', label: 'Fleet Summary', description: 'Totals per vehicle for the selected period - trips, distance, driving time, and top speed.', renderer: 'summary', needs_date_range: true, supports_vehicle_filter: true, supports_user_filter: false, supports_driver_filter: false, supports_historical_toggle: false, schedule_supported: true, schedule_uses_device_filter: true, schedule_uses_user_filter: false, controls: [], schedule_controls: [] },
        { key: 'trips', label: 'Trip List', description: 'Individual trips with start/end location, distance, duration, and driver. Click any row to view the route on a map.', renderer: 'trips', needs_date_range: true, supports_vehicle_filter: true, supports_user_filter: false, supports_driver_filter: false, supports_historical_toggle: false, schedule_supported: true, schedule_uses_device_filter: true, schedule_uses_user_filter: false, controls: [], schedule_controls: [] },
        { key: 'users', label: 'User Fleet', description: 'Account readiness by user - vehicle access, push status, notification channels, alert backlog, schedules, and key permissions.', renderer: 'users', needs_date_range: true, supports_vehicle_filter: false, supports_user_filter: true, supports_driver_filter: false, supports_historical_toggle: false, company_admin_required: true, schedule_supported: true, schedule_uses_device_filter: true, schedule_uses_user_filter: true, controls: [], schedule_controls: [] },
    ];

    const alertTypes = {
        speed_tolerance: {
            label: 'Speed Limit Alert', icon: '⚡', severity: 'warning',
            desc: "Fires when the vehicle exceeds the road's actual speed limit by more than the configured tolerance.",
            fields: [
                { key: 'overspeed_percent', label: 'Overspeed Tolerance', field_type: 'number', default: 10, unit: '%', min_value: 0, max_value: 50 },
                { key: 'duration_seconds', label: 'Confirmation Duration', field_type: 'number', default: 15, unit: 'seconds', min_value: 0, max_value: 300 },
                { key: 'min_speed_kmh', label: 'Minimum Speed to Check', field_type: 'number', default: 30, unit: 'km/h', min_value: 0, max_value: 100 },
                { key: 'check_interval_seconds', label: 'Valhalla Query Interval', field_type: 'number', default: 10, unit: 'seconds', min_value: 5, max_value: 60 },
                { key: 'trace_seconds', label: 'Trace Window', field_type: 'number', default: 15, unit: 'seconds', min_value: 5, max_value: 60 },
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
                { key: 'custom_label', label: 'Custom Label', field_type: 'text', default: '', required: false, show_if: { key: 'maintenance_type', value: 'custom' } },
                { key: 'tracking_mode', label: 'Track By', field_type: 'select', default: 'km', required: true, options: [{ value: 'km', label: 'Mileage only' }, { value: 'days', label: 'Time only' }, { value: 'both', label: 'Either' }] },
                { key: 'next_service_km', label: 'Next Service At', field_type: 'number', default: 0, unit: 'km', min_value: 0, max_value: 9999999, required: true, show_if: { key: 'tracking_mode', values: ['km', 'both'] } },
                { key: 'interval_km', label: 'Repeat Every', field_type: 'number', default: 5000, unit: 'km', min_value: 10, max_value: 100000, required: false, show_if: { key: 'tracking_mode', values: ['km', 'both'] } },
                { key: 'warning_km', label: 'Warn When Within', field_type: 'number', default: 500, unit: 'km', min_value: 10, max_value: 5000, required: false, show_if: { key: 'tracking_mode', values: ['km', 'both'] } },
                { key: 'next_service_date', label: 'Next Service Date', field_type: 'date', default: '', required: true, show_if: { key: 'tracking_mode', values: ['days', 'both'] } },
                { key: 'interval_days', label: 'Repeat Every', field_type: 'number', default: 180, unit: 'days', min_value: 1, max_value: 3650, required: false, show_if: { key: 'tracking_mode', values: ['days', 'both'] } },
                { key: 'warning_days', label: 'Warn When Within', field_type: 'number', default: 14, unit: 'days', min_value: 1, max_value: 365, required: false, show_if: { key: 'tracking_mode', values: ['days', 'both'] } },
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
            label: 'Route Progress Alert', icon: '🏁', severity: 'warning',
            desc: 'Fires when the vehicle skips an earlier route point or completes the assigned route.',
            fields: [
                { key: 'event_type', label: 'Trigger On', field_type: 'select', default: 'skipped', options: [{ value: 'skipped', label: 'Skipped route point' }, { value: 'completed', label: 'Route completed' }, { value: 'both', label: 'Skipped point or completed route' }] },
                { key: 'point_scope', label: 'Check', field_type: 'select', default: 'all', options: [{ value: 'all', label: 'Stops and waypoints' }, { value: 'stops', label: 'Stops only' }, { value: 'waypoints', label: 'Waypoints only' }], show_if: { key: 'event_type', values: ['skipped', 'both'] } },
            ],
        },
        route_off_route: {
            label: 'Route Deviation Alert', icon: '🧭', severity: 'warning',
            desc: 'Fires when a vehicle remains farther than the configured distance from the route path.',
            fields: [
                { key: 'distance_meters', label: 'Allowed Deviation', field_type: 'number', default: 150, unit: 'meters', min_value: 10, max_value: 5000 },
                { key: 'duration_seconds', label: 'Confirmation Duration', field_type: 'number', default: 60, unit: 'seconds', min_value: 0, max_value: 3600 },
            ],
        },
        __custom__: {
            label: 'Custom Rule', icon: '⚡', severity: 'warning',
            desc: 'Fires when a user-defined rule expression evaluates to true.',
            fields: [
                { key: 'name', label: 'Rule Name', field_type: 'text', default: '', required: true },
                { key: 'rule', label: 'Condition', field_type: 'text', default: '', required: true },
            ],
        },
    };
    const scheduleTriggers = [
        { value: 'time', label: 'Time schedule', alert_type: 'time', icon: '🕒', description: 'Run on a daily, weekly, or monthly time schedule.', source: 'schedule' },
        { value: '__custom__', key: '__custom__', alert_type: 'custom', label: alertTypes.__custom__.label, icon: alertTypes.__custom__.icon, description: alertTypes.__custom__.desc, severity: alertTypes.__custom__.severity, source: 'alert', fields: alertTypes.__custom__.fields },
        { value: 'speed_tolerance', key: 'speed_tolerance', alert_type: 'speeding', label: alertTypes.speed_tolerance.label, icon: alertTypes.speed_tolerance.icon, description: alertTypes.speed_tolerance.desc, severity: alertTypes.speed_tolerance.severity, source: 'alert', fields: alertTypes.speed_tolerance.fields },
        { value: 'idle_timeout_minutes', key: 'idle_timeout_minutes', alert_type: 'idling', label: alertTypes.idle_timeout_minutes.label, icon: alertTypes.idle_timeout_minutes.icon, description: alertTypes.idle_timeout_minutes.desc, severity: alertTypes.idle_timeout_minutes.severity, source: 'alert', fields: alertTypes.idle_timeout_minutes.fields },
        { value: 'geofence_alert', key: 'geofence_alert', alert_type: 'geofence_enter', label: alertTypes.geofence_alert.label, icon: alertTypes.geofence_alert.icon, description: alertTypes.geofence_alert.desc, severity: alertTypes.geofence_alert.severity, source: 'alert', fields: alertTypes.geofence_alert.fields },
        { value: 'offline_detection', key: 'offline_detection', alert_type: 'offline', label: alertTypes.offline_detection.label, icon: alertTypes.offline_detection.icon, description: alertTypes.offline_detection.desc, severity: alertTypes.offline_detection.severity, source: 'alert', fields: alertTypes.offline_detection.fields },
        { value: 'towing_threshold_meters', key: 'towing_threshold_meters', alert_type: 'towing', label: alertTypes.towing_threshold_meters.label, icon: alertTypes.towing_threshold_meters.icon, description: alertTypes.towing_threshold_meters.desc, severity: alertTypes.towing_threshold_meters.severity, source: 'alert', fields: alertTypes.towing_threshold_meters.fields },
        { value: 'maintenance_alert', key: 'maintenance_alert', alert_type: 'maintenance', label: alertTypes.maintenance_alert.label, icon: alertTypes.maintenance_alert.icon, description: alertTypes.maintenance_alert.desc, severity: alertTypes.maintenance_alert.severity, source: 'alert', fields: alertTypes.maintenance_alert.fields },
        { value: 'low_battery', key: 'low_battery', alert_type: 'low_battery', label: alertTypes.low_battery.label, icon: alertTypes.low_battery.icon, description: alertTypes.low_battery.desc, severity: alertTypes.low_battery.severity, source: 'alert', fields: alertTypes.low_battery.fields },
        { value: 'no_driver', key: 'no_driver', alert_type: 'unauthorized_driver', label: alertTypes.no_driver.label, icon: alertTypes.no_driver.icon, description: alertTypes.no_driver.desc, severity: alertTypes.no_driver.severity, source: 'alert', fields: alertTypes.no_driver.fields },
        { value: 'route_waypoint_skipped', key: 'route_waypoint_skipped', alert_type: 'route_waypoint_skipped', label: alertTypes.route_waypoint_skipped.label, icon: alertTypes.route_waypoint_skipped.icon, description: alertTypes.route_waypoint_skipped.desc, severity: alertTypes.route_waypoint_skipped.severity, source: 'alert', fields: alertTypes.route_waypoint_skipped.fields },
        { value: 'route_off_route', key: 'route_off_route', alert_type: 'route_off_route', label: alertTypes.route_off_route.label, icon: alertTypes.route_off_route.icon, description: alertTypes.route_off_route.desc, severity: alertTypes.route_off_route.severity, source: 'alert', fields: alertTypes.route_off_route.fields },
    ];

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

    function bodyOf(options = {}) {
        const raw = options.body;
        if (!raw) return {};
        if (raw instanceof FormData) {
            const data = {};
            raw.forEach((value, key) => {
                if (key === 'attachments') {
                    if (!Array.isArray(data.attachments)) data.attachments = [];
                    data.attachments.push(value);
                    return;
                }
                data[key] = value;
            });
            return data;
        }
        if (typeof raw === 'string') {
            try { return JSON.parse(raw || '{}'); } catch { return {}; }
        }
        return raw;
    }

    function runtimeLogPayload(limit = 1000) {
        const records = runtimeLogs.slice(-limit);
        const counts = records.reduce((acc, row) => {
            const level = row.level || 'info';
            acc.total += 1;
            acc[level] = (acc[level] || 0) + 1;
            return acc;
        }, { total: 0, debug: 0, info: 0, warning: 0, error: 0, critical: 0 });
        return { records, counts };
    }

    function demoAttachment(file, ticketId) {
        const name = file?.name || 'demo-attachment.txt';
        const size = Number(file?.size || 2048);
        return {
            name,
            size,
            url: `/uploads/tickets/demo-${ticketId}/${encodeURIComponent(name)}`,
        };
    }

    function ticketUserName(userId) {
        return users.find(u => Number(u.id) === Number(userId))?.username || null;
    }

    function normalizeTicket(ticket) {
        return {
            ...ticket,
            comments: (ticket.comments || []).map(comment => ({ ...comment })),
            attachments: (ticket.attachments || []).map(file => ({ ...file })),
        };
    }

    function touchTicket(ticket) {
        ticket.updated_at = iso(0);
        return ticket;
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
        if (type === 'drivers') {
            const rows = drivers.map((driver, idx) => ({
                driver: driver.name,
                trips: 3 + idx,
                distance_km: 148.4 + idx * 37.2,
                driving_minutes: 214 + idx * 52,
                avg_speed: 47 + idx * 4,
                max_speed: 92 + idx * 5,
                vehicle_count: 1,
                vehicle_list: devices.find(d => d.id === driver.assigned_device_id)?.name || 'Unassigned',
            }));
            return table('drivers', rows, [
                ['driver', 'Driver'], ['trips', 'Trips', 'integer'], ['distance_km', 'Distance (km)', 'number'], ['driving_minutes', 'Drive Time', 'duration_minutes'], ['avg_speed', 'Avg Speed', 'number'], ['max_speed', 'Top Speed', 'number'], ['vehicle_count', 'Vehicles', 'integer'],
            ], [{ label: 'Drivers', value: rows.length }, { label: 'Total Trips', value: rows.reduce((a, r) => a + r.trips, 0) }, { label: 'Distance (km)', value: rows.reduce((a, r) => a + r.distance_km, 0).toFixed(1) }], { key: 'driver', dir: 1 });
        }
        if (type === 'daily') {
            const rows = [
                { date: iso(60).slice(0, 10), trips: 7, distance_km: 238.6, driving_minutes: 312 },
                { date: iso(1500).slice(0, 10), trips: 5, distance_km: 184.2, driving_minutes: 251 },
                { date: iso(2940).slice(0, 10), trips: 6, distance_km: 205.7, driving_minutes: 286 },
            ];
            return table('daily', rows, [
                ['date', 'Date'], ['trips', 'Trips', 'integer'], ['distance_km', 'Distance (km)', 'number'], ['driving_minutes', 'Drive Time', 'duration_minutes'],
            ], [{ label: 'Days', value: rows.length }, { label: 'Total Trips', value: rows.reduce((a, r) => a + r.trips, 0) }, { label: 'Driving Time (h)', value: (rows.reduce((a, r) => a + r.driving_minutes, 0) / 60).toFixed(1) }], { key: 'date', dir: -1 });
        }
        if (type === 'geofences') {
            const rows = [
                { created_at: iso(45), device_id: 1, vehicle: 'Athens Van 12', license_plate: 'ATH-1201', geofence_name: 'Athens Depot Zone', event: 'Exit', severity: 'warning', notification_count: 1, latitude: 37.9841, longitude: 23.7278, message: 'Geofence Exited: Athens Depot Zone', recipients_text: 'demo' },
                { created_at: iso(210), device_id: 2, vehicle: 'Piraeus Truck 4', license_plate: 'PIR-4040', geofence_name: 'Lamia Transit Zone', event: 'Enter', severity: 'info', notification_count: 2, latitude: 38.902, longitude: 22.434, message: 'Geofence Entered: Lamia Transit Zone', recipients_text: 'demo, dispatcher' },
            ];
            return table('geofences', rows, [
                ['created_at', 'Date / Time', 'datetime'], ['vehicle', 'Vehicle'], ['geofence_name', 'Geofence'], ['event', 'Event'], ['severity', 'Severity', 'severity'], ['notification_count', 'Notifications', 'integer'], ['latitude', 'Latitude', 'number'], ['longitude', 'Longitude', 'number'], ['message', 'Message'],
            ], [{ label: 'Events', value: rows.length }, { label: 'Entries', value: 1 }, { label: 'Exits', value: 1 }], { key: 'created_at', dir: -1 });
        }
        if (type === 'logbook') {
            const rows = [
                { date: iso(6000), vehicle: 'Athens Van 12', license_plate: 'ATH-1201', type: 'Service', description: 'Oil and filter service', odometer_km: 24800, cost_cents: 18500, vendor: 'Demo Service Center' },
                { date: iso(4200), vehicle: 'Piraeus Truck 4', license_plate: 'PIR-4040', type: 'Fuel', description: 'Diesel refill', odometer_km: 88080, cost_cents: 9600, vendor: 'Port Fuel Station' },
            ];
            return table('logbook', rows, [
                ['date', 'Date', 'datetime_split'], ['vehicle', 'Vehicle'], ['license_plate', 'Plate'], ['type', 'Type'], ['description', 'Description'], ['odometer_km', 'Odometer (km)', 'number'], ['cost_cents', 'Cost', 'currency_cents'], ['vendor', 'Vendor'],
            ], [{ label: 'Entries', value: rows.length }, { label: 'Total Cost', value: typeof fmtMoneyCents === 'function' ? fmtMoneyCents(rows.reduce((a, r) => a + r.cost_cents, 0)) : '281.00' }], { key: 'date', dir: -1 });
        }
        if (type === 'sensors') {
            const rows = filteredDevices(input).map(d => ({
                name: d.name,
                license_plate: d.license_plate,
                current_driver_name: d.state.current_driver?.name || null,
                last_update: d.state.last_update,
                ignition_on: d.state.ignition_on,
                last_speed: d.state.last_speed,
                last_altitude: d.state.last_altitude,
                sensor__fuel_level: d.state.sensors?.fuel_level,
                sensor__battery_voltage: d.state.sensors?.battery_voltage,
                sensor__temperature: d.state.sensors?.temperature,
                sensor__satellites: d.state.sensors?.last_known_satellites,
            }));
            return table('sensors', rows, [
                ['name', 'Vehicle'], ['license_plate', 'Plate'], ['current_driver_name', 'Driver'], ['last_update', 'Last Seen', 'datetime_split'], ['ignition_on', 'Ignition', 'bool_on'], ['last_speed', 'Speed', 'number'], ['last_altitude', 'Altitude', 'number'], ['sensor__fuel_level', 'fuel_level', 'number'], ['sensor__battery_voltage', 'battery_voltage', 'number'], ['sensor__temperature', 'temperature', 'number'], ['sensor__satellites', 'satellites', 'integer'],
            ], [{ label: 'Vehicles', value: rows.length }, { label: 'Online', value: rows.filter(r => r.last_update).length }]);
        }
        if (type === 'audit') {
            const rows = [
                { created_at: iso(25), action: 'route.updated', actor: 'demo', actor_user_id: 1, company: 'Demo Fleet', company_id: 1, target: 'planned_route 1', ip_address: '127.0.0.1', metadata_text: 'status: active' },
                { created_at: iso(140), action: 'billing.plan_updated', actor: 'demo', actor_user_id: 1, company: 'Demo Fleet', company_id: 1, target: 'billing_plan 1', ip_address: '127.0.0.1', metadata_text: 'plan: Fleet Starter' },
            ];
            return table('audit', rows, [
                ['created_at', 'Time', 'datetime'], ['action', 'Action'], ['actor', 'User'], ['company', 'Company'], ['target', 'Target'], ['ip_address', 'IP'], ['metadata_text', 'Metadata'],
            ], [{ label: 'Events', value: rows.length }, { label: 'Actions', value: rows.length }], { key: 'created_at', dir: -1 });
        }
        if (type === 'billing') {
            const company = demoCompanies[0];
            const plan = billingPlans.find(p => p.id === company.billing_plan_id);
            const rows = [
                { company_id: company.id, company_name: company.name, period_key: `year:${now.getFullYear()}`, period_label: String(now.getFullYear()), plan_name: plan?.name || 'No plan', active_devices: devices.length, positions: 384200, api_calls: 12840, total_display_cents: 64200, currency: 'EUR' },
            ];
            const payload = table('billing', rows, [
                ['company_name', 'Company'], ['period_label', 'Period'], ['plan_name', 'Plan'], ['active_devices', 'Active Devices', 'integer'], ['positions', 'Positions', 'integer'], ['api_calls', 'API Calls', 'integer'], ['total_display_cents', 'Draft Total', 'currency_cents'],
            ], [{ label: 'Companies', value: rows.length }, { label: 'Draft Total', value: '€642.00' }], { key: 'company_name', dir: 1 });
            payload.row_action = { type: 'billing_detail', label: 'View billing details' };
            return payload;
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
        const body = bodyOf(options);

        if (path.endsWith('/api/login') && method === 'POST') {
            if ((body.username === 'demo' || body.username === 'demo@routario.local') && body.password === 'demo') {
                return json({ access_token: 'demo-token', user_id: 1, username: 'demo', is_admin: true, is_company_admin: true, company_id: null, units: 'metric', currency: 'EUR', permissions: DEMO_USER.permissions });
            }
            if ((body.username === 'fleetadmin' || body.username === 'fleetadmin@routario.local') && body.password === 'demo') {
                const user = users.find(u => u.username === 'fleetadmin');
                return json({ access_token: 'demo-company-admin-token', user_id: user.id, username: user.username, is_admin: false, is_company_admin: true, company_id: 1, units: user.units, currency: user.currency, permissions: user.permissions });
            }
            return json({ detail: 'Invalid credentials' }, 401);
        }
        if (path.endsWith('/health/ready')) return json({ ok: true, checks: { database: { ok: true, latency_ms: 2, database_type: 'mock', storage_bytes: 5898240, storage_human: '5.62 MB' }, redis: { ok: true, optional: true, mode: 'in_process' }, runtime: { ok: true, app_version: 'demo', python_version: 'n/a', uptime_seconds: 3600 } } });
        if (path.includes('/branding/')) return json({ app_name: 'Routario Demo', branding_version: 1, icon_url: null });
        if (!path.includes('/api/')) return null;

        const apiPath = path.slice(path.indexOf('/api/') + 4);
        if (apiPath === '/system-settings/public') {
            return json({
                history_batch_size: 2000,
                history_max_api_limit: 10000,
                trip_min_distance_km: 0.1,
                trip_min_duration_seconds: 60,
                llm_enabled: true,
                smtp_enabled: true,
            });
        }
        if (apiPath === '/system-settings') {
            if (method === 'POST' || method === 'PUT') {
                const key = body.key;
                const value = body.value;
                for (const catList of Object.values(demoSystemSettingsCategories)) {
                    const item = catList.find(i => i.key === key);
                    if (item) {
                        item.value = value;
                        item.has_value = Boolean(value);
                        break;
                    }
                }
                return json({ status: 'ok', key: body.key, value: body.value });
            }
            return json({ categories: demoSystemSettingsCategories });
        }
        if (apiPath === '/users/me' || apiPath === '/users/1' || apiPath.match(/^\/users\/\d+$/)) {
            const uid = apiPath === '/users/me' ? 1 : Number(apiPath.split('/').pop());
            const targetUser = users.find(u => u.id === uid) || DEMO_USER;
            if (method === 'PUT' || method === 'PATCH') {
                if (Array.isArray(body.webhook_urls)) targetUser.webhook_urls = body.webhook_urls;
                if (Array.isArray(body.notification_channels)) targetUser.notification_channels = body.notification_channels;
                if (body.units !== undefined) targetUser.units = body.units;
                if (body.currency !== undefined) targetUser.currency = body.currency;
                if (body.email !== undefined) targetUser.email = body.email;
                if (body.username !== undefined) targetUser.username = body.username;
            }
            return json(targetUser);
        }
        if (apiPath === '/users') return json(users);
        if (apiPath === '/runtime-logs') {
            const limit = parseInt(url.searchParams.get('limit') || '1000', 10);
            return json(runtimeLogPayload(limit));
        }
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
        if (apiPath === '/companies') {
            if (method === 'POST') {
                const company = { id: Date.now(), user_count: 0, device_count: 0, created_at: iso(0), branding_version: 1, icon_url: null, badge_url: null, ...body };
                demoCompanies.push(company);
                return json(company);
            }
            return json(demoCompanies);
        }
        if (apiPath.match(/^\/companies\/\d+\/users$/)) return json(users);
        if (apiPath.match(/^\/companies\/\d+\/devices$/)) return json(devices);
        if (apiPath.match(/^\/companies\/\d+$/)) {
            const id = Number(apiPath.split('/')[2]);
            const idx = demoCompanies.findIndex(c => c.id === id);
            if (idx < 0) return json({ detail: 'Not found' }, 404);
            if (method === 'PUT') demoCompanies[idx] = { ...demoCompanies[idx], ...body };
            return json(demoCompanies[idx]);
        }
        if (apiPath === '/billing/plans') {
            if (method === 'POST') {
                const plan = { id: Date.now(), is_active: true, created_at: iso(0), ...body };
                billingPlans.push(plan);
                return json(plan);
            }
            return json(billingPlans);
        }
        if (apiPath.match(/^\/billing\/plans\/\d+$/)) {
            const id = Number(apiPath.split('/')[3]);
            const idx = billingPlans.findIndex(plan => plan.id === id);
            if (idx < 0) return json({ detail: 'Plan not found' }, 404);
            if (method === 'DELETE') {
                billingPlans = billingPlans.filter(plan => plan.id !== id);
                demoCompanies = demoCompanies.map(company => Number(company.billing_plan_id) === id ? { ...company, billing_plan_id: null } : company);
                return json({ status: 'deleted' });
            }
            if (method === 'PUT') billingPlans[idx] = { ...billingPlans[idx], ...body };
            return json(billingPlans[idx]);
        }
        if (apiPath.match(/^\/billing\/companies\/\d+$/) && method === 'PUT') {
            const id = Number(apiPath.split('/')[3]);
            const idx = demoCompanies.findIndex(company => company.id === id);
            if (idx < 0) return json({ detail: 'Company not found' }, 404);
            demoCompanies[idx] = { ...demoCompanies[idx], billing_plan_id: body.plan_id ?? null };
            return json({
                company_id: id,
                billing_plan_id: demoCompanies[idx].billing_plan_id,
                billing_email: demoCompanies[idx].billing_email || null,
                billing_status: demoCompanies[idx].billing_status || 'active',
            });
        }
        if (apiPath === '/protocols') return json({ protocols: ['teltonika', 'gt06', 'osmand'], protocol_info: { teltonika: { port: 5027, protocol_types: ['tcp'] }, gt06: { port: 5023, protocol_types: ['tcp'] }, osmand: { port: 5055, protocol_types: ['http'] } } });
        if (apiPath === '/integrations/providers' || apiPath === '/integrations/accounts') return json([]);
        if (apiPath === '/alerts/types') return json(alertTypes);
        if (apiPath.match(/^\/alerts\/\d+\/read$/) && method === 'POST') {
            const id = Number(apiPath.split('/')[2]);
            demoAlerts = demoAlerts.map(alert => alert.id === id ? { ...alert, is_read: true } : alert);
            return json({ ok: true });
        }
        if (apiPath.startsWith('/alerts')) {
            const readOnly = url.searchParams.get('read_only') === 'true';
            const unreadOnly = url.searchParams.get('unread_only') === 'true';
            let rows = demoAlerts.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            if (readOnly) rows = rows.filter(alert => alert.is_read);
            if (unreadOnly) rows = rows.filter(alert => !alert.is_read);
            const offset = parseInt(url.searchParams.get('offset') || '0', 10);
            const limit = parseInt(url.searchParams.get('limit') || String(rows.length), 10);
            return json(rows.slice(offset, offset + limit));
        }
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
        if (apiPath === '/geofences' || apiPath.startsWith('/geofences?')) return json(demoGeofences);
        if (apiPath === '/positions/history') {
            const points = historyPositions(body);
            return json({
                type: 'FeatureCollection',
                features: points,
                truncated: false,
                count: points.length,
            });
        }
        if (apiPath === '/planned-routes') return json(plannedRoutes);
        if (apiPath.match(/^\/planned-routes\/\d+$/)) {
            const id = Number(apiPath.split('/')[2]);
            return json(plannedRoutes.find(route => route.id === id) || { detail: 'Not found' }, plannedRoutes.some(route => route.id === id) ? 200 : 404);
        }
        if (apiPath === '/planned-routes/preview') return json({ distance_km: 18.4, duration_minutes: 32, route_geometry: { provider: 'demo', coordinates: [[23.646, 37.942], [23.6605, 37.9528], [23.688, 37.97]] } });
        if (apiPath === '/reports/types') return json(reportDefs);
        if (apiPath.startsWith('/reports/export/pdf') || apiPath.endsWith('/pdf')) return text('Routario demo PDF export placeholder', 200, 'application/pdf');
        if (apiPath === '/reports/billing/details') {
            const company = demoCompanies[0];
            const plan = billingPlans.find(p => p.id === company.billing_plan_id);
            return json({
                company: { id: company.id, name: company.name, billing_email: 'billing@example.com', billing_status: 'active' },
                period: { key: queryOf(input).get('period') || `year:${now.getFullYear()}`, label: String(now.getFullYear()) },
                currency: 'EUR',
                plan: plan ? {
                    name: plan.name,
                    base_price_display_cents: plan.base_price_cents,
                    included_devices: plan.included_devices,
                    included_positions: plan.included_positions,
                    included_api_calls: plan.included_api_calls,
                    price_per_device_display_cents: plan.price_per_device_cents,
                    price_per_1000_positions_display_cents: plan.price_per_1000_positions_cents,
                    price_per_1000_api_calls_display_cents: plan.price_per_1000_api_calls_cents,
                } : null,
                usage: { active_devices: devices.length, positions: 384200, api_calls: 12840, events: { support_minutes: 35 } },
                line_items: [
                    { label: 'Base subscription', quantity: 1, amount_display_cents: 4900 },
                    { label: 'Additional devices', quantity: 0, amount_display_cents: 0 },
                    { label: 'Position overage', quantity: 134200, amount_display_cents: 1610 },
                ],
                total_display_cents: 6510,
                breakdown_grain: 'monthly',
                breakdown: [
                    { period: 'Jan', active_devices: 3, positions: 120000, api_calls: 3900, amount_display_cents: 5120, line_items: [{ label: 'Base subscription', quantity: 1, amount_display_cents: 4900 }] },
                    { period: 'Feb', active_devices: 3, positions: 132400, api_calls: 4200, amount_display_cents: 5270, line_items: [{ label: 'Base subscription', quantity: 1, amount_display_cents: 4900 }] },
                    { period: 'Mar', active_devices: 3, positions: 131800, api_calls: 4740, amount_display_cents: 5360, line_items: [{ label: 'Base subscription', quantity: 1, amount_display_cents: 4900 }] },
                ],
            });
        }
        if (apiPath.startsWith('/reports/')) return json(reportPayload(apiPath.split('/')[2], input));
        if (apiPath === '/report-schedules/triggers') return json(scheduleTriggers);
        if (apiPath === '/report-schedules') {
            if (method === 'POST') {
                const schedule = {
                    id: Date.now(),
                    ...body,
                    trigger_type: body.trigger_type || 'time',
                    trigger_options: body.trigger_options || {},
                    run_count: 0,
                    next_run: (body.trigger_type || 'time') === 'time' ? iso(-1440) : null,
                    last_triggered_at: null,
                };
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
        if (apiPath === '/api-keys/scopes') return json({ scopes: apiKeyScopes });
        if (apiPath === '/api-keys') {
            if (method === 'POST') {
                const key = {
                    id: Date.now(),
                    name: body.name || 'API Key',
                    user_id: 1,
                    company_id: null,
                    key_prefix: `rt_demo_${String(Date.now()).slice(-4)}`,
                    scopes: Array.isArray(body.scopes) ? body.scopes : ['devices:read', 'positions:read', 'reports:read'],
                    is_active: true,
                    expires_at: body.expires_at || null,
                    last_used_at: null,
                    last_used_ip: null,
                    created_at: iso(0),
                    revoked_at: null,
                };
                apiKeys.unshift(key);
                return json({ ...key, key: `${key.key_prefix}_example_secret_value` });
            }
            return json(apiKeys);
        }
        if (apiPath.match(/^\/api-keys\/\d+$/) && method === 'PUT') {
            const id = Number(apiPath.split('/')[2]);
            const target = apiKeys.find(key => key.id === id);
            if (!target) return json({ detail: 'API key not found' }, 404);
            if (body.name) target.name = body.name;
            if (body.scopes) target.scopes = body.scopes;
            return json(target);
        }
        if (apiPath.match(/^\/api-keys\/\d+$/) && method === 'DELETE') {
            const id = Number(apiPath.split('/')[2]);
            apiKeys = apiKeys.map(key => key.id === id ? { ...key, is_active: false, revoked_at: iso(0) } : key);
            return json({ status: 'revoked' });
        }
        if (apiPath === '/tickets/assignees') return json(users.filter(u => u.is_admin || u.is_company_admin));
        if (apiPath === '/tickets') {
            if (method === 'POST') {
                const ticket = {
                    id: Date.now(),
                    title: String(body.title || 'Demo ticket'),
                    description: String(body.description || ''),
                    status: 'open',
                    priority: String(body.priority || 'normal'),
                    category: String(body.category || 'other'),
                    related_type: body.related_type || null,
                    related_id: body.related_id ? Number(body.related_id) : null,
                    company_id: 1,
                    created_by: 1,
                    creator_name: 'demo',
                    assigned_to: null,
                    assignee_name: null,
                    created_at: iso(0),
                    updated_at: iso(0),
                    internal_notes: '',
                    attachments: (body.attachments || []).map(file => demoAttachment(file, Date.now())),
                    comments: [],
                };
                demoTickets.unshift(ticket);
                runtimeLogs.push({ timestamp: iso(0), level: 'info', logger: 'routario.tickets', module: 'tickets', function: 'create_ticket', line: 426, message: `Support ticket #${ticket.id} created in demo`, exception: null });
                return json(normalizeTicket(ticket), 201);
            }
            return json(demoTickets.map(normalizeTicket));
        }
        if (apiPath.match(/^\/tickets\/\d+\/attachments\/\d+$/) && method === 'DELETE') {
            const [, , ticketId, , attachmentIndex] = apiPath.split('/');
            const ticket = demoTickets.find(item => item.id === Number(ticketId));
            if (!ticket) return json({ detail: 'Ticket not found' }, 404);
            ticket.attachments.splice(Number(attachmentIndex), 1);
            return json(normalizeTicket(touchTicket(ticket)));
        }
        if (apiPath.match(/^\/tickets\/\d+\/comments$/)) {
            const ticketId = Number(apiPath.split('/')[2]);
            const ticket = demoTickets.find(item => item.id === ticketId);
            if (!ticket) return json({ detail: 'Ticket not found' }, 404);
            if (method === 'POST') {
                const comment = {
                    id: Date.now(),
                    ticket_id: ticket.id,
                    author_id: 1,
                    author_name: 'demo',
                    body: String(body.body || ''),
                    is_internal: body.is_internal === true || body.is_internal === 'true',
                    created_at: iso(0),
                    updated_at: iso(0),
                    attachments: (body.attachments || []).map(file => demoAttachment(file, ticket.id)),
                };
                ticket.comments.push(comment);
                return json(normalizeTicket(touchTicket(ticket)), 201);
            }
        }
        if (apiPath.match(/^\/tickets\/\d+\/comments\/\d+\/attachments\/\d+$/) && method === 'DELETE') {
            const parts = apiPath.split('/');
            const ticket = demoTickets.find(item => item.id === Number(parts[2]));
            const comment = ticket?.comments.find(item => item.id === Number(parts[4]));
            if (!ticket || !comment) return json({ detail: 'Comment not found' }, 404);
            comment.attachments.splice(Number(parts[6]), 1);
            return json(normalizeTicket(touchTicket(ticket)));
        }
        if (apiPath.match(/^\/tickets\/\d+\/comments\/\d+$/)) {
            const parts = apiPath.split('/');
            const ticket = demoTickets.find(item => item.id === Number(parts[2]));
            const comment = ticket?.comments.find(item => item.id === Number(parts[4]));
            if (!ticket || !comment) return json({ detail: 'Comment not found' }, 404);
            if (method === 'PATCH') {
                if (body.body !== undefined) comment.body = String(body.body);
                if (body.is_internal !== undefined) comment.is_internal = body.is_internal === true || body.is_internal === 'true';
                if (Array.isArray(body.attachments)) comment.attachments.push(...body.attachments.map(file => demoAttachment(file, ticket.id)));
                comment.updated_at = iso(0);
                return json(normalizeTicket(touchTicket(ticket)));
            }
        }
        if (apiPath.match(/^\/tickets\/\d+$/)) {
            const id = Number(apiPath.split('/')[2]);
            const ticket = demoTickets.find(item => item.id === id);
            if (!ticket) return json({ detail: 'Ticket not found' }, 404);
            if (method === 'PATCH') {
                ['title', 'description', 'status', 'priority', 'category', 'internal_notes'].forEach(key => {
                    if (body[key] !== undefined) ticket[key] = String(body[key]);
                });
                if (body.assigned_to !== undefined) {
                    ticket.assigned_to = body.assigned_to ? Number(body.assigned_to) : null;
                    ticket.assignee_name = ticket.assigned_to ? ticketUserName(ticket.assigned_to) : null;
                }
                if (Array.isArray(body.attachments)) ticket.attachments.push(...body.attachments.map(file => demoAttachment(file, ticket.id)));
                return json(normalizeTicket(touchTicket(ticket)));
            }
            return json(normalizeTicket(ticket));
        }
        if (apiPath === '/currency/rates') {
            if (method === 'PUT') {
                currencyRates = (body.rates || []).map(row => ({
                    currency: String(row.currency || '').toUpperCase(),
                    rate: Number(row.rate || 1),
                    source: String(row.currency || '').toUpperCase() === 'EUR' ? 'system' : 'manual',
                    updated_at: iso(0),
                }));
                if (!currencyRates.some(row => row.currency === 'EUR')) {
                    currencyRates.unshift({ currency: 'EUR', rate: 1, source: 'system', updated_at: iso(0) });
                }
            }
            return json(currencyRates);
        }
        if (apiPath === '/currency/rates/refresh') return json(currencyRates);
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
                hint.innerHTML = 'Demo login: <strong>demo</strong> / <strong>demo</strong><br>Company admin: <strong>fleetadmin</strong> / <strong>demo</strong>';
                card.querySelector('form')?.prepend(hint);
            }
        }
    });
})();
