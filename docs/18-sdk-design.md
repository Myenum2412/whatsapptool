# 18 - SDK Design

## 18.1 Overview

MyWhatsapp ships five official, hand-written client libraries for the REST API. They are not generated from an OpenAPI spec — each is written directly against the real API surface (paths, request DTOs, response shapes) and **unit-tested with a mocked HTTP transport that asserts on the exact request path, method, and body**, so drift in what an SDK _sends_ is caught at test time rather than in production. That mechanism says nothing about what an SDK expects _back_; see §18.6 for how response shapes are held to the contract.

| Language                | Package                                                                                 | Install                           | Notes                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| JavaScript / TypeScript | [`@mywhatsapp/sdk`](https://www.npmjs.com/package/@mywhatsapp/sdk)                      | `npm install @mywhatsapp/sdk`     | Dual ESM + CJS, bundled `.d.ts` types, Node 18+                                  |
| Python                  | [`mywhatsapp-sdk`](https://pypi.org/project/mywhatsapp-sdk/)                            | `pip install mywhatsapp-sdk`      | Synchronous (httpx), PEP 561 typed, Python 3.9+                                  |
| PHP                     | [`mywhatsapp/sdk`](https://packagist.org/packages/mywhatsapp/sdk)                       | `composer require mywhatsapp/sdk` | Synchronous (Guzzle 7), PSR-4, PHP 8.1+                                          |
| Java                    | [`com.mywhatsapp:mywhatsapp`](https://central.sonatype.com/artifact/com.mywhatsapp/sdk) | Maven Central                     | Sync, `java.net.http`. See [`sdk/java/README.md`](../sdk/java/README.md).        |
| Go                      | [`github.com/rmyndharis/OpenWA/sdk/go`](../sdk/go)                                      | `go get`                          | Stdlib-only, no third-party deps. See [`sdk/go/README.md`](../sdk/go/README.md). |

> The import names differ from the dist names where the ecosystem requires it. Python installs `mywhatsapp-sdk` but imports `mywhatsapp`; the client class is `MyWhatsappClient` in JS/Python and `MyWhatsapp\Client` in PHP.

### Design Principles

- **One client, fluent resources.** A single client object (`MyWhatsappClient` / `MyWhatsapp\Client`) exposes every resource as a property — `client.messages.sendText(...)`, `client.sessions.start(...)`. All five SDKs expose the **same** resource surface; only the language idioms differ (camelCase methods + objects in JS/PHP/Java, snake_case methods + dicts in Python, exported fields + structs in Go).
- **It is a request/response client, not an event SDK.** There is no WebSocket, EventEmitter, or `client.on(...)`. To receive inbound messages and acks, register a webhook (the `webhooks` resource) and host your own receiver, or connect to the real-time Socket.IO API directly (see [API Specification §6.5](./06-api-specification.md)).
- **Typed errors.** Non-2xx responses raise/throw a typed error mapped from the HTTP status (`401/403/404/409/429/501`), plus a timeout error — all `instanceof`/`catch`-checkable. See each language's Error Handling subsection.
- **Injectable transport.** The HTTP layer is replaceable (`fetch` in JS, an `httpx` transport in Python, a Guzzle client in PHP) — the extension point for retry/observability middleware and for testing without the network.
- **Safe by default.** Redirects are never followed (so the API key is never re-sent to a redirect target), the auth/JSON headers always take precedence over caller-supplied defaults, path segments are percent-encoded, a base-URL path prefix (e.g. behind a reverse proxy at `/v1`) is preserved, and there is a default 30s per-request timeout. **No automatic retries by default** — in JS, Python, PHP, and Java wrap calls in your own backoff if you need them (especially for `429`); the Go SDK additionally ships an opt-in `WithRetry(RetryPolicy)` that never replays a `POST` after a network error and limits `POST` retries to `429`/`503`.

### Resource Coverage

All five SDKs expose the same fluent surface:

| Resource    | Methods                                                                                                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`  | list, get, getConfig, updateConfig, getProxy, updateProxy, create, delete, start, stop, logout, forceKill, getQrCode, requestPairingCode, setOnlinePresence, stats                                                                                                                                       |
| `messages`  | list, sendText, sendImage/Video/Audio/Document/Sticker, sendLocation, sendContact, sendTemplate, sendPoll, reply, forward, clickButton, react, delete, editMessage, history, reactions, media, pin, unpin, star, votePoll, sendBulk, batchStatus, cancelBatch                                            |
| `contacts`  | list, get, check, profilePicture, profilePictures, phone, upsert, delete, block, unblock, listBlocked                                                                                                                                                                                                    |
| `groups`    | list, get, create, joinInfo, joinGroup, add/remove/promote/demoteParticipants, setSubject, setDescription, getGroupSettings, updateGroupSettings, leave, getPicture, setPicture, deletePicture, inviteCode, revokeInviteCode, getMembershipRequests, approveMembershipRequests, rejectMembershipRequests |
| `webhooks`  | list, listAll, deliveryFailures, get, create, update, delete, test                                                                                                                                                                                                                                       |
| `chats`     | list, subscribePresence, getPresence, markRead, markUnread, archive, pin, mute, clearMessages, delete, sendState                                                                                                                                                                                         |
| `labels`    | list, get, chats, upsert, delete, forChat, addToChat, removeFromChat _(WhatsApp Business)_                                                                                                                                                                                                               |
| `channels`  | list, get, messages, create, delete, mute, subscribe, unsubscribe, demoteAdmin, transferOwnership _(Newsletters)_                                                                                                                                                                                        |
| `catalog`   | info, products, product, sendProduct _(WhatsApp Business)_                                                                                                                                                                                                                                               |
| `status`    | list, fromContact, media, sendText, sendImage, sendVideo, sendVoice, delete _(Stories)_                                                                                                                                                                                                                  |
| `search`    | search                                                                                                                                                                                                                                                                                                   |
| `templates` | list, get, create, update, delete                                                                                                                                                                                                                                                                        |
| `profile`   | setProfileName, setProfileStatus, setProfilePicture, deleteProfilePicture                                                                                                                                                                                                                                |
| `calls`     | rejectCall, createLink                                                                                                                                                                                                                                                                                   |
| `media`     | conversionStatus, convertVoice, convertVideo _(users)_                                                                                                                                                                                                                                                |
| `health`    | check, live, ready                                                                                                                                                                                                                                                                                       |

> The SDKs cover the user-facing resources above and stop there. The administrative and operational surfaces are deliberately left out — `auth/api-keys`, `audit`, `settings`, `stats`, `automation`, `infra`, `plugins` and the `integration` management routes are predominantly `orgmenu`-gated; `metrics` is a `@Public()` Prometheus scrape gated by `METRICS_TOKEN` rather than by role; `mcp` is a Streamable-HTTP transport mounted straight onto the Express adapter; and `ingress` is the `@Public()` receiver that integration providers post into. `docker` has no HTTP surface at all — it is an internal service module. `plans` is excluded for a different reason than the rest: it is a dashboard-only authoring surface (`/flow`, a message-flow builder) whose block payload is still being shaped, so freezing it in five public SDK contracts now would be premature. Methods that require a `users`-level key are annotated **users** in the per-language tables below.

## 18.2 TypeScript / JavaScript SDK

The official JavaScript/TypeScript SDK is published as **`@mywhatsapp/sdk`**. It is a pure promise-based HTTP client: a single `MyWhatsappClient` exposes every API resource as a typed property. There is no event model — the SDK does not open WebSockets, emit events, or expose `client.on(...)`. To receive inbound messages and acks, configure a webhook (see the `webhooks` resource) and host your own HTTP receiver.

The package ships **dual CJS + ESM** with bundled `.d.ts` types, so it is consumable from both `require()` and `import`.

### Installation

```bash
npm install @mywhatsapp/sdk
# or
yarn add @mywhatsapp/sdk
# or
pnpm add @mywhatsapp/sdk
```

> **Node 18+ required.** The transport uses the global `fetch` (and `AbortController`), both built into Node 18 and later. To run on an older runtime, pass your own `fetch` implementation via the client constructor (see [Client Configuration](#client-configuration)).

### Quick Start

```typescript
import { MyWhatsappClient } from '@mywhatsapp/sdk';

const client = new MyWhatsappClient({
  baseUrl: 'http://localhost:2785',
  apiKey: 'owa_k1_…',
});

async function main() {
  // Start a session and bring the WhatsApp connection up.
  await client.sessions.start('my-session');

  // Send a text message.
  const result = await client.messages.sendText('my-session', {
    chatId: '628123456789@c.us',
    text: 'Hello from the MyWhatsapp SDK!',
  });

  console.log(result.messageId); // -> the WhatsApp message id
}

main();
```

`sendText` resolves to a `MessageResponse` (`{ messageId: string; timestamp: number }`). `timestamp` is the Unix epoch value returned by the API — **seconds**, passed through unchanged.

CommonJS consumers use the same API via `require`:

```javascript
const { MyWhatsappClient } = require('@mywhatsapp/sdk');
```

### Client Configuration

The constructor takes a single `MyWhatsappClientOptions` object. `baseUrl` and `apiKey` are required (the constructor throws synchronously if either is missing).

| Option           | Type                     | Required | Default            | Description                                                                                                                                                                    |
| ---------------- | ------------------------ | -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `baseUrl`        | `string`                 | yes      | —                  | Base URL of the MyWhatsapp API, e.g. `http://localhost:2785`. A trailing slash is trimmed; a path prefix (e.g. `https://host/v1`) is preserved.                                |
| `apiKey`         | `string`                 | yes      | —                  | API key sent as the `X-API-Key` header on every request.                                                                                                                       |
| `timeoutMs`      | `number`                 | no       | `30000`            | Per-request timeout in milliseconds. Overridable per call via `RequestOptions.timeoutMs` on the raw `request()` method.                                                        |
| `defaultHeaders` | `Record<string, string>` | no       | `{}`               | Headers merged onto every request. The `Content-Type: application/json` and `X-API-Key` headers always take precedence.                                                        |
| `fetch`          | `FetchLike`              | no       | `globalThis.fetch` | Injectable transport (the WHATWG `fetch` signature). Use this to wrap requests with retry/observability middleware, or to supply a `fetch` on runtimes that lack a global one. |

### Resources & Methods

All resources are accessed as properties on the client (`client.<resource>.<method>`). Every method returns a `Promise`. Methods marked **users** require a `users`-level API key (an `orgmenu` key satisfies it); a key below that tier receives a `403` (`MyWhatsappForbiddenError`).

The top-level client also exposes:

| Method    | Signature                    | Description                                                                |
| --------- | ---------------------------- | -------------------------------------------------------------------------- |
| `auth`    | `client.auth()`              | Validate the configured API key and resolve its role (`{ valid, role? }`). |
| `request` | `client.request<T>(options)` | Raw escape hatch — issue an arbitrary request against the API.             |

#### `sessions`

| Method               | Signature                      | Description                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`               | `list(query?)`                 | List all sessions (scoped to the key's `allowedSessions`). The optional query takes `limit`, `offset` and `name` (an exact, case-sensitive match; no match returns an empty list).                                                                                                                                                                              |
| `getConfig`          | `getConfig(id)`                | Read a session's engine configuration.                                                                                                                                                                                                                                                                                                                          |
| `updateConfig`       | `updateConfig(id, body)`       | Update a running session's configuration; takes effect without re-linking the account. **users**                                                                                                                                                                                                                                                             |
| `getProxy`           | `getProxy(id)`                 | Read a session's masked proxy configuration (credentials never returned).                                                                                                                                                                                                                                                                                       |
| `updateProxy`        | `updateProxy(id, body)`        | Update per-session proxy settings; changes apply on the next start, not to a running engine. Send `proxyUrl: null` to clear. **users**                                                                                                                                                                                                                       |
| `get`                | `get(id)`                      | Get a single session by id.                                                                                                                                                                                                                                                                                                                                     |
| `create`             | `create(body)`                 | Create a new session (`body.name` required). **users**                                                                                                                                                                                                                                                                                                       |
| `delete`             | `delete(id)`                   | Delete a session. **users**                                                                                                                                                                                                                                                                                                                                  |
| `start`              | `start(id)`                    | Start a session and initialize the WhatsApp connection. **users**                                                                                                                                                                                                                                                                                            |
| `stop`               | `stop(id)`                     | Stop a session and disconnect gracefully. **users**                                                                                                                                                                                                                                                                                                          |
| `logout`             | `logout(id)`                   | Attempt an engine-native unlink of this device, then stop the session. A `200` means the unlink + local cleanup completed (not an independent Linked-Devices observation); a later `start` needs a fresh QR. A `502` (`SESSION_LOGOUT_INCOMPLETE`) stops locally but leaves the operation incomplete; start and retry. Requires a running session. **users** |
| `forceKill`          | `forceKill(id)`                | Force-kill a stuck session (SIGKILL + teardown). **users**                                                                                                                                                                                                                                                                                                   |
| `getQrCode`          | `getQrCode(id)`                | Get the current QR code for authentication (live from the engine). **users**                                                                                                                                                                                                                                                                                 |
| `requestPairingCode` | `requestPairingCode(id, body)` | Request an 8-character pairing code for phone-based login. **users**                                                                                                                                                                                                                                                                                         |
| `setOnlinePresence`  | `setOnlinePresence(id, body)`  | Set the account's own global presence (appear online or offline). **users**                                                                                                                                                                                                                                                                                  |
| `stats`              | `stats()`                      | Aggregate statistics across the key's sessions.                                                                                                                                                                                                                                                                                                                 |

#### `messages`

| Method         | Signature                                 | Description                                                                                                                                       |
| -------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`         | `list(sessionId, query?)`                 | List messages (filter by chat/sender); returns `{ messages, total }`.                                                                             |
| `sendText`     | `sendText(sessionId, { chatId, text })`   | Send a text message (`text` max 4096 chars). **users**                                                                                         |
| `sendImage`    | `sendImage(sessionId, body)`              | Send an image (`url` or `base64`). **users**                                                                                                   |
| `sendVideo`    | `sendVideo(sessionId, body)`              | Send a video (`url` or `base64`). **users**                                                                                                    |
| `sendAudio`    | `sendAudio(sessionId, body)`              | Send an audio file (`url` or `base64`). **users**                                                                                              |
| `sendDocument` | `sendDocument(sessionId, body)`           | Send a document (`url` or `base64`; `filename` recommended). **users**                                                                         |
| `sendSticker`  | `sendSticker(sessionId, body)`            | Send a sticker (`url` or `base64`). **users**                                                                                                  |
| `sendLocation` | `sendLocation(sessionId, body)`           | Send a location (`{ chatId, latitude, longitude, description? }`). **users**                                                                   |
| `sendContact`  | `sendContact(sessionId, body)`            | Send a contact card. **users**                                                                                                                 |
| `sendTemplate` | `sendTemplate(sessionId, body)`           | Render and send a stored message template. **users**                                                                                           |
| `sendPoll`     | `sendPoll(sessionId, body)`               | Send a poll message. **users**                                                                                                                 |
| `reply`        | `reply(sessionId, body)`                  | Reply to a specific message. **users**                                                                                                         |
| `forward`      | `forward(sessionId, body)`                | Forward a message to another chat. **users**                                                                                                   |
| `clickButton`  | `clickButton(sessionId, body)`            | Tap a button or list row on a stored WhatsApp Business prompt (Baileys only). **users**                                                        |
| `react`        | `react(sessionId, body)`                  | React to a message (empty `reaction` removes it). **users**                                                                                    |
| `delete`       | `delete(sessionId, body)`                 | Delete a message. **users**                                                                                                                    |
| `editMessage`  | `editMessage(sessionId, body)`            | Edit the text of a message already sent. **users**                                                                                             |
| `history`      | `history(sessionId, chatId, query?)`      | Get message history for a chat (read live from WhatsApp).                                                                                         |
| `reactions`    | `reactions(sessionId, chatId, messageId)` | Get reactions for a specific message.                                                                                                             |
| `pin`          | `pin(sessionId, body)`                    | Pin a message in its chat. `durationSeconds` must be 86400, 604800 or 2592000; in a group only admins may pin. **users**                       |
| `votePoll`     | `votePoll(sessionId, body)`               | Cast a vote on a poll; `options` are the option texts, not ids. Not supported on Baileys (`501`). **users**                                    |
| `star`         | `star(sessionId, body)`                   | Star or unstar a message. Best-effort on whatsapp-web.js, which silently ignores a message it will not star. **users**                         |
| `unpin`        | `unpin(sessionId, body)`                  | Unpin a pinned message. **users**                                                                                                              |
| `media`        | `media(sessionId, chatId, messageId)`     | Fetch a message's stored media bytes: the archived file when one exists, else the inline copy on the message row. `404` when neither holds bytes. |
| `sendBulk`     | `sendBulk(sessionId, body)`               | Send a batch asynchronously (202 + batch id); poll via `batchStatus`. **users**                                                                |
| `batchStatus`  | `batchStatus(sessionId, batchId)`         | Poll the status/progress of a bulk-send batch.                                                                                                    |
| `cancelBatch`  | `cancelBatch(sessionId, batchId)`         | Cancel a running batch. **users**                                                                                                              |

Media bodies share the `SendMediaRequest` shape: `{ chatId, url? | base64?, mimetype?, filename?, caption? }` (`url` and `base64` are mutually exclusive; `base64` requires `mimetype`).

#### `contacts`

| Method            | Signature                              | Description                                                                          |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `list`            | `list(sessionId, query?)`              | List contacts known to the session.                                                  |
| `get`             | `get(sessionId, contactId)`            | Get details for a single contact by JID.                                             |
| `check`           | `check(sessionId, number)`             | Check whether a phone number is registered on WhatsApp.                              |
| `profilePicture`  | `profilePicture(sessionId, contactId)` | Get the contact's profile picture URL (or null).                                     |
| `profilePictures` | `profilePictures(sessionId, ids)`      | Batch-resolve profile picture URLs for up to 50 contacts in one request.             |
| `phone`           | `phone(sessionId, contactId)`          | Resolve a contact id (e.g. a `@lid`) to a phone number.                              |
| `block`           | `block(sessionId, contactId)`          | Block a contact. **users**                                                        |
| `upsert`          | `upsert(sessionId, contactId, body)`   | Save a contact to the account's addressbook, or edit an existing entry. **users** |
| `delete`          | `delete(sessionId, contactId)`         | Remove a contact from the account's addressbook. **users**                        |
| `unblock`         | `unblock(sessionId, contactId)`        | Unblock a contact. **users**                                                      |
| `listBlocked`     | `listBlocked(sessionId)`               | List the ids this account has blocked. Session-wide, so it takes no contact id.      |

#### `groups`

| Method                      | Signature                                                      | Description                                                                                                                |
| --------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `list`                      | `list(sessionId, query?)`                                      | List all groups for the session.                                                                                           |
| `get`                       | `get(sessionId, groupId)`                                      | Get detailed group info including participants.                                                                            |
| `create`                    | `create(sessionId, body)`                                      | Create a new group. **users**                                                                                           |
| `joinInfo`                  | `joinInfo(sessionId, code)`                                    | Preview a group from its invite code WITHOUT joining. Read-only, so it is safe to call on a code from an untrusted source. |
| `joinGroup`                 | `joinGroup(sessionId, body)`                                   | Join a group via its invite code. **users**                                                                             |
| `addParticipants`           | `addParticipants(sessionId, groupId, participants)`            | Add participants (`string[]`) to a group. **users**                                                                     |
| `removeParticipants`        | `removeParticipants(sessionId, groupId, participants)`         | Remove participants from a group. **users**                                                                             |
| `promoteParticipants`       | `promoteParticipants(sessionId, groupId, participants)`        | Promote participants to group admin. **users**                                                                          |
| `demoteParticipants`        | `demoteParticipants(sessionId, groupId, participants)`         | Demote participants from group admin. **users**                                                                         |
| `setSubject`                | `setSubject(sessionId, groupId, subject)`                      | Update the group subject (name). **users**                                                                              |
| `setDescription`            | `setDescription(sessionId, groupId, description)`              | Update the group description (empty clears it). **users**                                                               |
| `getGroupSettings`          | `getGroupSettings(sessionId, groupId)`                         | Get the group settings (announce / locked / ephemeral timer).                                                              |
| `updateGroupSettings`       | `updateGroupSettings(sessionId, groupId, body)`                | Update the group settings (at least one field required). **users**                                                      |
| `leave`                     | `leave(sessionId, groupId)`                                    | Leave a group. **users**                                                                                                |
| `getPicture`                | `getPicture(sessionId, groupId)`                               | The group's picture URL, or `null` when it has none.                                                                       |
| `setPicture`                | `setPicture(sessionId, groupId, body)`                         | Set the group's picture. **users**                                                                                      |
| `deletePicture`             | `deletePicture(sessionId, groupId)`                            | Remove the group's picture. **users**                                                                                   |
| `inviteCode`                | `inviteCode(sessionId, groupId)`                               | Get the group invite code and link. **users**                                                                           |
| `revokeInviteCode`          | `revokeInviteCode(sessionId, groupId)`                         | Revoke the current invite code and generate a new one. **users**                                                        |
| `getMembershipRequests`     | `getMembershipRequests(sessionId, groupId)`                    | List a group's pending join requests. Requires group admin.                                                                |
| `approveMembershipRequests` | `approveMembershipRequests(sessionId, groupId, participants?)` | Approve pending join requests; omit the list to approve all. **users**                                                  |
| `rejectMembershipRequests`  | `rejectMembershipRequests(sessionId, groupId, participants?)`  | Reject pending join requests; omit the list to reject all. **users**                                                    |

#### `chats`

| Method              | Signature                            | Description                                                                                                                                                                |
| ------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`              | `list(sessionId, query?)`            | List active chats, most recent first.                                                                                                                                      |
| `subscribePresence` | `subscribePresence(sessionId, body)` | Subscribe to a chat's presence; updates then arrive as `presence.update` events. The subscription belongs to the connection and does not survive a reconnect. **users** |
| `getPresence`       | `getPresence(sessionId, chatId)`     | The last presence reported for a chat, or `null` when none has been. Held in memory, so a restart clears it.                                                               |
| `markRead`          | `markRead(sessionId, body)`          | Mark a chat as read/seen. **users**                                                                                                                                     |
| `markUnread`        | `markUnread(sessionId, body)`        | Mark a chat as unread. **users**                                                                                                                                        |
| `archive`           | `archive(sessionId, body)`           | Archive or unarchive a chat. `success: false` means the engine declined. **users**                                                                                      |
| `pin`               | `pin(sessionId, body)`               | Pin a chat to the top of the list, or unpin it. `success: false` means WhatsApp declined — three pins maximum. **users**                                                |
| `mute`              | `mute(sessionId, body)`              | Mute a chat until an absolute epoch-MILLISECONDS timestamp, or unmute with `null`. **users**                                                                            |
| `clearMessages`     | `clearMessages(sessionId, chatId)`   | Delete every message in a chat, keeping the chat itself. **users**                                                                                                      |
| `delete`            | `delete(sessionId, body)`            | Delete a chat from the chat list. **users**                                                                                                                             |
| `sendState`         | `sendState(sessionId, body)`         | Send a chat presence state (typing/recording/paused). **users**                                                                                                         |

#### `webhooks`

| Method             | Signature                     | Description                                                                                                                                                            |
| ------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listAll`          | `listAll(query?)`             | List webhooks across EVERY session the key can see, not one session's. **users**                                                                                    |
| `deliveryFailures` | `deliveryFailures(query?)`    | Deliveries that were attempted and failed — the diagnostic for a webhook that stopped arriving. A delivery a smart filter suppressed never reaches this log. **orgmenu** |
| `list`             | `list(sessionId)`             | List all webhooks for a session. **users**                                                                                                                          |
| `get`              | `get(sessionId, id)`          | Get a single webhook by id. **users**                                                                                                                               |
| `create`           | `create(sessionId, body)`     | Create a new webhook. **users**                                                                                                                                     |
| `update`           | `update(sessionId, id, body)` | Update a webhook. **users**                                                                                                                                         |
| `delete`           | `delete(sessionId, id)`       | Delete a webhook. **users**                                                                                                                                         |
| `test`             | `test(sessionId, id)`         | Trigger a test dispatch to the webhook URL and report the result. **users**                                                                                         |

#### `labels` _(WhatsApp Business)_

| Method           | Signature                                    | Description                                                                              |
| ---------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `list`           | `list(sessionId)`                            | List all labels available in the business account.                                       |
| `get`            | `get(sessionId, labelId)`                    | Get a single label by id.                                                                |
| `chats`          | `chats(sessionId, labelId)`                  | Every chat carrying a label. **whatsapp-web.js only** — Baileys answers `501`.           |
| `upsert`         | `upsert(sessionId, labelId, body)`           | Create or update a label. **Baileys only** — whatsapp-web.js answers `501`. **users** |
| `delete`         | `delete(sessionId, labelId)`                 | Delete a label. **users**                                                             |
| `forChat`        | `forChat(sessionId, chatId)`                 | Get the labels currently applied to a chat.                                              |
| `addToChat`      | `addToChat(sessionId, chatId, body)`         | Add a label to a chat. **users**                                                      |
| `removeFromChat` | `removeFromChat(sessionId, chatId, labelId)` | Remove a label from a chat. **users**                                                 |

#### `channels` _(Newsletters)_

| Method              | Signature                                       | Description                                                                                                                 |
| ------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `list`              | `list(sessionId)`                               | List all channels/newsletters the session is subscribed to.                                                                 |
| `get`               | `get(sessionId, channelId)`                     | Get a single channel by id.                                                                                                 |
| `messages`          | `messages(sessionId, channelId, query?)`        | Get recent messages from a channel.                                                                                         |
| `create`            | `create(sessionId, body)`                       | Create a channel this account owns. **users**                                                                            |
| `delete`            | `delete(sessionId, channelId)`                  | Delete a channel this account owns. Irreversible, and every subscriber loses it — distinct from `unsubscribe`. **users** |
| `mute`              | `mute(sessionId, channelId, body)`              | Mute or unmute a channel's notifications. **users**                                                                      |
| `subscribe`         | `subscribe(sessionId, body)`                    | Subscribe to a channel using its invite code. **users**                                                                  |
| `unsubscribe`       | `unsubscribe(sessionId, channelId)`             | Unsubscribe from a channel. **users**                                                                                    |
| `demoteAdmin`       | `demoteAdmin(sessionId, channelId, body)`       | Demote a channel admin back to a subscriber; no promote counterpart exists. **users**                                    |
| `transferOwnership` | `transferOwnership(sessionId, channelId, body)` | Hand a channel to a new owner. Irreversible. **users**                                                                   |

#### `catalog` _(WhatsApp Business)_

| Method        | Signature                       | Description                                                |
| ------------- | ------------------------------- | ---------------------------------------------------------- |
| `info`        | `info(sessionId)`               | Get the business catalog info.                             |
| `products`    | `products(sessionId, query?)`   | List catalog products; returns `{ products, pagination }`. |
| `product`     | `product(sessionId, productId)` | Get a single product by id.                                |
| `sendProduct` | `sendProduct(sessionId, body)`  | Send a product message. **users**                       |

#### `status` _(Stories)_

| Method        | Signature                           | Description                                                                                                                                                       |
| ------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`        | `list(sessionId)`                   | Get all status updates (`{ statuses }`).                                                                                                                          |
| `fromContact` | `fromContact(sessionId, contactId)` | Get status updates from a specific contact.                                                                                                                       |
| `media`       | `media(sessionId, statusId)`        | Fetch the stored media bytes for a status update (404 when there is none).                                                                                        |
| `sendText`    | `sendText(sessionId, body)`         | Post a text status update. **users**                                                                                                                           |
| `sendImage`   | `sendImage(sessionId, body)`        | Post an image status update. **users**                                                                                                                         |
| `sendVideo`   | `sendVideo(sessionId, body)`        | Post a video status update. **users**                                                                                                                          |
| `sendVoice`   | `sendVoice(sessionId, body)`        | Post an audio status as a voice note. WhatsApp plays one only as Ogg/Opus and neither engine transcodes, so convert with `media.convertVoice` first. **users** |
| `delete`      | `delete(sessionId, statusId)`       | Delete a status update by id. **users**                                                                                                                        |

> This is WhatsApp "Status/Stories", distinct from session lifecycle status.

#### `search`

| Method   | Signature        | Description                                                                                                                                      |
| -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search` | `search(params)` | Search persisted messages across sessions via the active search provider; a scoped key's reach is bounded by its `allowedSessions`. **users** |

#### `templates`

| Method   | Signature                     | Description                                    |
| -------- | ----------------------------- | ---------------------------------------------- |
| `list`   | `list(sessionId)`             | List all templates for a session. **users** |
| `get`    | `get(sessionId, id)`          | Get a single template by id. **users**      |
| `create` | `create(sessionId, body)`     | Create a new template. **users**            |
| `update` | `update(sessionId, id, body)` | Update a template. **users**                |
| `delete` | `delete(sessionId, id)`       | Delete a template. **users**                |

#### `profile`

| Method                 | Signature                             | Description                                                                    |
| ---------------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| `setProfileName`       | `setProfileName(sessionId, name)`     | Set the account display name. **users**                                     |
| `setProfileStatus`     | `setProfileStatus(sessionId, status)` | Set the account about/status text (empty clears it). **users**              |
| `setProfilePicture`    | `setProfilePicture(sessionId, body)`  | Set the account profile picture (`url` or `base64` + `mimetype`). **users** |
| `deleteProfilePicture` | `deleteProfilePicture(sessionId)`     | Remove the account profile picture. **users**                               |

#### `calls`

| Method       | Signature                       | Description                                                                                                                                   |
| ------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `rejectCall` | `rejectCall(sessionId, callId)` | Reject a ringing incoming call (`callId` comes from the `call.received` event). **Baileys only**: whatsapp-web.js answers `501`. **users** |
| `createLink` | `createLink(sessionId, body)`   | Create a shareable WhatsApp call link (`startTime` is epoch MILLISECONDS). **users**                                                       |

#### `media`

| Method             | Signature                        | Description                                                                                  |
| ------------------ | -------------------------------- | -------------------------------------------------------------------------------------------- |
| `conversionStatus` | `conversionStatus(sessionId)`    | Whether conversion is switched on for this deployment AND the ffmpeg binary can be run.      |
| `convertVoice`     | `convertVoice(sessionId, input)` | Convert audio into a WhatsApp voice note (Ogg/Opus, mono, tuned for speech). **users**    |
| `convertVideo`     | `convertVideo(sessionId, input)` | Convert video into an MP4 every WhatsApp client accepts (baseline H.264 + AAC). **users** |

#### `health`

| Method  | Signature | Description                                              |
| ------- | --------- | -------------------------------------------------------- |
| `check` | `check()` | General health (also returns the running version).       |
| `live`  | `live()`  | Kubernetes liveness probe (`{ status }`).                |
| `ready` | `ready()` | Kubernetes readiness probe — checks both DB connections. |

### Error Handling

On a non-2xx response the SDK throws a typed `MyWhatsappApiError` subclass carrying `.status` (HTTP status), `.body` (parsed JSON error envelope, or raw text), and `.errorKind` (the NestJS `error` field, `undefined` when the gateway omits it — which is the norm for a validation rejection in production, where `disableErrorMessages` is on). All error classes extend `MyWhatsappError` and are exported, so they are `instanceof`-checkable. A timeout throws `MyWhatsappTimeoutError`, which extends `MyWhatsappError` directly (not `MyWhatsappApiError`).

| Error class                         | HTTP status | Meaning                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MyWhatsappAuthError`               | 401         | Missing or invalid API key.                                                                                                                                                                                                                                                                             |
| `MyWhatsappForbiddenError`          | 403         | The key's role is insufficient (e.g. a users-only route).                                                                                                                                                                                                                                           |
| `MyWhatsappNotFoundError`           | 404         | Resource not found.                                                                                                                                                                                                                                                                                     |
| `MyWhatsappConflictError`           | 409         | Conflict — typically the engine is not ready.                                                                                                                                                                                                                                                           |
| `MyWhatsappRateLimitError`          | 429         | Rate limited.                                                                                                                                                                                                                                                                                           |
| `MyWhatsappNotImplementedError`     | 501         | The active engine does not support this operation.                                                                                                                                                                                                                                                      |
| `MyWhatsappServiceUnavailableError` | 503         | The engine did not confirm in time. The only retryable error here — 501 is permanent. In a routed deployment a forwarded request answers 503 only when the owner node was never reached; a forward that fails after the request was sent answers 502 or 504, which the owner may already have acted on. |
| `MyWhatsappApiError`                | any other   | Generic non-2xx (the base API error, e.g. `400`; also surfaced for unfollowed 3xx redirects).                                                                                                                                                                                                           |
| `MyWhatsappTimeoutError`            | —           | The request exceeded the configured timeout.                                                                                                                                                                                                                                                            |

```typescript
import {
  MyWhatsappClient,
  MyWhatsappConflictError,
  MyWhatsappNotFoundError,
  MyWhatsappRateLimitError,
  MyWhatsappTimeoutError,
  MyWhatsappApiError,
} from '@mywhatsapp/sdk';

try {
  await client.messages.sendText('my-session', {
    chatId: '628123456789@c.us',
    text: 'Hi!',
  });
} catch (err) {
  if (err instanceof MyWhatsappConflictError) {
    // 409 — engine not ready; start the session first.
  } else if (err instanceof MyWhatsappNotFoundError) {
    // 404 — session/chat does not exist.
  } else if (err instanceof MyWhatsappRateLimitError) {
    // 429 — back off and retry.
  } else if (err instanceof MyWhatsappTimeoutError) {
    // request timed out.
  } else if (err instanceof MyWhatsappApiError) {
    console.error(`API error ${err.status}:`, err.body);
  } else {
    throw err; // network/transport error
  }
}
```

### Notable Behaviors

- **Redirects are never followed.** The transport uses `redirect: 'manual'`, so a `3xx` surfaces to the caller as an error (via `MyWhatsappApiError`) rather than being followed — this guarantees the `X-API-Key` header is never re-sent to a redirect target (potentially a different origin).
- **Auth and JSON headers take precedence.** Request headers are merged in the order `defaultHeaders` → per-call headers → `Content-Type: application/json` → `X-API-Key`. Both `Content-Type` and `X-API-Key` are applied last, so neither can be overridden by a caller-supplied header.
- **Path segments are percent-encoded.** Ids (session, chat, message, etc.) are encoded so a value cannot break out of its path position, while keeping the WhatsApp-safe characters `@`, `:`, and `+` readable (e.g. `628123456789@c.us`).
- **Base-URL path prefix is preserved.** A `baseUrl` such as `https://gateway.example.com/v1` keeps its `/v1` prefix on every request; only a trailing slash is trimmed.
- **No automatic retries.** A failed request rejects immediately — the SDK does not retry, even on `429`. Wrap calls in your own backoff if you need retries.
- **Injectable transport.** Supply a custom `fetch` to wrap outbound calls with retry, logging, or observability middleware, or to run on a runtime without a global `fetch`. This is also the recommended way to unit-test without monkey-patching globals.
- **Dual CJS + ESM.** The package exposes both an `import` (ESM) and `require` (CommonJS) entry point with bundled type declarations, so it works in either module system without configuration.

## 18.3 Python SDK

The Python SDK is a **synchronous** client built on [`httpx`](https://www.python-httpx.org/). It ships its own type hints (PEP 561) so editors and type-checkers see the full surface without stubs. There is **no async client and no event/streaming model** — every call is a blocking method that returns a plain `dict`/`list` (or `None` for a 204), and request payloads are plain `dict`s.

### Installation

The PyPI distribution name and the import package differ:

```bash
pip install mywhatsapp-sdk
```

```python
from mywhatsapp import MyWhatsappClient
```

- **Distribution (PyPI):** `mywhatsapp-sdk`
- **Import package:** `mywhatsapp`
- **Client class:** `MyWhatsappClient`
- **Python:** `>=3.9` (per `pyproject.toml`)
- **Runtime dependency:** `httpx>=0.25.0,<1.0`
- **Typed:** ships `py.typed` markers for `mywhatsapp` and `mywhatsapp.resources` (PEP 561)

### Quick Start

```python
from mywhatsapp import MyWhatsappClient

client = MyWhatsappClient(
    base_url="http://localhost:2785",
    api_key="owa_k1_…",
)

# Create then start a session
client.sessions.create({"name": "my-session"})
client.sessions.start("my-session")

# Send a text message
result = client.messages.send_text("my-session", {
    "chatId": "628123456789@c.us",
    "text": "Hello from the MyWhatsapp Python SDK!",
})
print(result["messageId"])

client.close()
```

`MyWhatsappClient` is also a context manager, so the connection pool is closed for you:

```python
with MyWhatsappClient(base_url="http://localhost:2785", api_key="owa_k1_…") as client:
    print(client.health.check())
```

### Client Configuration

Constructor signature (from `client.py`):

```python
MyWhatsappClient(
    base_url: str,
    api_key: str,
    *,
    timeout: float = 30.0,
    default_headers: Mapping[str, str] | None = None,
    transport: httpx.BaseTransport | None = None,
)
```

| Parameter         | Type                          | Default      | Description                                                                                                                             |
| ----------------- | ----------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `base_url`        | `str`                         | _(required)_ | Gateway base URL, e.g. `http://localhost:2785`. Raises `ValueError` if empty. A trailing `/` is stripped; any path prefix is preserved. |
| `api_key`         | `str`                         | _(required)_ | API key sent as the `X-API-Key` header. Raises `ValueError` if empty.                                                                   |
| `timeout`         | `float`                       | `30.0`       | Per-request timeout in seconds. A breach raises `MyWhatsappTimeoutError`.                                                               |
| `default_headers` | `Mapping[str, str] \| None`   | `None`       | Extra headers applied to every request. Applied **first**, so the SDK's `X-API-Key` and `Content-Type: application/json` always win.    |
| `transport`       | `httpx.BaseTransport \| None` | `None`       | Optional `httpx` transport override (e.g. `httpx.MockTransport`) sharing the one connection pool. Useful for testing.                   |

The client also exposes a few non-resource members:

| Member    | Signature                                                | Description                                                  |
| --------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| `auth`    | `auth() -> AuthValidateResponse`                         | `POST /api/auth/validate` — validate the configured API key. |
| `request` | `request(method, path, *, query=None, body=None) -> Any` | Raw escape hatch; `path` begins with `/`.                    |
| `close`   | `close() -> None`                                        | Close the underlying `httpx.Client`.                         |

### Resources & Methods

Resources are accessed as properties on the client (e.g. `client.messages`). All methods are **snake_case**; `body`/`query` arguments are plain dicts. Methods marked **users** require a `users`-level API key.

#### `client.sessions`

| Method                 | Signature                                                       | Description                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`                 | `list(query=None) -> list[SessionResponse]`                     | List all sessions. The optional query takes `limit`, `offset` and `name` (an exact, case-sensitive match; no match returns an empty list).                                                                                                                                                                                                                      |
| `get_config`           | `get_config(session_id) -> SessionConfig`                       | Read a session's engine configuration.                                                                                                                                                                                                                                                                                                                          |
| `update_config`        | `update_config(session_id, body) -> SessionConfig`              | Update a running session's configuration; takes effect without re-linking the account. **users**                                                                                                                                                                                                                                                             |
| `get_proxy`            | `get_proxy(session_id) -> SessionProxy`                         | Read a session's masked proxy configuration (credentials never returned).                                                                                                                                                                                                                                                                                       |
| `update_proxy`         | `update_proxy(session_id, body) -> SessionProxy`                | Update per-session proxy settings; changes apply on the next start. Send `proxyUrl: null` to clear. **users**                                                                                                                                                                                                                                                |
| `get`                  | `get(session_id) -> SessionResponse`                            | Get one session.                                                                                                                                                                                                                                                                                                                                                |
| `create`               | `create(body) -> SessionResponse`                               | Create a session (`body["name"]` required). **users**                                                                                                                                                                                                                                                                                                        |
| `delete`               | `delete(session_id) -> None`                                    | Delete a session. **users**                                                                                                                                                                                                                                                                                                                                  |
| `start`                | `start(session_id) -> SessionResponse`                          | Start (connect) a session. **users**                                                                                                                                                                                                                                                                                                                         |
| `stop`                 | `stop(session_id) -> SessionResponse`                           | Stop a session. **users**                                                                                                                                                                                                                                                                                                                                    |
| `logout`               | `logout(session_id) -> SessionResponse`                         | Attempt an engine-native unlink of this device, then stop the session. A `200` means the unlink + local cleanup completed (not an independent Linked-Devices observation); a later `start` needs a fresh QR. A `502` (`SESSION_LOGOUT_INCOMPLETE`) stops locally but leaves the operation incomplete; start and retry. Requires a running session. **users** |
| `force_kill`           | `force_kill(session_id) -> SessionResponse`                     | Force-terminate a session. **users**                                                                                                                                                                                                                                                                                                                         |
| `get_qr_code`          | `get_qr_code(session_id) -> QrCodeResponse`                     | Fetch the login QR code. **users**                                                                                                                                                                                                                                                                                                                           |
| `request_pairing_code` | `request_pairing_code(session_id, body) -> PairingCodeResponse` | Request a phone-number pairing code. **users**                                                                                                                                                                                                                                                                                                               |
| `set_online_presence`  | `set_online_presence(session_id, body) -> SuccessResult`        | Set the account's own global presence (appear online or offline). **users**                                                                                                                                                                                                                                                                                  |
| `stats`                | `stats() -> SessionStatsOverview`                               | Session statistics overview.                                                                                                                                                                                                                                                                                                                                    |

#### `client.messages`

| Method          | Signature                                                              | Description                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`          | `list(session_id, query=None) -> MessageListResponse`                  | List stored messages.                                                                                                                             |
| `send_text`     | `send_text(session_id, body) -> MessageResponse`                       | Send a text message. **users**                                                                                                                 |
| `send_image`    | `send_image(session_id, body) -> MessageResponse`                      | Send an image. **users**                                                                                                                       |
| `send_video`    | `send_video(session_id, body) -> MessageResponse`                      | Send a video. **users**                                                                                                                        |
| `send_audio`    | `send_audio(session_id, body) -> MessageResponse`                      | Send audio. **users**                                                                                                                          |
| `send_document` | `send_document(session_id, body) -> MessageResponse`                   | Send a document. **users**                                                                                                                     |
| `send_sticker`  | `send_sticker(session_id, body) -> MessageResponse`                    | Send a sticker. **users**                                                                                                                      |
| `send_location` | `send_location(session_id, body) -> MessageResponse`                   | Send a location. **users**                                                                                                                     |
| `send_contact`  | `send_contact(session_id, body) -> MessageResponse`                    | Send a contact card. **users**                                                                                                                 |
| `send_template` | `send_template(session_id, body) -> MessageResponse`                   | Send a stored template. **users**                                                                                                              |
| `send_poll`     | `send_poll(session_id, body) -> MessageResponse`                       | Send a poll message. **users**                                                                                                                 |
| `reply`         | `reply(session_id, body) -> MessageResponse`                           | Reply to a message. **users**                                                                                                                  |
| `forward`       | `forward(session_id, body) -> MessageResponse`                         | Forward a message. **users**                                                                                                                   |
| `click_button`  | `click_button(session_id, body) -> MessageResponse`                    | Tap a button or list row on a stored WhatsApp Business prompt (Baileys only). **users**                                                        |
| `react`         | `react(session_id, body) -> SuccessResult`                             | React to a message. **users**                                                                                                                  |
| `delete`        | `delete(session_id, body) -> SuccessResult`                            | Delete a message. **users**                                                                                                                    |
| `edit_message`  | `edit_message(session_id, body) -> MessageResponse`                    | Edit the text of a message already sent. **users**                                                                                             |
| `history`       | `history(session_id, chat_id, query=None) -> list[ChatHistoryMessage]` | Fetch chat history.                                                                                                                               |
| `reactions`     | `reactions(session_id, chat_id, message_id) -> list[ReactionRecord]`   | List reactions on a message.                                                                                                                      |
| `pin`           | `pin(session_id, body) -> SuccessResult`                               | Pin a message in its chat. `durationSeconds` must be 86400, 604800 or 2592000; in a group only admins may pin. **users**                       |
| `vote_poll`     | `vote_poll(session_id, body) -> SuccessResult`                         | Cast a vote on a poll; `options` are the option texts, not ids. Not supported on Baileys (`501`). **users**                                    |
| `star`          | `star(session_id, body) -> SuccessResult`                              | Star or unstar a message. Best-effort on whatsapp-web.js, which silently ignores a message it will not star. **users**                         |
| `unpin`         | `unpin(session_id, body) -> SuccessResult`                             | Unpin a pinned message. **users**                                                                                                              |
| `media`         | `media(session_id, chat_id, message_id) -> MessageMedia`               | Fetch a message's stored media bytes: the archived file when one exists, else the inline copy on the message row. `404` when neither holds bytes. |
| `send_bulk`     | `send_bulk(session_id, body) -> BulkMessageResponse`                   | Enqueue a bulk send batch. **users**                                                                                                           |
| `batch_status`  | `batch_status(session_id, batch_id) -> BatchStatusResponse`            | Get bulk batch status.                                                                                                                            |
| `cancel_batch`  | `cancel_batch(session_id, batch_id) -> BatchStatusResponse`            | Cancel a running batch. **users**                                                                                                              |

#### `client.contacts`

| Method             | Signature                                                           | Description                                                                          |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `list`             | `list(session_id, query=None) -> list[ContactRecord]`               | List contacts (`query`: `limit`, `offset`).                                          |
| `get`              | `get(session_id, contact_id) -> ContactRecord`                      | Get one contact.                                                                     |
| `check`            | `check(session_id, number) -> CheckNumberResponse`                  | Check whether a number is on WhatsApp.                                               |
| `profile_picture`  | `profile_picture(session_id, contact_id) -> ProfilePictureResponse` | Get a contact's profile picture.                                                     |
| `profile_pictures` | `profile_pictures(session_id, ids) -> ProfilePicturesResponse`      | Batch-resolve profile picture URLs for up to 50 contacts.                            |
| `phone`            | `phone(session_id, contact_id) -> ContactPhoneResponse`             | Resolve a contact's phone number.                                                    |
| `block`            | `block(session_id, contact_id) -> SuccessResult`                    | Block a contact. **users**                                                        |
| `upsert`           | `upsert(session_id, contact_id, body) -> SuccessResult`             | Save a contact to the account's addressbook, or edit an existing entry. **users** |
| `delete`           | `delete(session_id, contact_id) -> SuccessResult`                   | Remove a contact from the account's addressbook. **users**                        |
| `unblock`          | `unblock(session_id, contact_id) -> SuccessResult`                  | Unblock a contact. **users**                                                      |
| `list_blocked`     | `list_blocked(session_id) -> list[str]`                             | List the ids this account has blocked. Session-wide, so it takes no contact id.      |

#### `client.groups`

| Method                        | Signature                                                                                    | Description                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `list`                        | `list(session_id, query=None) -> list[GroupSummary]`                                         | List groups (`query`: `limit`, `offset`).                                                                                  |
| `get`                         | `get(session_id, group_id) -> GroupInfo`                                                     | Get group details.                                                                                                         |
| `create`                      | `create(session_id, body) -> GroupInfo`                                                      | Create a group. **users**                                                                                               |
| `join_info`                   | `join_info(session_id, code) -> GroupJoinInfo`                                               | Preview a group from its invite code WITHOUT joining. Read-only, so it is safe to call on a code from an untrusted source. |
| `join_group`                  | `join_group(session_id, body) -> JoinGroupResponse`                                          | Join a group via its invite code. **users**                                                                             |
| `add_participants`            | `add_participants(session_id, group_id, participants) -> SuccessResult`                      | Add participants (`list[str]`). **users**                                                                               |
| `remove_participants`         | `remove_participants(session_id, group_id, participants) -> SuccessResult`                   | Remove participants. **users**                                                                                          |
| `promote_participants`        | `promote_participants(session_id, group_id, participants) -> SuccessResult`                  | Promote to admin. **users**                                                                                             |
| `demote_participants`         | `demote_participants(session_id, group_id, participants) -> SuccessResult`                   | Demote from admin. **users**                                                                                            |
| `set_subject`                 | `set_subject(session_id, group_id, subject) -> SuccessResult`                                | Set group subject. **users**                                                                                            |
| `set_description`             | `set_description(session_id, group_id, description) -> SuccessResult`                        | Set group description. **users**                                                                                        |
| `get_group_settings`          | `get_group_settings(session_id, group_id) -> GroupSettings`                                  | Get the group settings (announce / locked / ephemeral timer).                                                              |
| `update_group_settings`       | `update_group_settings(session_id, group_id, body) -> SuccessResult`                         | Update the group settings (at least one field required). **users**                                                      |
| `leave`                       | `leave(session_id, group_id) -> SuccessResult`                                               | Leave the group. **users**                                                                                              |
| `get_picture`                 | `get_picture(session_id, group_id) -> dict[str, Any]`                                        | The group's picture URL, or `null` when it has none.                                                                       |
| `set_picture`                 | `set_picture(session_id, group_id, body) -> SuccessResult`                                   | Set the group's picture. **users**                                                                                      |
| `delete_picture`              | `delete_picture(session_id, group_id) -> SuccessResult`                                      | Remove the group's picture. **users**                                                                                   |
| `invite_code`                 | `invite_code(session_id, group_id) -> InviteCodeResponse`                                    | Get the invite code. **users**                                                                                          |
| `revoke_invite_code`          | `revoke_invite_code(session_id, group_id) -> InviteCodeResponse`                             | Revoke and regenerate the invite code. **users**                                                                        |
| `get_membership_requests`     | `get_membership_requests(session_id, group_id) -> list[GroupMembershipRequest]`              | List a group's pending join requests. Requires group admin.                                                                |
| `approve_membership_requests` | `approve_membership_requests(session_id, group_id, participants=None) -> ParticipantsResult` | Approve pending join requests; omit the list to approve all. **users**                                                  |
| `reject_membership_requests`  | `reject_membership_requests(session_id, group_id, participants=None) -> ParticipantsResult`  | Reject pending join requests; omit the list to reject all. **users**                                                    |

#### `client.chats`

| Method               | Signature                                               | Description                                                                                                                                                                |
| -------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`               | `list(session_id, query=None) -> list[ChatSummary]`     | List chats (`query`: `limit`, `offset`).                                                                                                                                   |
| `subscribe_presence` | `subscribe_presence(session_id, body) -> SuccessResult` | Subscribe to a chat's presence; updates then arrive as `presence.update` events. The subscription belongs to the connection and does not survive a reconnect. **users** |
| `get_presence`       | `get_presence(session_id, chat_id) -> ChatPresence      | None`                                                                                                                                                                      | The last presence reported for a chat, or `null` when none has been. Held in memory, so a restart clears it. |
| `mark_read`          | `mark_read(session_id, body) -> SuccessResult`          | Mark a chat as read. **users**                                                                                                                                          |
| `mark_unread`        | `mark_unread(session_id, body) -> SuccessResult`        | Mark a chat as unread. **users**                                                                                                                                        |
| `archive`            | `archive(session_id, body) -> SuccessResult`            | Archive or unarchive a chat. `success: false` means the engine declined. **users**                                                                                      |
| `pin`                | `pin(session_id, body) -> SuccessResult`                | Pin a chat to the top of the list, or unpin it. `success: false` means WhatsApp declined — three pins maximum. **users**                                                |
| `mute`               | `mute(session_id, body) -> SuccessResult`               | Mute a chat until an absolute epoch-MILLISECONDS timestamp, or unmute with `null`. **users**                                                                            |
| `clear_messages`     | `clear_messages(session_id, chat_id) -> SuccessResult`  | Delete every message in a chat, keeping the chat itself. **users**                                                                                                      |
| `delete`             | `delete(session_id, body) -> SuccessResult`             | Delete a chat. **users**                                                                                                                                                |
| `send_state`         | `send_state(session_id, body) -> SuccessResult`         | Send a typing/recording chat state. **users**                                                                                                                           |

#### `client.webhooks`

| Method              | Signature                                                       | Description                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_all`          | `list_all(query=None) -> list[WebhookResponse]`                 | List webhooks across EVERY session the key can see, not one session's. **users**                                                                                    |
| `delivery_failures` | `delivery_failures(query=None) -> list[WebhookDeliveryFailure]` | Deliveries that were attempted and failed — the diagnostic for a webhook that stopped arriving. A delivery a smart filter suppressed never reaches this log. **orgmenu** |
| `list`              | `list(session_id) -> list[WebhookResponse]`                     | List webhooks. **users**                                                                                                                                            |
| `get`               | `get(session_id, webhook_id) -> WebhookResponse`                | Get one webhook. **users**                                                                                                                                          |
| `create`            | `create(session_id, body) -> WebhookResponse`                   | Create a webhook. **users**                                                                                                                                         |
| `update`            | `update(session_id, webhook_id, body) -> WebhookResponse`       | Update a webhook. **users**                                                                                                                                         |
| `delete`            | `delete(session_id, webhook_id) -> None`                        | Delete a webhook. **users**                                                                                                                                         |
| `test`              | `test(session_id, webhook_id) -> WebhookTestResult`             | Send a test delivery. **users**                                                                                                                                     |

#### `client.labels` _(WhatsApp Business)_

| Method             | Signature                                                          | Description                                                                              |
| ------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `list`             | `list(session_id) -> list[LabelRecord]`                            | List labels.                                                                             |
| `get`              | `get(session_id, label_id) -> LabelRecord`                         | Get one label.                                                                           |
| `chats`            | `chats(session_id, label_id) -> list[ChatSummary]`                 | Every chat carrying a label. **whatsapp-web.js only** — Baileys answers `501`.           |
| `upsert`           | `upsert(session_id, label_id, body) -> SuccessResult`              | Create or update a label. **Baileys only** — whatsapp-web.js answers `501`. **users** |
| `delete`           | `delete(session_id, label_id) -> SuccessResult`                    | Delete a label. **users**                                                             |
| `for_chat`         | `for_chat(session_id, chat_id) -> list[LabelRecord]`               | Labels applied to a chat.                                                                |
| `add_to_chat`      | `add_to_chat(session_id, chat_id, body) -> SuccessResult`          | Add a label to a chat. **users**                                                      |
| `remove_from_chat` | `remove_from_chat(session_id, chat_id, label_id) -> SuccessResult` | Remove a label from a chat. **users**                                                 |

#### `client.channels` _(Newsletters)_

| Method               | Signature                                                                    | Description                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `list`               | `list(session_id) -> list[ChannelRecord]`                                    | List subscribed channels.                                                                                                   |
| `get`                | `get(session_id, channel_id) -> ChannelRecord`                               | Get one channel.                                                                                                            |
| `messages`           | `messages(session_id, channel_id, query=None) -> list[ChannelMessageRecord]` | List channel messages.                                                                                                      |
| `create`             | `create(session_id, body) -> ChannelRecord`                                  | Create a channel this account owns. **users**                                                                            |
| `delete`             | `delete(session_id, channel_id) -> SuccessResult`                            | Delete a channel this account owns. Irreversible, and every subscriber loses it — distinct from `unsubscribe`. **users** |
| `mute`               | `mute(session_id, channel_id, body) -> SuccessResult`                        | Mute or unmute a channel's notifications. **users**                                                                      |
| `subscribe`          | `subscribe(session_id, body) -> ChannelRecord`                               | Subscribe via invite code. **users**                                                                                     |
| `unsubscribe`        | `unsubscribe(session_id, channel_id) -> SuccessResult`                       | Unsubscribe from a channel. **users**                                                                                    |
| `demote_admin`       | `demote_admin(session_id, channel_id, body) -> SuccessResult`                | Demote a channel admin back to a subscriber; no promote counterpart exists. **users**                                    |
| `transfer_ownership` | `transfer_ownership(session_id, channel_id, body) -> SuccessResult`          | Hand a channel to a new owner. Irreversible. **users**                                                                   |

#### `client.catalog` _(WhatsApp Business)_

| Method         | Signature                                               | Description                          |
| -------------- | ------------------------------------------------------- | ------------------------------------ |
| `info`         | `info(session_id) -> CatalogInfo`                       | Get catalog info.                    |
| `products`     | `products(session_id, query=None) -> PaginatedProducts` | List products (paginated).           |
| `product`      | `product(session_id, product_id) -> CatalogProduct`     | Get one product.                     |
| `send_product` | `send_product(session_id, body) -> MessageResponse`     | Send a product message. **users** |

#### `client.status` _(Stories)_

| Method         | Signature                                                               | Description                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`         | `list(session_id) -> dict[str, list[StatusRecord]]`                     | List all status updates.                                                                                                                                          |
| `from_contact` | `from_contact(session_id, contact_id) -> dict[str, list[StatusRecord]]` | Status updates from one contact.                                                                                                                                  |
| `media`        | `media(session_id, status_id) -> StatusMedia`                           | Fetch the stored media bytes for a status update.                                                                                                                 |
| `send_text`    | `send_text(session_id, body) -> StatusResult`                           | Post a text status. **users**                                                                                                                                  |
| `send_image`   | `send_image(session_id, body) -> StatusResult`                          | Post an image status. **users**                                                                                                                                |
| `send_video`   | `send_video(session_id, body) -> StatusResult`                          | Post a video status. **users**                                                                                                                                 |
| `send_voice`   | `send_voice(session_id, body) -> StatusResult`                          | Post an audio status as a voice note. WhatsApp plays one only as Ogg/Opus and neither engine transcodes, so convert with `media.convertVoice` first. **users** |
| `delete`       | `delete(session_id, status_id) -> None`                                 | Delete a status. **users**                                                                                                                                     |

#### `client.search`

| Method   | Signature                         | Description                                                                            |
| -------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| `search` | `search(params) -> SearchResults` | Search persisted messages across sessions via the active search provider. **users** |

#### `client.templates`

| Method   | Signature                                                 | Description                     |
| -------- | --------------------------------------------------------- | ------------------------------- |
| `list`   | `list(session_id) -> list[TemplateRecord]`                | List templates. **users**    |
| `get`    | `get(session_id, template_id) -> TemplateRecord`          | Get one template. **users**  |
| `create` | `create(session_id, body) -> TemplateRecord`              | Create a template. **users** |
| `update` | `update(session_id, template_id, body) -> TemplateRecord` | Update a template. **users** |
| `delete` | `delete(session_id, template_id) -> None`                 | Delete a template. **users** |

#### `client.profile`

| Method                   | Signature                                                | Description                                                                    |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `set_profile_name`       | `set_profile_name(session_id, body) -> SuccessResult`    | Set the account display name. **users**                                     |
| `set_profile_status`     | `set_profile_status(session_id, body) -> SuccessResult`  | Set the account about/status text (empty clears it). **users**              |
| `set_profile_picture`    | `set_profile_picture(session_id, body) -> SuccessResult` | Set the account profile picture (`url` or `base64` + `mimetype`). **users** |
| `delete_profile_picture` | `delete_profile_picture(session_id) -> SuccessResult`    | Remove the account profile picture. **users**                               |

#### `client.calls`

| Method        | Signature                                           | Description                                                                                   |
| ------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `reject_call` | `reject_call(session_id, call_id) -> SuccessResult` | Reject a ringing incoming call. **Baileys only**: whatsapp-web.js answers `501`. **users** |
| `create_link` | `create_link(session_id, body) -> CallLinkResponse` | Create a shareable WhatsApp call link (`startTime` is epoch MILLISECONDS). **users**       |

#### `client.media`

| Method              | Signature                                                               | Description                                                                                  |
| ------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `conversion_status` | `conversion_status(session_id) -> MediaConversionAvailability`          | Whether conversion is switched on for this deployment AND the ffmpeg binary can be run.      |
| `convert_voice`     | `convert_voice(session_id, *, url=None, base64=None) -> ConvertedMedia` | Convert audio into a WhatsApp voice note (Ogg/Opus, mono, tuned for speech). **users**    |
| `convert_video`     | `convert_video(session_id, *, url=None, base64=None) -> ConvertedMedia` | Convert video into an MP4 every WhatsApp client accepts (baseline H.264 + AAC). **users** |

#### `client.health`

| Method  | Signature                        | Description             |
| ------- | -------------------------------- | ----------------------- |
| `check` | `check() -> HealthResponse`      | Aggregate health check. |
| `live`  | `live() -> dict[str, str]`       | Liveness probe.         |
| `ready` | `ready() -> HealthReadyResponse` | Readiness probe.        |

### Error Handling

Every error inherits from `MyWhatsappError`. A non-2xx response raises an `MyWhatsappApiError` (or a more specific subclass picked by status); a timeout raises `MyWhatsappTimeoutError`. The API-error classes carry `.status` (HTTP code), `.body` (parsed JSON or raw text), and `.error_kind` (the NestJS `error` field).

| Exception                           | Trigger                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MyWhatsappAuthError`               | HTTP `401` — missing or invalid API key                                                                                                                                                                                                                                  |
| `MyWhatsappForbiddenError`          | HTTP `403` — insufficient role                                                                                                                                                                                                                                           |
| `MyWhatsappNotFoundError`           | HTTP `404` — resource not found                                                                                                                                                                                                                                          |
| `MyWhatsappConflictError`           | HTTP `409` — typically engine-not-ready                                                                                                                                                                                                                                  |
| `MyWhatsappRateLimitError`          | HTTP `429` — too many requests                                                                                                                                                                                                                                           |
| `MyWhatsappNotImplementedError`     | HTTP `501` — active engine doesn't support the operation                                                                                                                                                                                                                 |
| `MyWhatsappServiceUnavailableError` | HTTP `503` — engine did not confirm in time; retryable. In a routed deployment a forwarded request answers 503 only when the owner node was never reached; a forward that fails after the request was sent answers 502 or 504, which the owner may already have acted on |
| `MyWhatsappApiError`                | any other non-2xx status (incl. unfollowed `3xx`)                                                                                                                                                                                                                        |
| `MyWhatsappTimeoutError`            | request exceeded `timeout` (has a `.timeout` attribute)                                                                                                                                                                                                                  |

```python
from mywhatsapp import (
    MyWhatsappClient,
    MyWhatsappConflictError,
    MyWhatsappNotFoundError,
    MyWhatsappRateLimitError,
    MyWhatsappTimeoutError,
    MyWhatsappApiError,
)

client = MyWhatsappClient(base_url="http://localhost:2785", api_key="owa_k1_…")

try:
    client.messages.send_text("my-session", {
        "chatId": "628123456789@c.us",
        "text": "Hi!",
    })
except MyWhatsappConflictError:
    print("Session engine not ready yet — start it first.")
except MyWhatsappNotFoundError:
    print("Session does not exist.")
except MyWhatsappRateLimitError:
    print("Rate limited — back off and retry.")
except MyWhatsappTimeoutError as e:
    print(f"Timed out after {e.timeout}s")
except MyWhatsappApiError as e:
    print(f"API error {e.status} ({e.error_kind}): {e.body}")
```

### Notable Behaviors

- **Redirects are never followed.** `follow_redirects` is forced off so the `X-API-Key` header is never re-sent to a redirect target. An unfollowed `3xx` therefore surfaces as an `MyWhatsappApiError` rather than a success.
- **Auth/JSON headers always win.** `default_headers` are applied first; the SDK then sets `Content-Type: application/json` and `X-API-Key`, so caller headers can never clobber them.
- **Path segments are percent-encoded.** Each path value (session/chat/message id, etc.) is encoded so a `/`, `#`, or `?` can't break out of its position; already-safe id characters `@`, `:`, `+` are left readable. Boolean query params are serialized lowercase (`true`/`false`); `None` query values are dropped.
- **Base-URL path prefix is preserved.** A trailing `/` is stripped from `base_url`, but any path prefix (e.g. when running behind a reverse proxy) is kept on every request.
- **No automatic retries.** Each call issues exactly one request; retry/backoff is the caller's responsibility. Wrap or inject a custom `transport` for retry or observability middleware.
- **Testable transport injection.** Pass `transport=httpx.MockTransport(handler)` to intercept requests in tests — no global monkey-patching.
- **204 / non-JSON handling.** A `204` (or empty body) returns `None`; a 2xx body that isn't valid JSON is returned as raw text instead of raising.
- **PEP 561 typed.** The package ships `py.typed`, so type-checkers consume the bundled hints directly.

## 18.4 PHP SDK

The PHP SDK is a hand-written, synchronous client built on Guzzle 7. It mirrors the full user-facing API surface: every resource method maps to one REST endpoint, request/response payloads are plain associative arrays, and non-2xx responses are translated into a typed `MyWhatsapp*Exception` hierarchy.

### Installation

```bash
composer require mywhatsapp/sdk
```

Requirements:

- **PHP 8.1+** (`declare(strict_types=1)` throughout; typed properties, `match`).
- **Guzzle 7** (`guzzlehttp/guzzle: ^7.9`).
- PSR-4 autoloaded under the `MyWhatsapp\` namespace (`"MyWhatsapp\\": "src/"`).

### Quick Start

```php
<?php
require 'vendor/autoload.php';

use MyWhatsapp\Client;

$client = new Client([
    'baseUrl' => 'http://localhost:2785',
    'apiKey'  => 'owa_k1_…',
]);

$client->sessions->start('my-session');

$result = $client->messages->sendText('my-session', [
    'chatId' => '628123456789@c.us',
    'text'   => 'Hello from the MyWhatsapp PHP SDK!',
]);

echo $result['messageId'];
```

The entry class is `MyWhatsapp\Client`. It validates that `baseUrl` and `apiKey` are present (throwing `MyWhatsappException` otherwise), constructs the shared HTTP transport, and exposes each resource as a public property: `$client->sessions`, `$client->messages`, `$client->search`, `$client->contacts`, `$client->groups`, `$client->webhooks`, `$client->chats`, `$client->status`, `$client->health`, `$client->labels`, `$client->channels`, `$client->catalog`, `$client->templates`, `$client->profile`, `$client->calls`.

Two escape hatches sit on the client itself:

| Method    | Signature                                                                             | Description                                                                                |
| --------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `auth`    | `auth(): array`                                                                       | `POST /api/auth/validate` — validate the configured key and resolve its role.              |
| `request` | `request(string $method, string $path, array $query = [], mixed $body = null): mixed` | Raw request against any path (advanced use); returns decoded JSON or `null` for empty/204. |

### Client Configuration

The constructor takes a single associative `$config` array:

| Key              | Type                           | Default          | Description                                                                                                                                                        |
| ---------------- | ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `baseUrl`        | `string`                       | — (**required**) | API base URL, e.g. `http://localhost:2785`. A trailing `/` is stripped; any path prefix (e.g. `/v1` behind a proxy) is preserved.                                  |
| `apiKey`         | `string`                       | — (**required**) | Sent as the `X-API-Key` header on every request.                                                                                                                   |
| `timeout`        | `float`                        | `30.0`           | Per-request timeout in seconds.                                                                                                                                    |
| `httpClient`     | `?\GuzzleHttp\ClientInterface` | `null`           | Inject a Guzzle client (e.g. one built on a `MockHandler`) for testing or middleware. When `null`, a default Guzzle client is created with the configured timeout. |
| `defaultHeaders` | `array<string,string>`         | `[]`             | Extra headers applied on every request, **under** the SDK's auth/JSON headers (which always win).                                                                  |

Missing `baseUrl` or `apiKey` throws `MyWhatsapp\Exceptions\MyWhatsappException` from the constructor.

### Resources & Methods

All payloads are associative arrays; all listed methods are synchronous and return the decoded JSON (an `array`), except the `void` deletes. Methods marked **users** require an operator-level API key.

#### `sessions`

| Method               | Signature                                            | Description                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`               | `list(array $query = []): array`                     | List all sessions. The optional query takes `limit`, `offset` and `name` (an exact, case-sensitive match; no match returns an empty list).                                                                                                                                                                                                                      |
| `getConfig`          | `getConfig(string $id): array`                       | Read a session's engine configuration.                                                                                                                                                                                                                                                                                                                          |
| `updateConfig`       | `updateConfig(string $id, array $body): array`       | Update a running session's configuration; takes effect without re-linking the account. **users**                                                                                                                                                                                                                                                             |
| `getProxy`           | `getProxy(string $id): array`                        | Read a session's masked proxy configuration (credentials never returned).                                                                                                                                                                                                                                                                                       |
| `updateProxy`        | `updateProxy(string $id, array $body): array`        | Update per-session proxy settings; changes apply on the next start. Send `proxyUrl: null` to clear. **users**                                                                                                                                                                                                                                                |
| `get`                | `get(string $id): array`                             | Get one session.                                                                                                                                                                                                                                                                                                                                                |
| `create`             | `create(array $body): array`                         | Create a session (`$body['name']` required). **users**                                                                                                                                                                                                                                                                                                       |
| `delete`             | `delete(string $id): void`                           | Delete a session. **users**                                                                                                                                                                                                                                                                                                                                  |
| `start`              | `start(string $id): array`                           | Start a session. **users**                                                                                                                                                                                                                                                                                                                                   |
| `stop`               | `stop(string $id): array`                            | Stop a session. **users**                                                                                                                                                                                                                                                                                                                                    |
| `logout`             | `logout(string $id): array`                          | Attempt an engine-native unlink of this device, then stop the session. A `200` means the unlink + local cleanup completed (not an independent Linked-Devices observation); a later `start` needs a fresh QR. A `502` (`SESSION_LOGOUT_INCOMPLETE`) stops locally but leaves the operation incomplete; start and retry. Requires a running session. **users** |
| `forceKill`          | `forceKill(string $id): array`                       | Force-kill a session. **users**                                                                                                                                                                                                                                                                                                                              |
| `getQrCode`          | `getQrCode(string $id): array`                       | Fetch the current QR code. **users**                                                                                                                                                                                                                                                                                                                         |
| `requestPairingCode` | `requestPairingCode(string $id, array $body): array` | Request a phone-pairing code. **users**                                                                                                                                                                                                                                                                                                                      |
| `setOnlinePresence`  | `setOnlinePresence(string $id, array $body): array`  | Set the account's own global presence (appear online or offline). **users**                                                                                                                                                                                                                                                                                  |
| `stats`              | `stats(): array`                                     | `GET /api/sessions/stats/overview`.                                                                                                                                                                                                                                                                                                                             |

#### `messages`

| Method         | Signature                                                                | Description                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`         | `list(string $sessionId, array $query = []): array`                      | List stored messages.                                                                                                                             |
| `sendText`     | `sendText(string $sessionId, array $body): array`                        | Send a text message (`send-text`). **users**                                                                                                   |
| `sendImage`    | `sendImage(string $sessionId, array $body): array`                       | Send an image. **users**                                                                                                                       |
| `sendVideo`    | `sendVideo(string $sessionId, array $body): array`                       | Send a video. **users**                                                                                                                        |
| `sendAudio`    | `sendAudio(string $sessionId, array $body): array`                       | Send audio. **users**                                                                                                                          |
| `sendDocument` | `sendDocument(string $sessionId, array $body): array`                    | Send a document. **users**                                                                                                                     |
| `sendSticker`  | `sendSticker(string $sessionId, array $body): array`                     | Send a sticker. **users**                                                                                                                      |
| `sendLocation` | `sendLocation(string $sessionId, array $body): array`                    | Send a location. **users**                                                                                                                     |
| `sendContact`  | `sendContact(string $sessionId, array $body): array`                     | Send a contact card. **users**                                                                                                                 |
| `sendTemplate` | `sendTemplate(string $sessionId, array $body): array`                    | Send a stored template. **users**                                                                                                              |
| `sendPoll`     | `sendPoll(string $sessionId, array $body): array`                        | Send a native poll (2–12 options). **users**                                                                                                   |
| `reply`        | `reply(string $sessionId, array $body): array`                           | Reply to a message. **users**                                                                                                                  |
| `forward`      | `forward(string $sessionId, array $body): array`                         | Forward a message. **users**                                                                                                                   |
| `clickButton`  | `clickButton(string $sessionId, array $body): array`                     | Tap a button or list row on a stored WhatsApp Business prompt (Baileys only). **users**                                                        |
| `react`        | `react(string $sessionId, array $body): array`                           | React to a message. **users**                                                                                                                  |
| `delete`       | `delete(string $sessionId, array $body): array`                          | Delete a message. **users**                                                                                                                    |
| `editMessage`  | `editMessage(string $sessionId, array $body): array`                     | Edit the text of a message already sent (`$body` needs `chatId`, `messageId`, `body`). **users**                                               |
| `history`      | `history(string $sessionId, string $chatId, array $query = []): array`   | Fetch chat history.                                                                                                                               |
| `reactions`    | `reactions(string $sessionId, string $chatId, string $messageId): array` | List reactions on a message.                                                                                                                      |
| `pin`          | `pin(string $sessionId, array $body): array`                             | Pin a message in its chat. `durationSeconds` must be 86400, 604800 or 2592000; in a group only admins may pin. **users**                       |
| `votePoll`     | `votePoll(string $sessionId, array $body): array`                        | Cast a vote on a poll; `options` are the option texts, not ids. Not supported on Baileys (`501`). **users**                                    |
| `star`         | `star(string $sessionId, array $body): array`                            | Star or unstar a message. Best-effort on whatsapp-web.js, which silently ignores a message it will not star. **users**                         |
| `unpin`        | `unpin(string $sessionId, array $body): array`                           | Unpin a pinned message. **users**                                                                                                              |
| `media`        | `media(string $sessionId, string $chatId, string $messageId): array`     | Fetch a message's stored media bytes: the archived file when one exists, else the inline copy on the message row. `404` when neither holds bytes. |
| `sendBulk`     | `sendBulk(string $sessionId, array $body): array`                        | Enqueue a bulk send batch. **users**                                                                                                           |
| `batchStatus`  | `batchStatus(string $sessionId, string $batchId): array`                 | Get bulk batch status.                                                                                                                            |
| `cancelBatch`  | `cancelBatch(string $sessionId, string $batchId): array`                 | Cancel a bulk batch. **users**                                                                                                                 |

#### `contacts`

| Method            | Signature                                                          | Description                                                                          |
| ----------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `list`            | `list(string $sessionId, array $query = []): array`                | List contacts.                                                                       |
| `get`             | `get(string $sessionId, string $contactId): array`                 | Get one contact.                                                                     |
| `check`           | `check(string $sessionId, string $number): array`                  | Check whether a number is on WhatsApp.                                               |
| `profilePicture`  | `profilePicture(string $sessionId, string $contactId): array`      | Get a contact's profile picture.                                                     |
| `profilePictures` | `profilePictures(string $sessionId, array $ids): array`            | Batch-resolve profile picture URLs for up to 50 contacts in one request.             |
| `phone`           | `phone(string $sessionId, string $contactId): array`               | Resolve a contact's phone number.                                                    |
| `block`           | `block(string $sessionId, string $contactId): array`               | Block a contact. **users**                                                        |
| `upsert`          | `upsert(string $sessionId, string $contactId, array $body): array` | Save a contact to the account's addressbook, or edit an existing entry. **users** |
| `delete`          | `delete(string $sessionId, string $contactId): array`              | Remove a contact from the account's addressbook. **users**                        |
| `unblock`         | `unblock(string $sessionId, string $contactId): array`             | Unblock a contact. **users**                                                      |
| `listBlocked`     | `listBlocked(string $sessionId): array`                            | List the ids this account has blocked. Session-wide, so it takes no contact id.      |

#### `groups`

| Method                      | Signature                                                                                           | Description                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `list`                      | `list(string $sessionId, array $query = []): array`                                                 | List groups.                                                                                                               |
| `get`                       | `get(string $sessionId, string $groupId): array`                                                    | Get one group.                                                                                                             |
| `create`                    | `create(string $sessionId, array $body): array`                                                     | Create a group. **users**                                                                                               |
| `joinInfo`                  | `joinInfo(string $sessionId, string $code): array`                                                  | Preview a group from its invite code WITHOUT joining. Read-only, so it is safe to call on a code from an untrusted source. |
| `joinGroup`                 | `joinGroup(string $sessionId, string $inviteCode): array`                                           | Join a group via its invite code. **users**                                                                             |
| `addParticipants`           | `addParticipants(string $sessionId, string $groupId, array $participants): array`                   | Add participants. **users**                                                                                             |
| `removeParticipants`        | `removeParticipants(string $sessionId, string $groupId, array $participants): array`                | Remove participants. **users**                                                                                          |
| `promoteParticipants`       | `promoteParticipants(string $sessionId, string $groupId, array $participants): array`               | Promote to admin. **users**                                                                                             |
| `demoteParticipants`        | `demoteParticipants(string $sessionId, string $groupId, array $participants): array`                | Demote admins. **users**                                                                                                |
| `setSubject`                | `setSubject(string $sessionId, string $groupId, string $subject): array`                            | Update the group subject. **users**                                                                                     |
| `setDescription`            | `setDescription(string $sessionId, string $groupId, string $description): array`                    | Update the group description. **users**                                                                                 |
| `getGroupSettings`          | `getGroupSettings(string $sessionId, string $groupId): array`                                       | Get the group settings (only the ones the active engine supports are present).                                             |
| `updateGroupSettings`       | `updateGroupSettings(string $sessionId, string $groupId, array $settings): array`                   | Update the group settings (at least one of `announce`, `locked`, `ephemeralSeconds`). **users**                         |
| `leave`                     | `leave(string $sessionId, string $groupId): array`                                                  | Leave the group. **users**                                                                                              |
| `getPicture`                | `getPicture(string $sessionId, string $groupId): array`                                             | The group's picture URL, or `null` when it has none.                                                                       |
| `setPicture`                | `setPicture(string $sessionId, string $groupId, array $body): array`                                | Set the group's picture. **users**                                                                                      |
| `deletePicture`             | `deletePicture(string $sessionId, string $groupId): array`                                          | Remove the group's picture. **users**                                                                                   |
| `inviteCode`                | `inviteCode(string $sessionId, string $groupId): array`                                             | Get the invite code. **users**                                                                                          |
| `revokeInviteCode`          | `revokeInviteCode(string $sessionId, string $groupId): array`                                       | Revoke and regenerate the invite code. **users**                                                                        |
| `getMembershipRequests`     | `getMembershipRequests(string $sessionId, string $groupId): array`                                  | List a group's pending join requests. Requires group admin.                                                                |
| `approveMembershipRequests` | `approveMembershipRequests(string $sessionId, string $groupId, ?array $participants = null): array` | Approve pending join requests; omit the list to approve all. **users**                                                  |
| `rejectMembershipRequests`  | `rejectMembershipRequests(string $sessionId, string $groupId, ?array $participants = null): array`  | Reject pending join requests; omit the list to reject all. **users**                                                    |

#### `chats`

| Method              | Signature                                                  | Description                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`              | `list(string $sessionId, array $query = []): array`        | List chats.                                                                                                                                                                |
| `subscribePresence` | `subscribePresence(string $sessionId, array $body): array` | Subscribe to a chat's presence; updates then arrive as `presence.update` events. The subscription belongs to the connection and does not survive a reconnect. **users** |
| `getPresence`       | `getPresence(string $sessionId, string $chatId): ?array`   | The last presence reported for a chat, or `null` when none has been. Held in memory, so a restart clears it.                                                               |
| `markRead`          | `markRead(string $sessionId, array $body): array`          | Mark chat(s) read. **users**                                                                                                                                            |
| `markUnread`        | `markUnread(string $sessionId, array $body): array`        | Mark chat(s) unread. **users**                                                                                                                                          |
| `archive`           | `archive(string $sessionId, array $body): array`           | Archive or unarchive a chat. `success: false` means the engine declined. **users**                                                                                      |
| `pin`               | `pin(string $sessionId, array $body): array`               | Pin a chat to the top of the list, or unpin it. `success: false` means WhatsApp declined — three pins maximum. **users**                                                |
| `mute`              | `mute(string $sessionId, array $body): array`              | Mute a chat until an absolute epoch-MILLISECONDS timestamp, or unmute with `null`. **users**                                                                            |
| `clearMessages`     | `clearMessages(string $sessionId, string $chatId): array`  | Delete every message in a chat, keeping the chat itself. **users**                                                                                                      |
| `delete`            | `delete(string $sessionId, array $body): array`            | Delete chat(s). **users**                                                                                                                                               |
| `sendState`         | `sendState(string $sessionId, array $body): array`         | Send a typing/recording state. **users**                                                                                                                                |

#### `webhooks`

| Method             | Signature                                                   | Description                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listAll`          | `listAll(array $query = []): array`                         | List webhooks across EVERY session the key can see, not one session's. **users**                                                                                    |
| `deliveryFailures` | `deliveryFailures(array $query = [])`                       | Deliveries that were attempted and failed — the diagnostic for a webhook that stopped arriving. A delivery a smart filter suppressed never reaches this log. **orgmenu** |
| `list`             | `list(string $sessionId): array`                            | List webhooks. **users**                                                                                                                                            |
| `get`              | `get(string $sessionId, string $id): array`                 | Get one webhook. **users**                                                                                                                                          |
| `create`           | `create(string $sessionId, array $body): array`             | Create a webhook. **users**                                                                                                                                         |
| `update`           | `update(string $sessionId, string $id, array $body): array` | Update a webhook. **users**                                                                                                                                         |
| `delete`           | `delete(string $sessionId, string $id): void`               | Delete a webhook. **users**                                                                                                                                         |
| `test`             | `test(string $sessionId, string $id): array`                | Send a test event. **users**                                                                                                                                        |

#### `labels` _(WhatsApp Business)_

| Method           | Signature                                                                   | Description                                                                              |
| ---------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `list`           | `list(string $sessionId): array`                                            | List labels.                                                                             |
| `get`            | `get(string $sessionId, string $labelId): array`                            | Get one label.                                                                           |
| `chats`          | `chats(string $sessionId, string $labelId): array`                          | Every chat carrying a label. **whatsapp-web.js only** — Baileys answers `501`.           |
| `upsert`         | `upsert(string $sessionId, string $labelId, array $body): array`            | Create or update a label. **Baileys only** — whatsapp-web.js answers `501`. **users** |
| `delete`         | `delete(string $sessionId, string $labelId): array`                         | Delete a label. **users**                                                             |
| `forChat`        | `forChat(string $sessionId, string $chatId): array`                         | List labels applied to a chat.                                                           |
| `addToChat`      | `addToChat(string $sessionId, string $chatId, array $body): array`          | Add a label to a chat (`$body` needs `labelId`). **users**                            |
| `removeFromChat` | `removeFromChat(string $sessionId, string $chatId, string $labelId): array` | Remove a label from a chat. **users**                                                 |

#### `channels` _(Newsletters)_

| Method              | Signature                                                                     | Description                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `list`              | `list(string $sessionId): array`                                              | List channels.                                                                                                              |
| `get`               | `get(string $sessionId, string $channelId): array`                            | Get one channel.                                                                                                            |
| `messages`          | `messages(string $sessionId, string $channelId, array $query = []): array`    | Recent channel messages.                                                                                                    |
| `create`            | `create(string $sessionId, array $body): array`                               | Create a channel this account owns. **users**                                                                            |
| `delete`            | `delete(string $sessionId, string $channelId): array`                         | Delete a channel this account owns. Irreversible, and every subscriber loses it — distinct from `unsubscribe`. **users** |
| `mute`              | `mute(string $sessionId, string $channelId, array $body): array`              | Mute or unmute a channel's notifications. **users**                                                                      |
| `subscribe`         | `subscribe(string $sessionId, array $body): array`                            | Subscribe via invite code (`$body` needs `inviteCode`). **users**                                                        |
| `unsubscribe`       | `unsubscribe(string $sessionId, string $channelId): array`                    | Unsubscribe from a channel. **users**                                                                                    |
| `demoteAdmin`       | `demoteAdmin(string $sessionId, string $channelId, array $body): array`       | Demote a channel admin back to a subscriber; no promote counterpart exists. **users**                                    |
| `transferOwnership` | `transferOwnership(string $sessionId, string $channelId, array $body): array` | Hand a channel to a new owner. Irreversible. **users**                                                                   |

#### `catalog` _(WhatsApp Business)_

| Method        | Signature                                               | Description                                                   |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| `info`        | `info(string $sessionId): array`                        | Get catalog info.                                             |
| `products`    | `products(string $sessionId, array $query = []): array` | List products (e.g. `['page' => 1, 'limit' => 20]`).          |
| `product`     | `product(string $sessionId, string $productId): array`  | Get one product.                                              |
| `sendProduct` | `sendProduct(string $sessionId, array $body): array`    | Send a product message (`chatId` + `productId`). **users** |

#### `status` _(Stories)_

| Method        | Signature                                                  | Description                                                                                                                                                       |
| ------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`        | `list(string $sessionId): array`                           | List status updates.                                                                                                                                              |
| `fromContact` | `fromContact(string $sessionId, string $contactId): array` | Status updates from one contact.                                                                                                                                  |
| `media`       | `media(string $sessionId, string $statusId): array`        | Fetch the stored media bytes for a status update (`{data, contentType}`; 404 when there is none).                                                                 |
| `sendText`    | `sendText(string $sessionId, array $body): array`          | Post a text status. **users**                                                                                                                                  |
| `sendImage`   | `sendImage(string $sessionId, array $body): array`         | Post an image status. **users**                                                                                                                                |
| `sendVideo`   | `sendVideo(string $sessionId, array $body): array`         | Post a video status. **users**                                                                                                                                 |
| `sendVoice`   | `sendVoice(string $sessionId, array $body): array`         | Post an audio status as a voice note. WhatsApp plays one only as Ogg/Opus and neither engine transcodes, so convert with `media.convertVoice` first. **users** |
| `delete`      | `delete(string $sessionId, string $statusId): void`        | Delete a status. **users**                                                                                                                                     |

#### `search`

| Method   | Signature                      | Description                                                                                                      |
| -------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `search` | `search(array $params): array` | Search persisted messages across sessions via the active search provider (`$params['q']` required). **users** |

#### `templates`

| Method   | Signature                                                           | Description                                                                                   |
| -------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `list`   | `list(string $sessionId): array`                                    | List templates. **users**                                                                  |
| `get`    | `get(string $sessionId, string $templateId): array`                 | Get one template. **users**                                                                |
| `create` | `create(string $sessionId, array $body): array`                     | Create a template (`$body` needs `name` and `body`; `header`/`footer` optional). **users** |
| `update` | `update(string $sessionId, string $templateId, array $body): array` | Update a template. **users**                                                               |
| `delete` | `delete(string $sessionId, string $templateId): void`               | Delete a template. **users**                                                               |

#### `profile`

| Method                 | Signature                                                    | Description                                                                    |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `setProfileName`       | `setProfileName(string $sessionId, string $name): array`     | Set the account display name. **users**                                     |
| `setProfileStatus`     | `setProfileStatus(string $sessionId, string $status): array` | Set the account about/status text (empty clears it). **users**              |
| `setProfilePicture`    | `setProfilePicture(string $sessionId, array $body): array`   | Set the account profile picture (`url` or `base64` + `mimetype`). **users** |
| `deleteProfilePicture` | `deleteProfilePicture(string $sessionId): array`             | Remove the account profile picture. **users**                               |

#### `calls`

| Method       | Signature                                              | Description                                                                                                                                   |
| ------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `rejectCall` | `rejectCall(string $sessionId, string $callId): array` | Reject a ringing incoming call (404 when it is not found or no longer ringing). **Baileys only**: whatsapp-web.js answers `501`. **users** |
| `createLink` | `createLink(string $sessionId, array $body): array`    | Create a shareable WhatsApp call link (`startTime` is epoch MILLISECONDS). **users**                                                       |

#### `media`

| Method             | Signature                                              | Description                                                                                  |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `conversionStatus` | `conversionStatus(string $sessionId): array`           | Whether conversion is switched on for this deployment AND the ffmpeg binary can be run.      |
| `convertVoice`     | `convertVoice(string $sessionId, array $media): array` | Convert audio into a WhatsApp voice note (Ogg/Opus, mono, tuned for speech). **users**    |
| `convertVideo`     | `convertVideo(string $sessionId, array $media): array` | Convert video into an MP4 every WhatsApp client accepts (baseline H.264 + AAC). **users** |

#### `health`

| Method  | Signature        | Description        |
| ------- | ---------------- | ------------------ |
| `check` | `check(): array` | `GET /api/health`. |
| `live`  | `live(): array`  | Liveness probe.    |
| `ready` | `ready(): array` | Readiness probe.   |

### Error Handling

All exceptions live in `MyWhatsapp\Exceptions` and descend from `MyWhatsappException` (which extends PHP's `\Exception`). Any non-2xx response is raised as an `MyWhatsappApiException`; the static `classify()` factory picks the most specific subclass by status code. An `MyWhatsappApiException` carries the HTTP status (`getStatus(): int`), the parsed error body (`getBody(): mixed`), and the NestJS `error` kind when present (`getErrorKind(): ?string`).

| Exception                               | Extends                  | Trigger                                                                                                                                                                                                                                                                           |
| --------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MyWhatsappException`                   | `\Exception`             | Base for all SDK errors (also thrown for missing `baseUrl`/`apiKey`).                                                                                                                                                                                                             |
| `MyWhatsappApiException`                | `MyWhatsappException`    | Any non-2xx (including unfollowed 3xx and other 4xx/5xx).                                                                                                                                                                                                                         |
| `MyWhatsappAuthException`               | `MyWhatsappApiException` | `401` — missing/invalid API key.                                                                                                                                                                                                                                                  |
| `MyWhatsappForbiddenException`          | `MyWhatsappApiException` | `403` — insufficient role (e.g. operator-only endpoint).                                                                                                                                                                                                                          |
| `MyWhatsappNotFoundException`           | `MyWhatsappApiException` | `404` — resource not found.                                                                                                                                                                                                                                                       |
| `MyWhatsappConflictException`           | `MyWhatsappApiException` | `409` — conflict (e.g. engine not ready).                                                                                                                                                                                                                                         |
| `MyWhatsappRateLimitException`          | `MyWhatsappApiException` | `429` — rate limited.                                                                                                                                                                                                                                                             |
| `MyWhatsappNotImplementedException`     | `MyWhatsappApiException` | `501` — active engine does not support the operation.                                                                                                                                                                                                                             |
| `MyWhatsappServiceUnavailableException` | `MyWhatsappApiException` | `503` — engine did not confirm in time; the only retryable one. In a routed deployment a forwarded request answers 503 only when the owner node was never reached; a forward that fails after the request was sent answers 502 or 504, which the owner may already have acted on. |
| `MyWhatsappTimeoutException`            | `MyWhatsappException`    | Request exceeded the timeout (`getTimeout(): float`). Not an API error — has no status/body.                                                                                                                                                                                      |

```php
<?php
use MyWhatsapp\Client;
use MyWhatsapp\Exceptions\MyWhatsappConflictException;
use MyWhatsapp\Exceptions\MyWhatsappRateLimitException;
use MyWhatsapp\Exceptions\MyWhatsappTimeoutException;
use MyWhatsapp\Exceptions\MyWhatsappApiException;

try {
    $result = $client->messages->sendText('my-session', [
        'chatId' => '628123456789@c.us',
        'text'   => 'Hello!',
    ]);
} catch (MyWhatsappConflictException $e) {
    // 409 — engine not ready yet
} catch (MyWhatsappRateLimitException $e) {
    // 429 — back off and retry yourself (no auto-retry)
} catch (MyWhatsappTimeoutException $e) {
    fwrite(STDERR, "timed out after {$e->getTimeout()}s\n");
} catch (MyWhatsappApiException $e) {
    // any other non-2xx
    fwrite(STDERR, "API {$e->getStatus()}: {$e->getMessage()}\n");
    var_dump($e->getBody());
}
```

### Notable Behaviors

- **Redirects are never followed.** Guzzle is configured with `allow_redirects => false`, so a `3xx` surfaces as an `MyWhatsappApiException` rather than being followed — the `X-API-Key` header is never re-sent to a redirect target.
- **Auth/JSON headers take precedence.** `defaultHeaders` are merged in first, then `X-API-Key`, `Content-Type: application/json`, and `Accept: application/json` are applied on top, so they can't be clobbered.
- **Path segments are percent-encoded.** Ids (chat/message/group ids, session names) pass through `encodeSegment()`, which `rawurlencode`s the value but keeps the WhatsApp-id-safe characters `@`, `:`, and `+` readable — so a value containing `/`, `#`, or `?` cannot break out of its path position.
- **Base-URL path prefix is preserved.** The base URL has its trailing `/` trimmed and requests are issued against an absolute `baseUrl . $path`; Guzzle's `base_uri` is intentionally unset, so a prefix like `/v1` behind a reverse proxy is retained.
- **Null query values are dropped.** Absent optional query parameters (`null`) are filtered out before the request, so they are never sent.
- **No automatic retries.** A failed request throws immediately; wrap calls in your own backoff if you need retries (notably for `429`). The injectable `httpClient` is the extension point for retry/observability middleware.
- **Empty/204 responses return `null`.** A `204` or empty body decodes to `null`; resource methods that promise an `array` coalesce this to `[]` (or to the resource object for single-item gets).
- **Testing without the network.** Inject a Guzzle client built on a `GuzzleHttp\Handler\MockHandler` via the `httpClient` config key — no global state, no live calls. The shipped test suite asserts on the exact path, method, and body.
- **PSR-4 autoloading.** Everything lives under the `MyWhatsapp\` namespace mapped to `src/`; `composer require mywhatsapp/sdk` wires up the autoloader.

## 18.5 n8n Community Node

MyWhatsapp's n8n integration is **not** part of these SDK packages. It is a separate community node maintained in its own repository, which speaks the same REST + webhook contract documented in [API Specification](./06-api-specification.md):

- An **action/HTTP** path that calls the REST endpoints (e.g. `POST /api/sessions/:id/messages/send-text`) with the `X-API-Key` header.
- A **trigger** path that registers a webhook (the `webhooks` resource) and receives inbound events, verifying the `X-MyWhatsapp-Signature` HMAC.

For installation and node-by-node configuration, see the dedicated [n8n Integration guide](./22-n8n-integration.md). Because the node consumes the public API contract, the verified route/event reference in docs 06 and §6.6 (Webhook Events) is the authority for what it can call and receive.

## 18.6 SDK Versioning & Releases

### Versioning

The five SDKs are versioned **independently of the gateway** and of each other, each following SemVer. An SDK version does **not** track the gateway version — check the registry for the current one rather than inferring it from the gateway's. Pin the SDK version your code is tested against and treat a major SDK bump as potentially breaking.

| SDK                   | Registry             | Package                               |
| --------------------- | -------------------- | ------------------------------------- |
| JavaScript/TypeScript | npm                  | `@mywhatsapp/sdk`                     |
| Python                | PyPI                 | `mywhatsapp-sdk`                      |
| PHP                   | Packagist            | `mywhatsapp/sdk`                      |
| Java                  | Maven Central        | `com.mywhatsapp:mywhatsapp`           |
| Go                    | (none — module path) | `github.com/rmyndharis/OpenWA/sdk/go` |

### Contract-drift protection

The wire types live in a dedicated module (`types.ts` / `types.py`) so they can later be regenerated by an OpenAPI codegen pass without touching the hand-written resource methods.

**Requests.** Each SDK's test suite mocks the HTTP transport and **asserts on the exact request path, method, and body** — so a drift between an SDK method and the real API (the class of bug that once shipped `messages/text` instead of the real `messages/send-text`) breaks a test rather than reaching users.

**Responses.** That is a different problem, and for a long time nothing covered it — #754 is the proof: the status, label, and channel record types drifted from the engine interface for releases without a single test noticing, because asserting the request says nothing about the reply. It is not covered by `openapi:check` either: those controllers declare no typed `@ApiResponse`, so `openapi.json` carries no response schema for them and there is nothing to diff. The gate is now `sdk/javascript/test/wire-contract.test-d.ts` — a type-level test where `tsc --noEmit` (run by `npm test` ahead of vitest) fails if a record type stops matching the engine-neutral shape as it arrives over JSON. Its `Wire*` types are **maintained by hand**: `sdk-ci.yml` re-runs the job when `whatsapp-engine.interface.ts` changes, but keeping the two in step is a human step, not a generated one.

### Release process

```bash
# JavaScript
cd sdk/javascript && npm test && npm run build && npm run smoke   # smoke = require()+import() packaging check
# Python
cd sdk/python && python -m pytest -q
# PHP
cd sdk/php && composer install && ./vendor/bin/phpunit
```

CI runs all five suites (`sdk-ci.yml`), path-filtered to `sdk/**` plus the server-side contract surfaces the SDKs are written against — `src/**/dto/**`, `src/**/*.controller.ts`, `src/**/*.service.ts` and `whatsapp-engine.interface.ts` — so a change to the wire contract re-runs them. The PHP package is mirrored to its own Packagist repository via a `git subtree split`, and that mirror publish is gated on the PHP tests passing, so a broken SDK cannot auto-publish. Bump the version, update the SDK's CHANGELOG, run the suite above, then tag/publish to the relevant registry.
