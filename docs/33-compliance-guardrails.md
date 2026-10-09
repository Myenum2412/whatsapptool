# 33 — Compliance Guardrails: Opt-Out, Consent and Quiet Hours

> **Status:** living design note. Three controls, the order they are evaluated in, and the
> decisions that are load-bearing rather than incidental. Anchors reference **spec files by name**
> (stable), not line numbers (they rot). Roadmap context: `docs/32` §32.6.3.

The temptation is to treat this as one feature — "compliance" — and to implement it as one list of
recipients that messages must not go to. That single-list model cannot answer either of the two
questions a regulated buyer actually asks, which are _"what did you send them, and on what
authority?"_ and _"why was it 11pm?"_. So there are three separate things, on three tables, with a
fixed order between them.

| Control                      | Table                              | Answers                                               | Mutable?            |
| ---------------------------- | ---------------------------------- | ----------------------------------------------------- | ------------------- |
| Suppression (do-not-contact) | `suppressed_contacts`              | "May we contact this chat at all?"                    | Yes — current state |
| Consent ledger               | `contact_consents`                 | "What did they agree to, when, and who recorded it?"  | No — append-only    |
| Quiet hours                  | `Organization.settings.quietHours` | "Is this a reasonable hour for this org's customers?" | Yes — org policy    |

Collapsing the first two into one table is the specific mistake to avoid. `suppressed_contacts` is
one row per contact holding current state, so a withdrawal is an `UPDATE`. `contact_consents` is an
**event log**: a second withdrawal is a new row, never an update, because an `UPDATE` that flips
granted → withdrawn leaves no record that consent ever existed — precisely the moment an operator
most needs to show what happened. Mirrors `usage_events`: no `updatedAt`, corrections are
compensating rows.

---

## 33.1 Order of evaluation

Both send paths — `MessageSendService` and `BulkMessageService` — ask ONE service, `OutboundGuardService`.

**Suppression first, then quiet hours.** The order is not a style preference; each way round has a
distinct wrong answer:

- Quiet hours first → an opt-out is reported as a timing problem. The operator is told to retry after
  09:00, which is both wrong and, at 23:00, the start of a nine-hour silence in which a complaint
  goes unanswered. The send is refused again anyway.
- Suppression first → correct, and the compliance answer survives every other gate.

The whole reason this is one service: the two paths are separate files, and the bug that produced the
forward bypass earlier was exactly two copies of a gate reading a DTO differently. A fourth control
must be added in one file, not two.

**Pinned by** `outbound-guard.service.spec.ts` (ordering, both-controls reporting) and the
compliance-gate blocks in `message-send.service.spec.ts` / `bulk-message.service.spec.ts`.

### Where the window comes from

The send path knows a **session**; a window belongs to an **organization**. `sessions.organizationId`
(data connection) and `Organization.settings` (always-SQLite `main` connection) are two databases, so
the lookup is explicit rather than a foreign key:

```
send → OutboundGuardService → TenancyService.settingsForSession
                                 ├─ data: sessions.organizationId   (one column)
                                 └─ main: organizations.settings    (memoised)
```

Three decisions are load-bearing here:

- **`undefined` means "resolve it"; `null` means "there is no policy".** A caller that already holds
  the settings — a preview endpoint, a batch — passes them and pays nothing. A caller that
  deliberately means "no window" says so explicitly.
- **Resolution happens AFTER suppression.** An opt-out is refused either way, and there is no reason to
  spend a cross-connection read explaining a send that was never going to happen.
- **`settingsForSession` returns `null`, never throws, for every unresolvable case** — no organization
  attributed, organization gone, no settings blob. It runs inside the send path, so a settings read
  must never be the reason a message fails to send. The controls allowed to refuse a send are the
  compliance ones, deliberately.

The `main`-connection read is memoised per organization for 30s (`ORGANIZATION_SETTINGS_TTL_MS`). A
campaign is many messages to one tenant, and without the cache each one would cost a second read for
an identical answer. The TTL bounds the failure mode — a window edited by hand in SQL takes up to 30s
to apply on each node — and a settings _write_ calls `forgetOrganizationSettings`, so an API save
takes effect immediately. `null` is cached too; re-querying for the absent case would defeat the cache
on exactly the installs that have no quiet hours configured.

**Pinned by** `tenancy.service.spec.ts` (30 cases: per-tenant isolation, TTL expiry, `null` caching,
attribution and missing-organization fallbacks) and the settings-resolution block in
`outbound-guard.service.spec.ts`.

### Placement relative to the rest of the gate

```
pacing (429) → compliance (409) → plugin moderation (400) → row write → engine
```

Before the plugin gate, because a plugin may rewrite the recipient — an opt-out must not be defeated
by a template that rewrites `chatId`. Before the row write, because a refused send must not acquire a
FAILED or pending row in that contact's history. In bulk, a refusal fails **only that item**: the rest
of the batch is still legal to send, because one bad row must not cost every other recipient their
message.

### What a refusal is not

A compliance refusal fires **no** `message:failed` hook and increments no breaker. Nothing was handed
to WhatsApp, so nothing failed; firing it would page an on-call engineer for a decision somebody made
on purpose. Bulk reports it with a stable per-item code (`RECIPIENT_SUPPRESSED`, `QUIET_HOURS`) rather
than `SEND_FAILED`, because a `SEND_FAILED` invites a retry loop that cannot succeed until morning.
Suppression's own `reason` is never echoed into a batch result: it can hold an operator's free-text
note, and one sender's internal note must not leak to every other sender sharing that batch.

---

## 33.2 Suppression

`SuppressionService` over `suppressed_contacts`, one row per `(sessionId, chatId)`, `current = true`
means do not contact.

**Identity expansion is the load-bearing part.** WhatsApp addresses one person three ways — `@c.us`,
WhatsApp, and LID (`@lid`). A customer who stops one form and gets messaged on another has not opted
out, they have found the loophole. Every send resolves the destination's identifier family before the
check, so all forms of an address are suppressed together.

The destination is resolved `chatId ?? toChatId` — a **forward carries no `chatId`**, so checking
`chatId` alone let every forwarded message skip the check entirely while its persisted row drained the
destination's pacing budget.

Keyword opt-outs are applied inbound by `message-projector.service.ts`:

| Family  | Keywords                                       | Action   |
| ------- | ---------------------------------------------- | -------- |
| Opt-out | `STOP`, `UNSUBSCRIBE`, `END`, `CANCEL`, `QUIT` | Withdraw |
| Opt-in  | `START`, `SUBSCRIBE`, `RESUME`                 | Grant    |

Design decisions worth not re-litigating:

- **Whole-message match.** A message containing `stop` among other words is not an opt-out; a
  customer writing "I should stop complaining about my invoice" must not be muted by a substring.
- **Groups are ignored.** Opting out of a group is not a thing; keywords in a group chat are
  conversation, not a directed instruction.
- **Fire-and-forget, and deliberately not gated on persistence.** The engine may re-fire the same
  inbound event; `applyInbound` is idempotent, and a re-fire does not re-apply. Opt-out handling still
  runs when the message row itself failed to write — an inbound message that already arrived at
  WhatsApp cannot be recalled, so the gate must not depend on our write succeeding.
- **`BLOCKED` is sticky.** A WhatsApp-level block cannot be undone by `unsuppress`, whatever the
  source. See the gap list in §33.5.

---

## 33.3 Consent ledger

`ConsentLedgerService` over `contact_consents`, append-only. `currentState()` reads the latest row per
basis; `summary()` returns the whole trail.

**Two bases, not one.** `marketing` and `transactional` are separable consent, so `STOP` withdraws
marketing and leaves a service-recovery message alone. Collapsing them would force a choice between
muting an account that still needs its password reset, and keeping marketing alive after an explicit
opt-out.

**No record means `GRANTED`.** Absence is not withdrawal: a pre-existing contact list must not become
a broadcast that is silently mute. The safety does not come from this table — it comes from
`suppressed_contacts`, which is checked unconditionally on every send. This table is evidence, not a
gate, and is deliberately never consulted to decide whether a send may proceed.

**Attribution is required for anything a human asserts.** `OPERATOR` and `IMPORT` both need an
`operatorId`. `IMPORT` is included deliberately: an upload is how a consent list gets laundered — a
spreadsheet of "active customers" quietly becomes thousands of `GRANTED` rows nobody confirmed — and
the person who ran the upload is the only one who can say where they came from. A contact's own
keywords carry no operator, because no human is involved.

The projector writes the ledger and the suppression row **independently**, each fire-and-forget with
its own error handling. Neither is allowed to fail the receive path: a message that has arrived at
WhatsApp cannot be un-received. Neither failure can remove the other — an evidence-write failure must
not silently cost the actual gate.

---

## 33.4 Quiet hours

Per-organization, from `Organization.settings.quietHours`, **not** from env: a window is a per-tenant
business decision, and env is per-process, so with two tenants on one gateway env would apply one
tenant's window to the other.

```jsonc
{
  "quietHours": {
    "enabled": true,
    "start": "22:00", // HH:MM local; 24:00 allowed
    "end": "07:00", // wraps midnight when start > end
    "timezone": "Europe/Lisbon", // IANA only
    "weekdays": [1, 2, 3, 4, 5, 7], // ISO, Monday = 1; omit = every day
    "exemptChatIds": ["15551234567@c.us"],
  },
}
```

Decisions worth not re-litigating:

- **Refused, not queued.** A send inside the window is a `409` carrying `nextAllowedAt`, not a
  deferred delivery. Holding it means a message issued at 23:00 lands at 07:05, and "deliver later"
  silently changes the authority the send was made under — a price quoted at 23:00 is often stale at
  07:00. Refusing makes the operator's policy the visible one.
- **IANA zones only, via `Intl.DateTimeFormat` with no added dependency.** A fixed offset like
  `+05:30` cannot express DST and works on some runtimes and not others, so the same account behaves
  differently after an ICU update.
- **Invalid configuration falls open, loudly.** Unknown zone, unparseable `HH:MM`, or `start === end`
  warn and resolve to _no window_. The alternative is a bad config silently muting a paying account —
  and because an unusable zone would otherwise throw a `RangeError` inside `Intl`, a typo would
  present as a 500 outage rather than as the config mistake it is. A half-configured window must not
  mean "quiet forever".
- **No second registry read.** `QuietHoursService` knows about the clock and nothing else; ordering
  with suppression lives only in `OutboundGuardService`. Pinned structurally in
  `quiet-hours.service.spec.ts`, which asserts the suppression import is absent — a duplicated read or
  a divergent order is invisible to a behavioural test.

`nextAllowedAt` is computed by walking forward through local-day offsets and solving for the instant
the window closes, so an overnight window returns tomorrow's morning and a weekday-scoped one returns
the next permitted weekday. DST is handled by re-deriving the local minutes after each candidate
instant rather than assuming a 24-hour day.

**Pinned by** `quiet-hours.spec.ts` (42 cases: overnight, weekday, exemption, DST, boundaries) and
`quiet-hours.service.spec.ts` (refusal shape, fall-open, clock-only).

---

## 33.4 Configuring a window

`GET`/`PATCH /api/organizations/settings`, orgmenu-only and unscoped, documented in `docs/06`. Three
decisions carry the design:

**PATCH merges; it does not replace.** `Organization.settings` is a JSON blob shared with features
that have not shipped, so a typed PUT cannot express a key it does not know about — and the global
pipe runs with `forbidNonWhitelisted`, so a client holding such a key could not send it back at all.
The merge is one level deep inside `quietHours`, which is what makes `{enabled: false}` pause a
window rather than delete it.

**The MERGED window is what gets validated, not the patch.** A patch carrying `{start}` is not a
window; it is half of one whose `end` and `timezone` are already stored. Validating the patch would
reject every field-by-field edit a form makes, so `assertValidQuietHours` — the same function the
evaluator's fall-open path documents — sees a complete window. This is what finally makes that
previously-unused function the single source of truth for what may be stored.

**A window is validated even while `enabled` is `false`.** The values are inert while paused, so
ignoring them looks defensible; but the operator who switches it back on is then met by a window that
silently never applied, explained only by a warn-level line. The same argument justifies refusing a
write that lands on an already-broken stored window rather than reporting "saved".

The write invalidates `TenancyService`'s settings cache, so the next send enforces the new window
immediately rather than after the TTL. The operator-facing GET deliberately does NOT read through
that cache: a form hydrating from a value up to 30s stale would show a policy different from the one
sends are enforcing, and the difference is invisible until a send is refused.

The dashboard's **Compliance** page (admin-only nav item) is the same policy as a form, in all 13
locales. It keeps "never configured" apart from "configured but paused", because a screen that
collapses them renders "quiet hours off" for a tenant that never set them and then saves that
reading back.

**Pinned by** `organization-settings.spec.ts` (merge semantics, merged-window validation), the write
block in `tenancy.service.spec.ts` (fresh read, no save on refusal, cache invalidation) and
`organization-settings.controller.spec.ts` (org resolution, 404 over 500, audit payload).

---

## 33.5 What is not built yet

Honest inventory, so the next person does not assume the roadmap item is closed:

- **No operator endpoints** for listing or manually changing suppressions, or for reading a contact's
  consent trail. The services are there; the HTTP surface is not.
- **`BLOCKED` has no event adapter.** `markBlocked()` exists and is protected in `unsuppress`, but
  nothing wires WhatsApp `onBlock` / `onUnblock` to it.
- **Consent is matched literally**, by exact address string. Suppression expands identity families;
  the ledger does not. A contact who stops on their LID has a `WITHDRAWN` row for that form only, so
  their audit trail and their suppression state describe different people.
- **`currentState` orders by `decidedAt` alone.** Two records written in the same millisecond — a
  bulk import backfilled with a shared timestamp — have no defined winner.
- **Organization settings are `orgmenu`-only and not tenant-scoped.** An orgmenu key can read and write any
  organization's settings, because an API key carries no organization — there is no user login and no
  per-tenant principal yet, so there is nothing to narrow by. This route must be tightened when that
  lands; the same reason it is excluded from the SDKs (`sdk/README.md`).
- **Audit-log coverage** for suppression and consent changes, which §32.6.3 also calls for.
