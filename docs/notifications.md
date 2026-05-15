# Notifications

Routario can deliver alerts to virtually any messaging service. It uses the [Apprise](https://appriseit.com/services/) library as a catch-all backend, so anything Apprise supports works out of the box.

---

## How Notifications Work

Each user configures their own set of **notification channels** — named URL endpoints that Routario calls when an alert fires. When an alert is triggered for a device, Routario checks which channels are selected for that alert type and dispatches to each one.

If no channels are configured or selected for an alert, Routario falls back to **browser push notifications** (if the user has granted permission and VAPID keys are configured on the server).

!!! info "Per-user channels"
    Channels are per-user. Each user manages their own notification URLs in **User Settings → Notification Channels**. Different users can receive the same alert via different services.

---

## Configuring Channels

1. Go to **User Settings → Notification Channels**.
2. Enter a **name** (used to identify the channel in alert configuration) and an **Apprise URL**.
3. Click **Add** — the channel is saved immediately.
4. When configuring an alert rule on a device, select this channel name in the *Notify Via* dropdown.

---

## Supported Channels

Any URL scheme supported by [Apprise](https://appriseit.com/services/) works. The most commonly used channels are listed below.

### Telegram

Create a bot via [@BotFather](https://t.me/BotFather), note the bot token, and find your chat ID.

```
tgram://<bot_token>/<chat_id>
```

```
tgram://110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/-1001234567890
```

---

### Email

Uses the `mailto://` scheme. Most SMTP providers are supported.

```
mailto://<user>:<password>@<smtp_host>/<recipient>
```

Gmail example (use an App Password if 2FA is enabled):

```
mailto://myemail@gmail.com:apppassword@gmail.com/recipient@example.com
```

---

### Slack

```
slack://<token_a>/<token_b>/<token_c>/<channel>
```

Get your token parts from a Slack Incoming Webhook URL. See the [Apprise services list](https://appriseit.com/services/) for details.

---

### Discord

Create a webhook in your Discord server's channel settings and extract the ID and token from the URL.

```
discord://<webhook_id>/<webhook_token>
```

---

### NTFY

Works with the public [ntfy.sh](https://ntfy.sh) service or a self-hosted instance.

```
ntfy://<host>/<topic>
```

---

### Pushover

```
pover://<user_key>@<app_token>
```

---

### WhatsApp (via Twilio)

```
twilio://<account_sid>:<auth_token>@<from_number>/<to_number>
```

---

### Signal (via signal-cli)

```
signal://<host>:<port>/<sender_number>/<recipient_number>
```

---

## SIP Voice Call

Routario includes a built-in SIP channel that places an outbound voice call when an alert fires. The alert message is read aloud using text-to-speech (TTS), or a pre-recorded audio file can be played instead.

!!! info "Dependencies"
    The SIP channel requires `pjsua` (part of [PJSIP](https://www.pjsip.org/)) to be installed on the Routario host. For gTTS-based TTS, `gtts` must also be available. Install with `pip install gtts`.

### URL format

```
sip://<username>:<password>@<server>:<port>/<extension>?<options>
```

### Options

| Parameter | Default | Description |
|---|---|---|
| `file` | — | Path to a pre-recorded WAV file to play instead of TTS, e.g. `file=/audio/alert.wav` |
| `repeat` | `1` | How many times to repeat the message |
| `pause` | `2` | Seconds of silence between repetitions |
| `tts` | `gtts` | TTS engine: `gtts` (Google TTS) or `espeak`. Ignored when `file=` is set. |
| `lang` | `en` | BCP-47 language code for TTS, e.g. `en`, `de`, `fr`. Ignored when `file=` is set. |

### Examples

```
# TTS call, repeated twice in English
sip://user:pass@192.168.1.100/1001?repeat=2&lang=en

# Pre-recorded WAV file, repeated 3 times
sip://user:pass@192.168.1.100/1001?file=/audio/alert.wav&repeat=3

# TTS in German via espeak
sip://user:pass@pbx.example.com:5060/200?tts=espeak&lang=de
```

---

## Webhooks

Each user can configure **Webhook URLs** under **User Settings → Webhooks**. Routario sends a JSON `POST` to every configured URL on two events: every **position update** and every **alert**. The `event` field in the payload distinguishes the two.

**Compatible platforms:** Home Assistant · n8n · Zapier · Make (Integromat) · any HTTP server

### Position payload

Sent on every incoming GPS position update.

```json
{
  "device_id": 1,
  "device_name": "Truck 1",
  "imei": "123456789012345",
  "vehicle_type": "truck",
  "license_plate": "AB-1234",
  "latitude": 37.9838,
  "longitude": 23.7275,
  "speed": 62.5,
  "course": 180.0,
  "altitude": 45.0,
  "satellites": 9,
  "ignition": true,
  "timestamp": "2024-06-01T12:00:00+00:00",
  "sensors": {
    "battery_voltage": 12.6,
    "fuel_level": 74
  }
}
```

### Alert payload

Sent whenever an alert fires for the device. Receivers can check `"event": "alert"` to distinguish this from a position update.

```json
{
  "event": "alert",
  "device_id": 1,
  "device_name": "Truck 1",
  "imei": "123456789012345",
  "vehicle_type": "truck",
  "license_plate": "AB-1234",
  "alert_type": "speeding",
  "severity": "warning",
  "message": "Speed 95 km/h exceeded limit of 80 km/h",
  "latitude": 37.9838,
  "longitude": 23.7275,
  "timestamp": "2024-06-01T12:00:00+00:00",
  "metadata": {}
}
```

Possible `alert_type` values: `speeding` · `idling` · `geofence_enter` · `geofence_exit` · `offline` · `towing` · `maintenance` · `low_battery` · `device_event` · `custom`

Possible `severity` values: `info` · `warning` · `critical`

---

## Browser Push Notifications

Routario supports the **Web Push API** for delivering notifications directly to your browser — even when the tab is not open.

### Server setup

Generate a VAPID key pair and configure them in your environment — see [Configuration](configuration.md#push-notifications-vapid).

### User setup

1. Open the Routario dashboard and grant notification permission when prompted.
2. Your browser's push subscription is saved automatically.
3. Alerts will now arrive as system notifications.

!!! tip
    Browser push is the **fallback** when no explicit notification channels are configured for an alert. If Apprise channels are configured, they take priority.

---

## Adding Custom Notification Channels

See [Extending Routario → Adding a Notification Channel](extending.md#adding-a-notification-channel).
