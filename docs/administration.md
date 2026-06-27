# Administration

Routario includes several tools for managing users, companies, security, backups, billing, and operational visibility. Access is role- and permission-based, so company admins only see and manage data inside their own company unless they are super admins.

---

## Backup & Restore

Routario can export a portable backup archive and restore from a previous backup. Backup scope depends on the account:

- **Super Admins** can download and restore full platform backups.
- **Company Admins** with the **Backup & Restore** permission can download and restore only their own company data.
- **Regular users** cannot access backup or restore, even if they have other settings permissions.

!!! warning "Scoped restore"
    Company backups are bound to the company they were created from. Restoring a company backup only affects that company and is rejected for other companies.

### Download a backup

Navigate to **User Settings → Backups → Create Backup**, or call the API directly:

```bash
TOKEN=$(curl -s http://localhost:8000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin_password"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')

curl -H "Authorization: Bearer $TOKEN" \
     http://localhost:8000/api/admin/backup/download \
     -o routario-backup.tar.gz
```

The archive is a `.tar.gz` file containing:

- **`manifest.json`** — backup metadata.
- **`db.json`** — a JSON dump of the full platform for super admins, or company-scoped rows for company admins.
- **`uploads/`** — related uploaded files, when `web/uploads` exists.

The dump is compatible with any SQLAlchemy-supported database (PostgreSQL, MySQL, SQLite), so backups can be used to migrate between database engines.

### Restore from a backup

!!! danger "Destructive operation"
    Restoring a super-admin backup replaces platform data. Restoring a company backup replaces data for that company. This cannot be undone - take a fresh backup first if in doubt.

Upload a previously downloaded archive via **User Settings → Backups → Restore Backup**, or use the API:

```bash
TOKEN=$(curl -s http://localhost:8000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin_password"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')

curl -H "Authorization: Bearer $TOKEN" \
     -X POST http://localhost:8000/api/admin/backup/restore \
     -F "file=@routario-backup.tar.gz"
```

### Scheduling automated backups

Routario does not have a built-in scheduler for backups. Use a cron job on the host or a container orchestrator to call the download endpoint on a schedule. Use a super-admin token for full backups, or a company-admin token with **Backup & Restore** permission for company-scoped backups:

```cron
# Daily backup at 02:00, kept for 30 days
0 2 * * * TOKEN=$(curl -s http://localhost:8000/api/login -H "Content-Type: application/json" -d '{"username":"admin","password":"changeme"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])') && curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/admin/backup/download -o /backups/routario-$(date +\%F).tar.gz && find /backups -name "routario-*.tar.gz" -mtime +30 -delete
```

---

## User Impersonation

Admins can temporarily act as any user in the system to diagnose permission or configuration issues without knowing the user's password.

- An **impersonation banner** is shown on every page while acting as another user as a clear visual reminder.
- All actions taken during impersonation are performed in the context of that user's account (device visibility, notification channels, etc.).
- Impersonation ends when the admin explicitly exits the session.

Access via **Management → Users → Impersonate** next to any non-admin account.

---

## User Management

Routario uses a three-tier role hierarchy:

| Role | Capabilities |
|---|---|
| **Super Admin** | Full access - manage all users, devices, companies, backup/restore, and impersonation |
| **Company Admin** | Manage users and devices within their assigned company; cannot access other companies or system-level settings |
| **Regular User** | Can only view devices they have been explicitly assigned |

### Managing users (super admin)

Super admins have full control over all user accounts:

- **Create users** — set username, email, password, and role. Company Admin and Regular User accounts must be assigned to a company.
- **Edit users** — update credentials or change the role via the role picker.
- **Delete users** — cascades to remove the user's device assignments and notification channels.
- **Assign devices** — grant or revoke access to specific devices per user.

Access via **Management → Users**.

### Managing users (company admin)

Company admins can create and manage users within their own company. They cannot access other companies or change super admin accounts.

---

## Permissions

On top of the three-tier role hierarchy, users can be granted fine-grained permissions that control exactly which parts of the platform they can access.

| Group | Permissions |
|---|---|
| **Devices & Integrations** | View Devices, Edit Devices, Send Commands, Manage Integrations |
| **Monitoring & Reports** | Manage Alerts, Manage Geofences, View History, View Reports |
| **Fleet Operations** | Manage Drivers, Manage Fuel, Manage Maintenance, Manage Logbook, Manage Routes |
| **Communication & Sharing** | Voice PTT, Live Share |
| **Administration** | View Management, Manage Users, View Audit Log, View Health Checks |
| **Account Tools** | Manage API Keys, Manage Users' MFA, Backup & Restore |

- **Super Admins** always have all permissions and cannot be restricted.
- **Permission capping** — a user can only grant permissions they hold themselves; they cannot escalate another user beyond their own access level.
- **Backup & Restore** can only be assigned to company admins. Normal users cannot back up or restore company data.

Permissions are configured per user via **Management → Users → Edit**.

---

## API Keys

Users with **Manage API Keys** can create scoped API keys for automation and integrations. Super admins can manage all keys, company admins can manage keys in their company, and regular users with the permission can manage their own keys.

Available key scopes:

| Scope | Allows |
|---|---|
| `devices:read` | Read device data |
| `devices:write` | Create or update device data |
| `positions:read` | Read position/history data |
| `commands:send` | Send device commands |
| `reports:read` | Run reports |
| `routes:read` | Read planned routes |
| `routes:write` | Create, update, and delete planned routes |
| `billing:read` | Read billing data |

API keys are shown only once when created. Stored keys are hashed, can be expired, and can be revoked.

---

## Multi-Factor Authentication

Every user can set up authenticator-app MFA and recovery codes for their own account from **User Settings → Profile**. The **Manage Users' MFA** permission is only for administering MFA on other users.

- Super admins can manage MFA across the platform.
- Company admins with **Manage Users' MFA** and **Manage Users** can manage MFA only for users in their company.
- Disabling MFA for your own account requires a valid authenticator code or recovery code.
- Admin-disabling MFA for another managed user does not require that user's current code.

## Passkeys

Users can register passkeys from **User Settings → Profile** and then sign in using the **Sign in with passkey** button on the login page. Passkeys use WebAuthn, resident keys, and user verification.

- Users can rename or remove their own passkeys.
- Admins can view, rename, or remove passkeys from the user edit modal for users they are allowed to manage.
- New passkeys can only be registered by the signed-in user for their own account.

---

## Audit Log

Users with **View Audit Log** can review recorded administrative and security events from **Management → Audit Log**.

- Company admins see only audit events for their own company.
- Super admins can filter across companies.
- Filters include action, actor, company, date range, limit, and offset.

---

## Health Checks

The health endpoints are useful for uptime checks and deployment readiness checks:

| Endpoint | Purpose |
|---|---|
| `/health/live` | Basic process liveness |
| `/health/ready` | Database, disk, Redis, Valhalla, protocol listeners, background tasks, ingestion freshness, integration accounts, and runtime info |
| `/health` | Alias for readiness |

Readiness requires the database, disk, expected protocol listeners, and background tasks to pass. Redis is optional. Valhalla is reported separately and marked degraded when Valhalla is enabled but unavailable.

The readiness payload also includes:

- **Protocol listeners** — compares protocols used by active devices with the TCP/UDP listeners currently running.
- **Background tasks** — verifies alert checks, integration polling, and scheduled report processing are still running and recently completed a loop.
- **Ingestion freshness** — reports active devices, online devices, latest position age, never-seen devices, and stale device samples.
- **Integration accounts** — reports active integration accounts, assigned device counts, last authentication time, and last error.
- **Disk** — checks writeability and reports free/used space for upload paths, including dashcam and voice uploads.
- **Database** — checks query latency and reports pool class, size, connections in pool, checked-out connections, overflow, and database type when available.
- **Redis** — checks reachability and shows whether WebSocket pub/sub is using Redis or in-process fallback.
- **Runtime** — shows app version, git commit when available, process start time, uptime, Python version, platform, and database type.

---

## Route Planning

Users with **Manage Routes** can create planned routes with stops, assign them to vehicles, preview route geometry, and track route status.

- Planned routes are company-scoped.
- Route geometry uses Valhalla when available and falls back to straight-line geometry when routing is unavailable.
- Unassigned routes are saved as `draft`; assigned routes are saved as `planned`.
- Active routes can be paused, resumed, finished as `completed`, or reset back to `planned`/`draft` based on assignment.
- Once a route is active or paused, core route details such as name, assigned vehicle, and stops cannot be edited.
- Starting a route requires an assigned vehicle.

---

## Billing

Billing administration is super-admin only. Company admins and regular users do not receive a billing permission.

- Billing plans define base price, included devices, included position records, included API calls, and overage rates.
- Companies can be assigned a billing plan from **Management → Companies** or from the billing plan editor.
- Billing plan management is available from **Management → Billing** for super admins.
- Usage is calculated from active devices, stored position records, and API usage events.
- Billing reports and billing detail views are generated from **Fleet Reports**, not from the Billing tab.
- Invoices store a snapshot of billing currency, exchange rate, totals, and usage at generation time.

---

## Company Management

Companies let you partition users and devices into isolated groups. A user or device belongs to at most one company.

- **Create companies** — give each company a name and optionally assign a billing plan.
- **Assign users** — toggle which users belong to a company. Mark specific users as Company Admin within that company.
- **Assign devices** — toggle which devices belong to a company. Company admins and their users only see devices assigned to their company.
- **App name** — optionally override the visible application name for users in that company.
- **Login slug** — optionally create a company-specific login URL such as `/login/acme`.
- **Custom icon** — optionally upload a company app icon. Routario generates the common PWA icon sizes from it.
- **Custom badge** — optionally upload a notification badge icon. This is stored separately because Android notification badges have stricter shape requirements.

Access via **Management → Companies** (super admin only).

### Company branding

Company branding is optional. If a company does not set custom branding, Routario uses the default application name and icons.

When branding is set:

- `/login/<slug>` loads the company app name and icon before login.
- Logged-in users in that company see the company app name in page titles and navigation.
- The PWA manifest uses the company app name and icon URLs.
- Browser push notifications use the company's icon and badge when available.

If a user logs in through a company slug and later logs out, Routario returns them to that company's login URL. If they then log into a company without a slug, the previous slug is cleared.
