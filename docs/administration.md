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
curl -u admin:password http://localhost:8000/api/admin/backup/download \
     -o routario-backup.tar.gz
```

The archive is a `.tar.gz` file containing:

- **`database.json`** — a full JSON dump of every database table, one JSON object per row.

The dump is compatible with any SQLAlchemy-supported database (PostgreSQL, MySQL, SQLite), so backups can be used to migrate between database engines.

### Restore from a backup

!!! danger "Destructive operation"
    Restoring a backup **replaces all existing data**. Every table is cleared before the backup data is inserted. This cannot be undone — take a fresh backup first if in doubt.

Upload a previously downloaded archive via **Admin Panel → Backup → Restore**, or use the API:

```bash
curl -u admin:password \
     -X POST http://localhost:8000/api/admin/backup/restore \
     -F "file=@routario-backup.tar.gz"
```

### Scheduling automated backups

Routario does not have a built-in scheduler for backups. Use a cron job on the host or a container orchestrator to call the download endpoint on a schedule:

```cron
# Daily backup at 02:00, kept for 30 days
0 2 * * * curl -s -u admin:changeme http://localhost:8000/api/admin/backup/download \
           -o /backups/routario-$(date +\%F).tar.gz \
           && find /backups -name "routario-*.tar.gz" -mtime +30 -delete
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

Admins have full control over all user accounts:

- **Create users** — set username, email, password, and role (admin or regular user).
- **Edit users** — update credentials or change the role.
- **Delete users** — cascades to remove the user's device assignments and notification channels.
- **Assign devices** — grant or revoke access to specific devices per user. Regular users only see their assigned devices.

Access via **Admin Panel → Users**.
