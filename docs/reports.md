# Reports

Routario reports are backend-defined. Each report lives as a Python module under `app/reports/` and returns both the data and the presentation schema used by the frontend.

This means adding a new report does not require editing `reports.js`: create a new report file, define its metadata, controls, columns, summary cards, rows, CSV filename, and optional row action.

---

## Built-In Reports

| Report | Description |
|---|---|
| **Fleet Summary** | Per-vehicle totals for trips, distance, driving time, average speed, and top speed. |
| **Trip List** | Individual trips with start/end time, locations, distance, duration, speed, assigned driver, and a clickable map view. |
| **Daily Activity** | Daily totals grouped by the whole fleet, by vehicle, or by driver. |
| **Driver Activity** | Per-driver totals for trips, distance, driving time, speed, and vehicles used. |
| **Logbook** | Selectable fuel or maintenance report for vehicle fuel fill-ups, service entries, and configured maintenance due items. |
| **Geofence Activity** | Geofence enter and exit activity by vehicle, geofence, event, and notification recipient. |
| **User Fleet** | Company-admin report for user readiness: assigned vehicles, push status, channels, webhooks, alerts, permissions, and last activity. |
| **Vehicle Sensors** | Current vehicle sensor values, or historical sensor rows over a selected date range. |
| **Alerts** | Alert history over a selected period, with optional user filtering for admins. |
| **Billing** | Draft billing usage, totals, and company billing details for a selected billing period. |
| **Audit** | Super-admin report for administrative and security events. |

---

## Filtering

Reports expose their supported filters through metadata:

- **Date range** — required for reports that aggregate over time.
- **Vehicle filter** — available for vehicle-based reports.
- **User filter** — available for Alerts and User Fleet reports when the current user can see users.
- **Driver filter** — used by Daily Activity when grouping by drivers.
- **Historical toggle** — used by Vehicle Sensors to switch between current and historical data.
- **Custom controls** — report-defined controls such as Daily Activity's `group_by` selector or Billing's period selector.

The frontend reads this metadata from `/api/reports/types` and renders the controls automatically.

---

## Scheduled Reports

Reports can be scheduled from the Reports page.

Each schedule stores:

- report type
- report-specific filters
- backend-defined report options, such as breakdown or report period selectors
- date range preset, when required
- frequency: daily, weekly, or monthly
- run time and timezone
- number of stored runs to keep
- optional notification channels
- whether generated result files and related uploaded documents should be attached
- active/paused state

Date ranges are stored as relative presets rather than fixed start/end dates, so a recurring schedule can run against windows such as the last 30 days or last calendar month.

The background schedule runner dispatches through the same report registry used by manual reports, so scheduled and manual output share the same schema and report-specific options. When notification channels are selected, the runner sends the result to those channels and attaches a CSV plus printable HTML result file. Reports that expose related uploaded documents, such as logbook maintenance entries, can attach those documents too.

Reports can expose different controls for manual runs and schedules. For example, manual billing reports can target any year/month, while scheduled billing reports use relative presets such as this month, last month, this year, or last year.

The Audit report is available only to super admins and replaces the former standalone Audit tab.

Stored runs can be opened later from the schedule history and exported as CSV.

---

## CSV Export

CSV output is generated from the same backend-provided column schema shown in the table. PDF export uses the same visible report rows in a print-friendly browser document. A report can hide a column from CSV/PDF by setting `csv` to `false` or `hidden` to `true` on that column.

The report payload also defines the CSV filename.

---

## Row Actions

Reports may define a generic row action. The built-in supported action is:

| Action | Description |
|---|---|
| `trip_map` | Makes each row clickable and opens the trip route map using the row's trip fields. |
| `billing_detail` | Makes each billing row clickable and opens the billing detail view for that company and period. |

The Trip List and Billing reports use row actions.

---

## Extending Reports

For implementation details and examples for adding a new report, see [Extending Routario](extending.md#adding-a-report).
