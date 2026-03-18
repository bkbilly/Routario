# Notifications

Routario can deliver alerts to virtually any messaging service. It uses the [Apprise](https://github.com/caronc/apprise) library as a catch-all backend, so anything Apprise supports works out of the box.

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

Any URL scheme supported by [Apprise](https://github.com/caronc/apprise/wiki) works. The most commonly used channels are listed below.

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

Get your token parts from a Slack Incoming Webhook URL. See [Apprise Slack docs](https://github.com/caronc/apprise/wiki/Notify_slack).

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

## Webhooks

In addition to Apprise channels, each user can configure **Webhook URLs** — raw HTTP endpoints that receive a JSON `POST` payload when an alert fires. Ideal for connecting Routario to home automation or no-code platforms.

**Compatible platforms:** Home Assistant · n8n · Zapier · Make (Integromat) · any HTTP server

Configure webhooks under **User Settings → Webhooks**. Routario sends a `POST` request with a JSON body containing the alert type, message, device name, severity, and coordinates.

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

The notification system is auto-discovering. To add a custom channel handler:

1. Create a new `.py` file in `app/notifications/`.
2. Subclass `BaseNotificationChannel`.
3. Implement `matches(url)` — return `True` if this class handles the URL scheme.
4. Implement `async send(url, title, message)` — deliver the notification and return `True` on success.

No registration step is needed — the channel is discovered automatically on the next restart.

```python
from notifications.base import BaseNotificationChannel

class MyChannel(BaseNotificationChannel):

    @classmethod
    def matches(cls, url: str) -> bool:
        return url.startswith("myscheme://")

    async def send(self, url: str, title: str, message: str) -> bool:
        # Implement delivery logic here
        return True
```

!!! info
    The built-in `AppriseChannel` is named with a `z_` prefix so it sorts last and only handles URLs that no other channel claimed first.
