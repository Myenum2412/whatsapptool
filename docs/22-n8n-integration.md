# 22 - n8n Integration

## Overview

MyWhatsapp provides official n8n community nodes for integrating WhatsApp automation into n8n workflows. This enables users to build powerful automations combining WhatsApp messaging with hundreds of other services available in n8n.

**Repository:** https://github.com/rmyndharis/OpenWA-n8n
**npm Package:** `@rmyndharis/n8n-nodes-mywhatsapp`

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   n8n Workflow  │────▶│  MyWhatsapp Node    │────▶│  MyWhatsapp API     │
│                 │     │  (credentials)  │     │  (your server)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   n8n Workflow  │◀────│ MyWhatsapp Trigger  │◀────│  Webhook POST   │
│   (triggered)   │     │  (listens)      │     │  from MyWhatsapp    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Installation

### Via n8n Community Nodes (Recommended)

1. Go to **Settings > Community Nodes**
2. Select **Install**
3. Enter `@rmyndharis/n8n-nodes-mywhatsapp`
4. Agree to the risks and install
5. Restart n8n

### Manual Installation

```bash
cd ~/.n8n/nodes
npm install @rmyndharis/n8n-nodes-mywhatsapp
```

## Nodes

### MyWhatsapp Node

Execute operations on your MyWhatsapp server.

#### Credentials Setup

| Field      | Description                          | Example                  |
| ---------- | ------------------------------------ | ------------------------ |
| Server URL | MyWhatsapp server URL (without /api) | `https://wa.example.com` |
| API Key    | API key from MyWhatsapp dashboard    | `owa_xxxxxxxx...`        |

#### Resources & Operations

| Resource | Operation     | Description                 | Endpoint                                        |
| -------- | ------------- | --------------------------- | ----------------------------------------------- |
| Session  | Get Status    | Get session status          | `GET /api/sessions/:id`                         |
| Session  | List All      | List all sessions           | `GET /api/sessions`                             |
| Message  | Send Text     | Send text message           | `POST /api/sessions/:id/messages/send-text`     |
| Message  | Send Image    | Send image (URL/Base64)     | `POST /api/sessions/:id/messages/send-image`    |
| Message  | Send Document | Send file/document          | `POST /api/sessions/:id/messages/send-document` |
| Message  | Send Location | Send location pin           | `POST /api/sessions/:id/messages/send-location` |
| Contact  | Check Exists  | Check if number on WhatsApp | `GET /api/sessions/:id/contacts/check/:number`  |
| Contact  | Get Info      | Get contact information     | `GET /api/sessions/:id/contacts/:contactId`     |
| Webhook  | Create        | Create a webhook            | `POST /api/sessions/:id/webhooks`               |
| Webhook  | Delete        | Delete a webhook            | `DELETE /api/sessions/:id/webhooks/:webhookId`  |

### MyWhatsapp Trigger Node

Start workflows when WhatsApp events occur.

#### Supported Events

| Event                                             | Description                                   | Use Case                                     |
| ------------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| `message.received`                                | New incoming message                          | Auto-reply, lead capture                     |
| `message.sent`                                    | Message sent successfully                     | Delivery confirmation                        |
| `message.ack`                                     | Delivery/read status advanced                 | Read receipts                                |
| `message.failed`                                  | Outgoing message failed                       | Failure alerting                             |
| `message.revoked`                                 | Message deleted for everyone                  | Deletion tracking                            |
| `message.reaction`                                | Reaction added / changed / removed            | Reaction tracking                            |
| `message.edited`                                  | Message body or caption edited                | Content synchronization                      |
| `status.received`                                 | Contact posted a Status update                | Status archiving                             |
| `session.status`                                  | Session status changed                        | Lifecycle tracking                           |
| `session.qr`                                      | QR code generated                             | Reconnection alerts                          |
| `session.authenticated`                           | Session logged in (phone available)           | Startup notifications                        |
| `session.disconnected`                            | Session lost connection                       | Alert monitoring                             |
| `session.reconnect_loop`                          | Every 5th consecutive reconnect attempt       | Stuck-session alerting                       |
| `session.restriction`                             | WhatsApp restricted the account, or lifted it | Pausing outreach while an account is limited |
| `presence.update`                                 | A watched chat's online/typing state changed  | Live agent hand-off, presence-aware routing  |
| `call.accepted` / `call.rejected` / `call.missed` | A ringing call ended — **Baileys only**       | Missed-call follow-up, call logging          |
| `group.join`                                      | Participant(s) joined a group                 | Welcome messages                             |
| `group.leave`                                     | Participant(s) left a group                   | Churn tracking                               |
| `group.update`                                    | Group subject/description/settings changed    | Group administration                         |
| `group.join_request`                              | Someone asked to join an administered group   | Auto-approve/vet join requests               |
| `call.received`                                   | Call ringing, not reliable on whatsapp-web.js | Auto-reject + auto-reply bots                |

> [!NOTE]
> The three call-outcome events fire on Baileys only: whatsapp-web.js has no call-outcome event, so a
> workflow triggered on `call.missed` never runs on a whatsapp-web.js session. `call.received` fires
> on both engines but is not reliable on whatsapp-web.js: it fired in a live test on 2026-09-17 and
> did not in one on 2026-08-10. Rejecting a call, the session's auto-reject setting included, is
> Baileys only: a rejection sent by whatsapp-web.js did not stop the call from ringing in a live
> test. Reliable call automation needs a gateway running `ENGINE_TYPE=baileys`. The caller in `from`
> may be an `@lid` privacy id on either engine; resolve it with
> `GET /api/sessions/{sessionId}/contacts/{contactId}/phone`.

#### How It Works

1. When workflow is activated, the trigger creates a webhook in MyWhatsapp
2. MyWhatsapp sends events to n8n's webhook URL
3. When workflow is deactivated, the webhook is automatically deleted

#### Output Data Format

```json
{
  "event": "message.received",
  "timestamp": "2024-01-15T10:30:00Z",
  "sessionId": "default",
  "idempotencyKey": "a1b2c3d4e5f6...",
  "deliveryId": "9f8e7d6c5b4a...",
  "data": {
    "id": "3EB0F5A2B4C...",
    "chatId": "628123456789@c.us",
    "from": "628123456789@c.us",
    "body": "Hello!",
    "type": "text",
    "timestamp": 1705312200
  }
}
```

> **Deduplication.** Every delivery includes `idempotencyKey` and `deliveryId` in the body **and** as the
> `X-MyWhatsapp-Idempotency-Key` / `X-MyWhatsapp-Delivery-Id` headers. `idempotencyKey` is **stable across retries**
> of the same event; `deliveryId` identifies one delivery to one webhook and is stable across that
> delivery's retry attempts too — read the `X-MyWhatsapp-Retry-Count` header for the attempt number. Because a
> webhook can be retried, add a dedup step keyed on `idempotencyKey` (e.g. an n8n IF or "Remove Duplicates"
> node) so a retried delivery isn't processed twice.

## Example Workflows

### 1. Auto-Reply Bot

Automatically reply to incoming messages with a welcome message.

```
[MyWhatsapp Trigger] → [IF: Check keyword] → [MyWhatsapp: Send Text]
     │
     └── Events: message.received
```

**Configuration:**

- Trigger: `message.received`
- IF Node: Check if `{{$json.data.body}}` contains "hello"
- MyWhatsapp: Send Text with welcome message

### 2. Lead Collection to Google Sheets

Capture incoming messages and save to Google Sheets.

```
[MyWhatsapp Trigger] → [Google Sheets: Append] → [MyWhatsapp: Send Text]
     │                    │
     │                    └── Save: name, phone, message
     └── Events: message.received
```

### 3. Session Monitoring

Get notified on Slack when WhatsApp session disconnects.

```
[MyWhatsapp Trigger] → [Slack: Send Message]
     │
     └── Events: session.disconnected
```

**Slack Message:**

```
⚠️ WhatsApp session "{{$json.sessionId}}" disconnected!
Time: {{$json.timestamp}}
Please check and reconnect.
```

### 4. Order Notification

Send WhatsApp notification when new order is received.

```
[Webhook: New Order] → [MyWhatsapp: Send Text]
                            │
                            └── "Thank you for your order #{{$json.orderId}}"
```

### 5. Scheduled Reminders

Send daily reminders to a list of contacts.

```
[Schedule Trigger] → [Google Sheets: Get Rows] → [Loop] → [MyWhatsapp: Send Text]
     │                      │                                    │
     └── Daily 9AM          └── Get contacts                     └── Send reminder
```

### 6. Appointment Booking

Collect appointment requests over WhatsApp, check availability in an external scheduling source, and send a confirmation or alternative time slots.

See [n8n Appointment Booking Workflow](./examples/n8n-appointment-booking.md) for a complete example.

```
[MyWhatsapp Trigger] → [IF: Booking intent?] → [Set: Normalize request]
                                               │
                                               ▼
                                      [Availability Source]
                                               │
                         ┌─────────────────────┴─────────────────────┐
                         ▼                                           ▼
              [Create Booking] → [MyWhatsapp: Send Text]      [MyWhatsapp: Send Text]
                  confirmed confirmation                  alternative slots
```

## Best Practices

### 1. Error Handling

Always add error handling in your workflows:

```
[MyWhatsapp Node] → [IF: Check success] → [Continue...]
                      │
                      └── [Error Handler]
```

### 2. Rate Limiting

WhatsApp has rate limits. Add delays between messages:

```
[Loop Over Items] → [Wait: 2 seconds] → [MyWhatsapp: Send Text]
```

### 3. Message Formatting

Use WhatsApp formatting in your messages:

- Bold: `*text*`
- Italic: `_text_`
- Strikethrough: `~text~`
- Monospace: `` `text` ``

### 4. Phone Number Format

Always use the correct format for chat IDs:

- Personal: `628123456789@c.us`
- Group: `123456789-123456789@g.us`

## Troubleshooting

### Credential Test Failed

1. Verify MyWhatsapp server is running
2. Check API key is correct
3. Ensure server URL doesn't have trailing slash
4. Verify network connectivity between n8n and MyWhatsapp

### Trigger Not Receiving Events

1. **Confirm you registered the production webhook URL, not the test one.** n8n gives every Webhook
   node two URLs: a test URL (`https://your-n8n/webhook-test/…`) and a production URL
   (`https://your-n8n/webhook/…`). The test URL is registered only while the editor is listening and
   stops after a single request, so a workflow wired to it receives one event and then goes silent.
   Activate the workflow and point MyWhatsapp at the production URL.
2. Check webhook was created in MyWhatsapp dashboard
3. Verify n8n webhook URL is accessible from MyWhatsapp server
4. Check firewall/proxy settings
5. Ensure session is connected and active
6. For a call trigger, check the session's engine: the call-outcome events never fire on
   whatsapp-web.js and `call.received` is not reliable there (see the note under the trigger event
   table above)
7. Ask MyWhatsapp which side dropped the event:
   `GET /api/webhooks/delivery-failures?sessionId={sessionId}` (orgmenu key). A row means MyWhatsapp
   delivered and n8n rejected it; an empty list means the event never reached delivery at all

### Message Not Sending

1. Verify session status is `ready` (the API returns lowercase status values)
2. Check chat ID format is correct
3. Ensure recipient number exists on WhatsApp
4. Check message content isn't empty

## Development

### Building from Source

```bash
git clone https://github.com/rmyndharis/OpenWA-n8n.git
cd MyWhatsapp-n8n
npm install
npm run build
```

### Local Development

```bash
# Watch mode
npm run dev

# Link to local n8n
cd ~/.n8n/nodes
npm link /path/to/MyWhatsapp-n8n
```

### Testing

Test your changes with a local n8n instance:

```bash
# Start n8n
n8n start

# Or with Docker
docker run -it --rm \
  -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  n8nio/n8n
```

## Related Documentation

- [MyWhatsapp API Specification](./06-api-specification.md)
- [Webhook System](./03-system-architecture.md#353-webhook-system)
- [n8n Appointment Booking Workflow](./examples/n8n-appointment-booking.md)
- [n8n Documentation](https://docs.n8n.io/)

---

<div align="center">

[← 21 - Glossary](./21-glossary.md) · [Documentation Index](./README.md)

</div>
