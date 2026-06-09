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
| **User Fleet** | Company-admin report for user readiness: assigned vehicles, push status, channels, webhooks, alerts, permissions, and last activity. |
| **Vehicle Sensors** | Current vehicle sensor values, or historical sensor rows over a selected date range. |
| **Alerts** | Alert history over a selected period, with optional user filtering for admins. |

---

## Filtering

Reports expose their supported filters through metadata:

- **Date range** — required for reports that aggregate over time.
- **Vehicle filter** — available for vehicle-based reports.
- **User filter** — available for Alerts and User Fleet reports when the current user can see users.
- **Driver filter** — used by Daily Activity when grouping by drivers.
- **Historical toggle** — used by Vehicle Sensors to switch between current and historical data.
- **Custom controls** — report-defined controls such as Daily Activity's `group_by` selector.

The frontend reads this metadata from `/api/reports/types` and renders the controls automatically.

---

## Scheduled Reports

Reports can be scheduled from the Reports page.

Each schedule stores:

- report type
- report-specific filters
- date range preset, when required
- frequency: daily, weekly, or monthly
- run time and timezone
- number of stored runs to keep
- active/paused state

The background schedule runner dispatches through the same report registry used by manual reports, so scheduled and manual output share the same schema.

Stored runs can be opened later from the schedule history and exported as CSV.

---

## CSV Export

CSV output is generated from the same backend-provided column schema shown in the table. A report can hide a column from CSV by setting `csv` to `false` on that column.

The report payload also defines the CSV filename.

---

## Row Actions

Reports may define a generic row action. The built-in supported action is:

| Action | Description |
|---|---|
| `trip_map` | Makes each row clickable and opens the trip route map using the row's trip fields. |

The Trip List report uses this action.

---

## Extending Reports

For implementation details and examples for adding a new report, see [Extending Routario](extending.md#adding-a-report).
