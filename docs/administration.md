# Administration

Routario includes several tools for managing the platform itself, accessible only to admin accounts.

---

## Backup & Restore

Routario can export a complete snapshot of the database and restore from a previous backup — useful before upgrades, migrations, or as part of a regular maintenance routine.

!!! warning "Admin only"
    Backup and restore endpoints require an admin account. Regular users cannot access them.

### Download a backup

Navigate to **Admin Panel → Backup → Download Backup**, or call the API directly:

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
- **`db.json`** — a full JSON dump of every database table.
- **`uploads/`** — uploaded files, when `web/uploads` exists.

The dump is compatible with any SQLAlchemy-supported database (PostgreSQL, MySQL, SQLite), so backups can be used to migrate between database engines.

### Restore from a backup

!!! danger "Destructive operation"
    Restoring a backup **replaces all existing data**. Every table is cleared before the backup data is inserted. This cannot be undone — take a fresh backup first if in doubt.

Upload a previously downloaded archive via **Admin Panel → Backup → Restore**, or use the API:

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

Routario does not have a built-in scheduler for backups. Use a cron job on the host or a container orchestrator to call the download endpoint on a schedule:

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

Access via **Admin Panel → Users → Impersonate** next to any non-admin account.

---

## User Management

Routario uses a three-tier role hierarchy:

| Role | Capabilities |
|---|---|
| **Super Admin** | Full access — manage all users, devices, companies, backup/restore, and impersonation |
| **Company Admin** | Manage users and devices within their assigned company; cannot access other companies or system-level settings |
| **Regular User** | Can only view devices they have been explicitly assigned |

### Managing users (super admin)

Super admins have full control over all user accounts:

- **Create users** — set username, email, password, and role. Company Admin and Regular User accounts must be assigned to a company.
- **Edit users** — update credentials or change the role via the role picker.
- **Delete users** — cascades to remove the user's device assignments and notification channels.
- **Assign devices** — grant or revoke access to specific devices per user.

Access via **Admin Panel → Users**.

### Managing users (company admin)

Company admins can create and manage users within their own company. They cannot access other companies or change super admin accounts.

---

## Permissions

On top of the three-tier role hierarchy, users can be granted fine-grained permissions that control exactly which parts of the platform they can access.

| Group | Permissions |
|---|---|
| **Devices** | View Devices, Edit Devices, Manage Alerts, Send Commands, Manage Integrations |
| **History & Reports** | View History, View Reports |
| **Fleet Operations** | Manage Drivers, Manage Fuel, Manage Maintenance, Manage Logbook |
| **Zones** | Manage Geofences |
| **Communication & Sharing** | Voice PTT, Live Share |
| **Administration** | View Management, Manage Users |

- **Super Admins** always have all permissions and cannot be restricted.
- **Permission capping** — a user can only grant permissions they hold themselves; they cannot escalate another user beyond their own access level.

Permissions are configured per user via **Admin Panel → Users → Edit**.

---

## Company Management

Companies let you partition users and devices into isolated groups. A user or device belongs to at most one company.

- **Create companies** — give each company a name.
- **Assign users** — toggle which users belong to a company. Mark specific users as Company Admin within that company.
- **Assign devices** — toggle which devices belong to a company. Company admins and their users only see devices assigned to their company.
- **App name** — optionally override the visible application name for users in that company.
- **Login slug** — optionally create a company-specific login URL such as `/login/acme`.
- **Custom icon** — optionally upload a company app icon. Routario generates the common PWA icon sizes from it.
- **Custom badge** — optionally upload a notification badge icon. This is stored separately because Android notification badges have stricter shape requirements.

Access via **Admin Panel → Companies** (super admin only).

### Company branding

Company branding is optional. If a company does not set custom branding, Routario uses the default application name and icons.

When branding is set:

- `/login/<slug>` loads the company app name and icon before login.
- Logged-in users in that company see the company app name in page titles and navigation.
- The PWA manifest uses the company app name and icon URLs.
- Browser push notifications use the company's icon and badge when available.

If a user logs in through a company slug and later logs out, Routario returns them to that company's login URL. If they then log into a company without a slug, the previous slug is cleared.
