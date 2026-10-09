# 32 — SaaS Product Roadmap

> **Status:** design proposal. **Nothing in this document is implemented**, and this is not a
> commitment schedule — it is an argument for where the value in this product is, written against the
> code as it stands and the market as it is priced today.
>
> **Anchors reference spec files by name and symbol** (stable) rather than line numbers (they rot) —
> the same convention as `docs/31`.
>
> **Relationship to other documents.** `docs/15-project-roadmap.md` is a Phase 1–3 planning artifact
> whose release table stops at v0.12.x, while the project is well past that; `CHANGELOG.md` is the
> record of what actually shipped. This document does not restate either. Where tenancy is concerned
> it **extends** `docs/28-multitenancy.md`, whose isolation decision and target schema are adopted
> here unchanged; where raw protocol capability is concerned it is bounded by
> `docs/29-engine-capability-matrix.md`.

---

## 32.1 The finding that shapes this document

MyWhatsapp is **world-class at the protocol layer and empty at the product layer.** Those are two different
skills, and only one of them is finished.

| Layer                                                 | State                                                                                                                                                                                                    | Evidence                                                                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| WhatsApp protocol & gateway                           | Ahead of the paid gateways it positions against: 170 paths / 212 operations, 226 engine adapter cells of which 199 are available, two engines, eleven install-time upstream patches, ban instrumentation | `openapi.json`, `docs/29`, `scripts/postinstall.js`                                                                                       |
| Operator product (inbox, flows, AI, CRM)              | Single message tester + a chat transcript view                                                                                                                                                           | `dashboard/src/pages/Chats.tsx`, `dashboard/src/pages/MessageTester.tsx`                                                                  |
| SaaS product (identity, tenancy, billing, compliance) | **Does not exist**                                                                                                                                                                                       | `docs/28-multitenancy.md` §28.2 states this in its own words: _"no named users or memberships, dashboard identity is the API key itself"_ |

### 32.1.1 The gap census

Every row verified by absence as well as presence — a name that appears nowhere in `src/`,
`dashboard/src/`, `sdk/` and `openapi.json` is not a weak feature, it is no feature.

> [!IMPORTANT]
> **This census is a dated audit, kept as written.** The rows below were true when it was first
> taken, and several have since been built; the verdict column is left alone deliberately so the
> starting point stays legible next to what it became. Rows that have moved, and where the work is
> documented: **Tenancy** (`docs/28` §28.4, TenancyService, `organizations`/`users`/`memberships`);
> **Message retention / purge** (`MESSAGE_RETENTION_DAYS`, `MessageRetentionService`);
> **Opt-out / consent / quiet hours** (see §32.6.3 below and `docs/33`). Everything not listed here
> is still absent.

| Capability                                          | Verdict    | Evidence                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Named users, login, seats                           | **Absent** | `src/modules/auth/entities/api-key.entity.ts` is the only auth entity. No JWT/passport/TOTP/SSO dependency. `dashboard/src/pages/Login.tsx` validates a pasted API key and reads the role off the key                                                                                             |
| Tenancy                                             | **Absent** | Zero `tenantId` / `orgId` / `workspaceId` across all 21 entities; isolation is per-`sessionId` via `api-key-authorization.ts`                                                                                                                                                                     |
| Billing, plans, quotas, metering                    | **Absent** | No payment dependency, no subscription/plans/quota model. `ApiKeyEntity.usageCount` exists and is never compared to a limit                                                                                                                                                                       |
| Flow builder / multi-step automation                | **Absent** | `automation-rule.entity.ts` is documented in its own class comment as _"a single-message autoreply rule"_; `automation-rules.service.ts` is first-match-wins, exactly one reply. Flat AND-only conditions, no branching, and no dashboard page                                                    |
| Scheduling / send-at / delayed jobs                 | **Absent** | No scheduler dependency, no cron decorator anywhere; the BullMQ queues in `src/modules/queue/` carry no delayed-job support                                                                                                                                                                       |
| Saved replies / canned responses                    | **Absent** | No entity, route or control. `src/modules/template/` is a `{{placeholder}}` mail-merge store, not an operator quick reply, and is not wired into the chat view                                                                                                                                    |
| Notes, assignment, routing, SLA, ticket             | **Absent** | No such entities. `ConversationMappingEntity.handoverState` is `bot \| human \| closed` but is plugin-facing only, carries no agent identity, and has no route or UI                                                                                                                              |
| Contact records, custom fields, segments            | **Absent** | `src/modules/contact/` is a thin proxy to the WhatsApp address book with no entities; `UpsertContactDto` accepts first and last name only. `src/modules/label/` proxies WhatsApp's own labels, which are empty on personal accounts and unusable on one engine for reads and the other for writes |
| Opt-out / consent / quiet hours                     | **Absent** | No `consent`, `optedOut` or STOP-keyword handling anywhere. The only related artifact is operator-facing dashboard copy warning against sending to strangers                                                                                                                                      |
| AI / LLM                                            | **Absent** | No model provider dependency. `src/core/agent-tools/` is an MCP tool registry — typed descriptors, no model calls                                                                                                                                                                                 |
| Attribution / funnel / ROI                          | **Absent** | `src/modules/stats/stats.controller.ts` exposes three volume-only routes; no stats DTO carries a campaign dimension                                                                                                                                                                               |
| Message retention / purge                           | **Absent** | Inbound and outbound history is persisted with no TTL, and no `MESSAGE_RETENTION_DAYS` equivalent appears among the retention knobs in `env.validation.ts`. Chat media archives on `CHAT_MEDIA_ARCHIVE_TTL_DAYS`, but the messages themselves never expire                                        |
| Scheduling UI surface already in the API but unused | **Wasted** | `chats/typing`, `chats/mute`, `chats/pin`, `chats/archive`, `messages/send-poll`, `messages/send-location`, `messages/send-template`, `messages/edit`, `messages/forward`, `labels/*` all exist as routes and are unreachable from the chat view                                                  |

### 32.1.2 What this implies

Customers in this category pay most of their bill for the missing application layer — the inbox, the
automation, the AI, the reporting — and use the transport as a commodity. Building more protocol
surface competes in the one layer already finished, against competitors whose upstream libraries are
the constraint (see 32.7).

**The product to build is the operator application on top of a gateway that is already done.**

---

## 32.2 Why the timing is unusually good

- **Per-message billing reached conversational use.** Meta's charge for service messages — the human
  and third-party-AI replies sent inside the service window — took effect on 1 October 2026, and its
  own AI is billed per token from 1 August 2026. Every business solution provider must now answer a
  question they could previously defer: _what did this conversation cost me?_ That question is a
  product, not a dashboard.
- **The unofficial transport carries a structural cost advantage.** No Meta per-message fee, no
  template pre-approval, no business verification, no onboarding window. Providers mark Meta's rates
  up by roughly 10–25%; "0% markup" is now an explicit headline claim across the category.
- **The agent surface is being recognised as a feature.** At least one major provider now sells a
  managed messaging MCP tier. MyWhatsapp's 51-tool MCP surface with read-only-by-default, per-chat scoped
  keys and per-tool-call chat checks is ahead of that, not behind it.
- **Price anchors for a plan tier** (indicative, publicly listed): per-number-per-month in the
  €49–249 range by provider tier; seats commonly $15–30/month; broad platform plans from roughly
  $49 to $159/month with enterprise above that.

**Read 32.3 before acting on any of it.** The feature list is the easy half.

---

## 32.3 The decision that must come first

Two of the three models below are legally and operationally different businesses wearing the same
code. The feature priority order changes with the answer, so it is asked first.

|               | **A. Managed multi-tenant cloud**                                                                                                                                                  | **B. Self-hosted + paid operator**                                                  | **C. Dual transport**                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Who pays      | Many small tenants, one operator                                                                                                                                                   | Agencies and businesses, per deployment                                             | Regulated and compliance-bound buyers                                                                              |
| What you sell | Convenience, isolation, safety                                                                                                                                                     | Isolation, control, SLA, number safety                                              | A choice of transport per account                                                                                  |
| Main risk     | WhatsApp's terms prohibit unofficial automated clients; you would carry ban exposure you do not control, for tenants you do not know, in the jurisdictions where that matters most | Slower to close, longer sales cycle                                                 | Largest build: an official-API provider is a second engine contract against a different, stricter capability model |
| Unlocks       | Tier 0 in full, public signup, usage-based billing                                                                                                                                 | Tier 0 partial, avoids multi-tenant data exposure, keeps the MIT core as the funnel | The only model that can serve a buyer who needs approved templates or official deliverability guarantees           |
| Blocks        | Requires 32.6.3 compliance guardrails before the first paying tenant                                                                                                               | Weak usage-based pricing; seats and instances are the only meters                   | —                                                                                                                  |

**Recommendation: B first, C as the twelve-month moat, A only after 32.6.3 ships.** B converts the
strongest thing this project has — a self-hosted gateway people already trust — into revenue without
putting other people's numbers behind your terms-of-service exposure. C is what eventually lets the
same product serve a bank next to a freelancer, and it is a much larger investment than it looks,
because `docs/29` documents how unforgiving the official surface is by comparison.

A note on honesty rather than law: this project's own README states that for deployments where
ethical, legal or regulatory compliance matters, MyWhatsapp should be treated as not approved. That
sentence is a strategic asset under B and C, and a liability under A. Do not quietly delete it.

---

## 32.4 Priority 0 — the SaaS blockers

Nothing in Priority 1 or 2 can be sold, or safely operated, before these. They are unglamorous and
they are the whole commercial product.

### S0.1 — Organisations, users, memberships, seats

**Gap:** no identity but the API key; roles are a property of a key, so two humans sharing a
dashboard are indistinguishable in the audit trail and cannot be licensed separately.
**Build on:** the enforcement pattern already in place. `allowedSessions` and `allowedChats` resolve
at the guard boundary via `api-key-authorization.ts` and `chat-scope.service.ts`, and
`request-context.ts` already stamps the acting principal for audit. A tenant and membership check
plugs into exactly that boundary — `docs/28` §28.4 already chose shared-database isolation.
**Design:** `organizations`, `users`, `memberships` (tenant role `owner | admin | operator |
viewer`), sessions and keys owned by an organization; keep `ApiKeyRole` as the platform-level role so
programmatic access is unchanged; email+password with TOTP as the credential, API keys retained for
machine callers.
**Accept when:** two users in one organization have independently attributable audit rows; a
`viewer` membership cannot write through any route including MCP and the WebSocket; an
organization's data is unreachable from another organization's session list; the existing
single-tenant deployment is unchanged after upgrade.
**Effort:** XL. This is `docs/28` §28.5–28.7 executed.

### S0.2 — Usage ledger, quota enforcement, billing

**Gap:** nothing can be invoiced, and nothing stops one tenant consuming another's capacity.
**Build on:** metering primitives that already exist — `ApiKeyEntity.usageCount`, the throttler
guard, the send-pacing counters read from the messages table, and the restriction gauges. What is
missing is an event-shaped ledger that can be aggregated by organization, not per key.
**Design:** an append-only usage-event ledger (messages sent and received by type, campaigns run,
webhook deliveries, sessions connected, storage bytes) attributed to an organization; plan
definitions with limits enforced **at the same guard boundary as S0.1** so a limit is a `402`-shaped
answer on the existing path rather than a new subsystem; invoice generation on top of the ledger.
**Why this is urgent rather than merely necessary:** since per-message charging reached
conversational sends, cost-per-conversation is the first question a buyer asks, and it is the one
question an unofficial transport can answer better than anyone — it is zero, and the ledger is the
proof. Every provider marking up Meta's rates by 10–25% is selling transparency here.
**Accept when:** an organization sees cost and volume per conversation and per day; a limit produces
a typed refusal before the work is attempted, not after; the ledger reconstructs an invoice for a
closed period from the ledger alone.
**Effort:** XL.

### S0.3 — Isolation, audit boundary, retention, encryption at rest

**Gap:** tenancy does not exist (S0.1), messages never expire, and no tenant can be exported or
erased as a unit.
**Build on:** `docs/28`'s decision that a session's organization is derived, so message and search
rows resolve through `sessionId → tenantId` with no per-row backfill; the existing audit module and
its self-policing coverage gate; the retention pattern in
`integration-retention.service.ts`.
**Design:** the backfill and cutover in 32.8; `MESSAGE_RETENTION_DAYS` and media retention as
operator policy; per-organization export and erasure; encryption at rest as `docs/15` already
scheduled it.
**Accept when:** one organization can be exported and erased completely and verifiably; a message
older than the retention window is gone along with its media; an audit query cannot cross an
organization boundary.
**Effort:** L for retention and export, XL for encryption at rest, on top of S0.1.

---

## 32.5 Priority 1 — what customers actually pay for

### P1.1 — A real team inbox

The largest perceived-value gap, and the cheapest to close, because most of the backend already
exists and the dashboard simply does not use it.

| Capability                                                                    | Backend today                                                         | UI today                            |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------- |
| Typing indicator, presence                                                    | Route and event exist                                                 | **Never called**                    |
| Conversation filters                                                          | `search-query.dto.ts` filters by session, chat, direction, type, date | Substring match on name and id only |
| Status, tags, assignment, internal notes, saved replies, SLA                  | Absent                                                                | Absent                              |
| Pin, archive, mute, unread, edit, forward, polls, location, contact, template | All routed                                                            | **Unreachable** from the chat view  |
| Media                                                                         | One file per message                                                  | —                                   |

**Build on:** `ConversationMappingEntity.handoverState` promoted from plugin-only state to a
first-class conversation model carrying an agent identity; the existing chat-scoped keys, which
already let an agent see exactly one conversation — the enforcement primitive an inbox needs.
**Design:** `conversations` (organisation, session, chat, status, assignee, first-response and
resolution timestamps, tags), `conversation_notes`, `saved_replies`, routing rules and a
first-response SLA; wire the orphaned routes into the view.
**Accept when:** two agents work one inbox with no message handled twice and no message invisible to
either; assignment and status survive a reconnect; an SLA breach is measurable per agent.
**Effort:** L.

### P1.2 — A flow builder

The category's headline feature — every serious competitor sells a drag-and-drop flow builder as the
thing you can build in ten minutes — and MyWhatsapp has one rule that sends one message.

**Design:** evolve `AutomationRule` into a versioned flow document: triggers (inbound message,
schedule, contact attribute change, campaign event), steps (send text/media/template, interactive
buttons and lists, wait with a delay window, set attribute, set tag, hand off to agent, call a
webhook or MCP tool), and edges (condition with OR groups, timeout, default branch). A published flow
is immutable and versioned; a conversation pins the version it entered on, so editing a live flow
cannot change the behaviour of a conversation already in flight. Each step executes through the
existing send path, so send pacing, the `message:sending` veto and takeover gating all continue to
apply — a flow cannot become a route around the safety controls.
**Accept when:** a multi-step flow with a wait and a branch survives a session reconnect mid-flow and
resumes at the right step; a human takeover silences a flow mid-conversation; a version change does
not alter an in-flight conversation.
**Effort:** XL. The versioning rule is the part worth getting right the first time.

### P1.3 — An AI agent, with the customer's own key

Bring-your-own-key is now table stakes in this category and, more importantly, the only version worth
building: it keeps the model decision and the data boundary with the customer.

**Design:** a knowledge base (URLs, documents, Q&A pairs, catalog) retrieved per turn; a
confidence threshold below which the agent escalates into the P1.1 inbox with context already
attached; suggested replies for human agents as a separate, cheaper feature that needs no
autonomy; per-organization spend caps; and the agent's actions taken through the existing guard,
hook and handover machinery rather than around it.
**Why this is the defensible version rather than a clone:** the agent runs _inside_ the gateway, so
it is subject to the same chat scoping, the same `message:sending` veto, the same takeover gate and
the same audit trail as any other sender. An external bot builder attached by webhook is none of
those things. The Integration Fabric in `docs/25` is the reason this is buildable at all — the agent
gets a hosted, signature-verified, deduplicated, ordered inbound path without running a server.
**Accept when:** an agent can be confined to one chat and one organization; a low-confidence turn
escalates with history attached and the agent stops; every agent send is attributable and auditable;
the spend cap stops it.
**Effort:** XL.

### P1.4 — Scheduling, drip sequences, audiences

Campaigns exist and are genuinely good — per-row validation, pacing-aware pausing, poll and
numbered-list reply collection. What is missing around them is the rest of the marketing loop.

**Design:** scheduled and drip sends on the queue's delayed-job support; audiences as first-class
saved segments over contact attributes; lifecycle triggers; per-audience exclusions and suppression
lists so a campaign can never reach an unsubscribed or recently-contacted chat; template variables
validated at publish time.
**Accept when:** a scheduled send fires inside its window after a restart; an audience is a query,
not a copied list; an exclusion is enforced by the send path, not only by the campaign UI.
**Effort:** L–XL.

---

## 32.6 Priority 2 — the moat

Expensive to copy, and the reason a customer stays rather than switches.

### 32.6.1 The number-safety control plane

The strongest objection to an unofficial gateway is that the number dies. MyWhatsapp already carries the
deepest instrumentation in this category — restriction kinds, a three-tier pacing model with warmup
and cold-reachout ramps, a failure circuit breaker, reconnect metrics — and almost none of it is
surfaced.

**Design:** make restriction state _predictive_ rather than reactive: show the reachout limitation and
the remaining daily allowance before a campaign is started rather than as a pause reason afterwards;
surface the account's quality signals as a readable health score; recommend the safe action instead of
just refusing; support number rotation and failover to a healthy number; publish proposed metrics for
allowance and health alongside the existing `mywhatsapp_*` series in `docs/10`.
**Accept when:** an operator can see, before sending, why a campaign would be throttled; a number
under restriction raises an actionable alert instead of a status code.
**Effort:** L–XL. High value per unit of work; the instrumentation is already paid for.

### 32.6.2 Retention, media durability, history sync

Messages are persisted and media is returned inline but never durably stored. That is simultaneously
a compliance liability and a missing product.

**Design:** `MESSAGE_RETENTION_DAYS` and media retention as policy; durable media so an agent, a
search and an AI agent all have something to read; history visible in the inbox so a new agent sees
past conversations; per-organization export and erasure, which S0.3 depends on.
**Accept when:** a customer can prove what they hold and delete it on request.
**Effort:** L.

### 32.6.3 Compliance guardrails

Absent entirely, and the thing that makes a managed deployment defensible.

**Design:** opt-out keywords with a suppression list enforced in the send path; a consent ledger with
provenance and timestamp; quiet hours and per-audience send windows; free-form versus template policy
per organization so an operator can bound what their account can ever send; webhook creation and
deletion emitted into the audit log, which `intentionally-unemitted-actions.ts` already names as a
gap it self-documents.
**Accept when:** no send path can reach a suppressed contact; every send can name the consent it
relied on.
**Effort:** L. Ship this **before** model A in 32.3.

**Status (partial).** Enforcement and storage are built — see `docs/33`. The opt-out registry with
keyword detection and identity expansion is enforced by both send paths through `OutboundGuardService`
before the plugin gate and before any row is written; the append-only consent ledger, its migration
and its attribution rules exist; the quiet-hours evaluator is written and DST-tested, and a window
configured on an organization now actually refuses sends through both paths. The first
acceptance test holds. The second does not yet: no send records the consent it relied on, because
there is no send-time call into the ledger, and no send-time call should exist without the
configuration API below.

Remaining before this item can be called done:

- ~~A settings API and dashboard surface for `quietHours`~~ — landed: `GET`/`PATCH /api/organizations/settings` (orgmenu) plus a dashboard Compliance page in all 13 locales, with `assertValidQuietHours` now the validator for the merged window. What remains is per-tenant authorization: an orgmenu key can currently write any organization's settings because an API key carries no organization.
- Operator endpoints for listing/manually changing suppressions and for reading a contact's consent trail.
- WhatsApp `onBlock`/`onUnblock` wired to `markBlocked`.
- Consent matched by identity family, not literal address string, so a LID opt-out and a phone opt-out describe the same person.
- Send-time provenance: which basis and which record authorised a given send.
- Audit-log coverage for suppression and consent changes.

### 32.6.4 Agents on the inbox side, and a plugin marketplace

MCP currently reads and sends. Let an agent work the queue too — list unassigned conversations,
claim one, leave a note, change status, trigger a flow — with the same per-chat scoping and audit
already applied to the send tools. Separately, `data/plugins/registry.json` ships two engines and
nothing else; the plugin runtime in `docs/19` and the sandbox in `docs/30` are a moat that exists
only as an API until someone can publish to it.
**Effort:** L for the tools, XL for a marketplace with signing, versioning and trust.

### 32.6.5 Web widget and QR lead capture

No lead-capture surface exists; every QR code in the product pairs a session. A website widget that
opens WhatsApp with context attached, and a QR generator per campaign, are the cheapest acquisition
features in the category.
**Do not** build click-to-WhatsApp _ads_ attribution or retargeting — those are official-API only
(32.7). A prefilled deep link works; ad-level attribution does not.
**Effort:** M.

---

## 32.7 Explicitly not on this roadmap

- **More protocol surface.** `docs/29` documents the 27 unavailable adapter cells as library
  limitations measured against live builds, including page internals that **cannot be patched
  around** — `createGroup`, `demoteChannelAdmin`, `transferChannelOwnership` and call rejection on the
  browser engine. That is the ceiling of what the upstream libraries expose. Competing here means
  competing against an upstream that ships faster than patches.
- **Official-API-only features:** WhatsApp Pay, Flows, click-to-WhatsApp ads and retargeting, approved
  template management, official coexistence. None are reachable from the current engines. They belong
  to model C (32.3), not to this document.
- **A public messaging directory or third-party marketplace for the gateway itself.** The compliance
  and abuse exposure is disproportionate to the revenue.

---

## 32.8 Tier-0 migration design: everything lands in a default organization

The path that keeps every existing deployment working, and the reason S0.1 is safe to ship.

**Principle, from `docs/28` §28.3:** a session's organization is _derived_. Messages, audit rows,
search indexes and campaign rows resolve through `sessionId → organizationId`. **No per-row backfill
of the messages table is required**, which matters because that table is the largest and the one
`CHANGELOG.md` warns must not be bulk-converted.

**Order of operations**

1. **Add, do not repurpose.** `organizations`, `users`, `memberships`, plus an `organizationId`
   column on the tenant-owned entities that do not already reach a session: sessions, api keys,
   plugins policy, webhooks and templates. Nullable at first; non-null once backfilled.
2. **Create the default organization** on boot when multi-tenancy is off, and bind every existing row
   to it. Nothing changes for a single-tenant operator: one organization, one implicit membership,
   the same routes, the same keys, the same dashboard.
3. **Backfill in dependency order**, sessions first, then everything else. Sessions are the join key
   for everything derived, so they go alone in the first migration and each subsequent migration
   backfills a table that resolves through them.
4. **Add a default-tenant resolution fallback** in the guard boundary rather than in each service —
   one place, one rule, and it is the same place `docs/28` §28.4 already put isolation.
5. **Flip enforcement behind a flag**, default off. In enforcement mode the fallback is unreachable;
   a row that was not backfilled is a visible error, not a silent cross-tenant read.
6. **Verify before enabling**, per the three questions that matter: does every session resolve to an
   organization; does every organization resolve to sessions; and does any query return a row whose
   session resolves to a different organization.
7. **Rollback** is dropping the flag. No destructive step is taken in steps 1–5, so this is genuine.

**The failure mode to design against:** a single forgotten fallback turns into cross-tenant data. That
is why the fallback lives in exactly one place, and why step 5 makes its disappearance loud.

**Status: steps 1, 2, 3 and 4 are implemented.** What has landed is the schema and the resolution
boundary, deliberately with no REST surface and no behaviour change:

| Step                                  | State                                                                                                                                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Add, do not repurpose              | `organizations`, `users`, `memberships` (main connection) and `sessions.organizationId` (data connection) exist. Nullable, indexed, no repurposed column.                                                               |
| 2. Create the default organization    | Seeded at the frozen `DEFAULT_ORGANIZATION_ID` by migration, and idempotently re-checked at boot (`TenancyService.onModuleInit`) because `synchronize: true` — the default — creates tables without running migrations. |
| 3. Backfill in dependency order       | Sessions only, as designed. `AddSessionOrganizationId` backfills every existing row; nothing derived from a session is touched.                                                                                         |
| 4. Default-tenant resolution fallback | `TenancyService`, one place. Strict on output: an unknown organization throws rather than being billed to the default tenant.                                                                                           |
| 5. Flip enforcement behind a flag     | `MULTITENANCY_ENABLED`, default off, validated as a strict boolean and blank-forwarded by both compose files. With it off a supplied organization id is ignored entirely.                                               |
| 6. Verify before enabling             | **Not done.** No enforcement path exists yet to verify.                                                                                                                                                                 |
| 7. Rollback is dropping the flag      | Holds: no destructive step has been taken.                                                                                                                                                                              |

Also landed with this step, ahead of the metering that will need it: the `usage_events` ledger
(S0.2's table, append-only and immutable, excluded from data export/import so a restore cannot replay
a bill).

**What is deliberately not here yet.** There is no organization/user/membership route, no email or
TOTP credential, and no seat limit. `organizations.plan` is a label, not a billing source of truth.
Enablement is the next step and is a separate change, because it is the step that can start returning
cross-tenant data if the fallback is wrong.

---

## 32.8.1 S0.2 part 2 — the ledger is now written

`UsageService` (`src/modules/usage/usage.service.ts`) is the single writer, and it is wired to both
billable seams:

| Kind               | Seam                                     | Gate that prevents a wrong number                        |
| ------------------ | ---------------------------------------- | -------------------------------------------------------- |
| `message.sent`     | `MessageSendService.emitPersisted`       | `status === SENT`                                        |
| `message.received` | `MessageProjector.persistInboundMessage` | the `UNIQUE(sessionId, waMessageId)` insert actually won |

Three properties are the point of the design, in priority order:

1. **Metering can never fail a message.** The `record*` methods return `void`, do not await, and log
   a warning on rejection. Message latency must not depend on a table nothing about sending needs.
2. **Attribution is delegated, never decided at a call site.** No caller passes an organization; they
   pass a session and `TenancyService` resolves. One copy of the fallback is one copy to get right.
3. **Zero added reads on a single-tenant install.** With enforcement off, attribution returns the
   frozen `DEFAULT_ORGANIZATION_ID` constant without touching the database, so the cost is one extra
   `INSERT` per message and no extra `SELECT`.

The read side exists so the exit criterion can be tested: `summarize()` reconstructs a closed period
per kind by summing `quantity`, and `totalFor()` returns the single number a quota check will compare.
Both are half-open (`from` inclusive, `to` exclusive) so adjacent periods tile without double-counting
a boundary instant. `SUM`/`COUNT` results are coerced to `number`, because PostgreSQL returns bigint as
a string and two summed windows would otherwise concatenate.

**Counted deliberately wrong rather than silently wrong.** Phone-originated sends are under-counted
(the own-send echo path is not metered, because metering it would double-count every API send). Inbound
totals exclude pre-connection history backfill. Both are documented in `docs/05` rather than left for a
reader of the seam to discover.

**Still not recorded:** `session.connected` (`handleEngineReady` fires per reconnect, so it needs a
first-binding gate that belongs with the seat work) and `api.call` (per-request rows would dwarf the
message volume this table is sized for, and `ApiKeyEntity.usageCount` already counts per key).

---

## 32.9 First ninety days

Sequenced so that each phase is sellable to the next, rather than building the moat before there is
a customer to give it to.

| Weeks | Deliverable                                                                                                                    | Exit criterion                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–4   | S0.2 usage ledger + S0.1 organizations, users, memberships, seats                                                              | An organization exists, a membership has an attributable audit trail, the ledger reconstructs a period, and a single-tenant upgrade is byte-for-byte compatible |
| 5–8   | P1.1 inbox depth: assignment, notes, tags, saved replies, typing indicator, filters, and the orphaned routes wired in          | Two agents work one inbox with no double-handling; first-response time is measurable                                                                            |
| 9–12  | P1.2 flow builder v1 (multi-step, wait, branch, escalate) and P1.3 BYOK agent with suggested replies and confidence escalation | A flow survives a mid-conversation reconnect; an agent confined to one chat escalates correctly                                                                 |

**Ship alongside, cheap and overdue:** the two unemitted audit actions named in
`intentionally-unemitted-actions.ts`; `MESSAGE_RETENTION_DAYS`; the `docs/13` split noted below.

---

## 32.10 Pricing shape and the unit economics behind it

**Shape:** per connected number, plus per seat, plus an instance or capacity tier. **No per-message
markup**, and that is the pitch — it is now an explicit headline claim across the category, and on an
unofficial transport it is not a discount, it is the truth.

An unofficial transport carries one genuine cost driver a customer should be able to see: the browser
engine's per-session memory footprint, several times that of the WebSocket engine. That is a
capacity plan and a per-number price difference, and surfacing it is more honest than hiding it —
`docs/29` already carries the numbers.

**The second half of the economics is the one to be deliberate about.** Memory per session is the
dominant cost, and it is why the WebSocket engine should be the default for density and the browser
engine the priced "safer but heavier" option — a tradeoff `docs/29` and the README both already state
rather than argue against.

---

## 32.11 Risks this roadmap creates

| Risk                                            | Why it is real here                                                                                                                      | Mitigation                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Terms-of-service and ban exposure               | The transport is unofficial by design, and `docs/29` documents that ban risk is irreducible and upstream                                 | Model B or C in 32.3; guardrails before model A; a stated acceptable-use posture instead of silence                                    |
| Two engines, unequal capability                 | 27 unavailable cells, uneven across reads, writes and call handling                                                                      | Surface the per-account capability set to operators rather than failing at call time                                                   |
| Eleven upstream patches underwrite both engines | A patch that fails to apply can leave a gateway that looks healthy and is not                                                            | The matrix's own caveat that a session reaching ready is not evidence a patch landed; treat patch health as an operator-visible signal |
| Scaling is single-replica in practice           | `docs/13` documents the lease, sweep and routing machinery as implemented while its remaining sections describe a design that is not     | Finish `docs/13` before selling multi-node, and sell single-node capacity honestly until then                                          |
| Support burden per tenant                       | Sessions need intervention when a number is restricted                                                                                   | The number-safety control plane (32.6.1) is also the support-deflection strategy                                                       |
| The doc goes stale                              | This project's own history is a lesson in that: `docs/15` stopped at v0.12.x, and `docs/13` describes two opposite realities in one file | Anchor every claim to a file and symbol, as done here; revise this document when a gate can enforce it instead                         |

---

## 32.12 A documentation correction that belongs with this work

`docs/13-horizontal-scaling.md` states in its first lines that multi-node deployment is partially
implemented and that the supported topology remains one replica, then spends its remaining length
describing a proposed design — affinity strategies, Swarm, Kubernetes manifests, load balancers and
throughput projections — that does not exist. A reader who starts at the top is told not to run
something the same document then explains how to run.

This is called out here rather than in 32.4 because it is a credibility cost paid on every sales
conversation by anyone who reads the docs before the demo. Fixing it is a deletion and a redirect.

---

## 32.13 Related documents

- `docs/28-multitenancy.md` — the tenancy and identity design this extends; nothing in it is
  implemented
- `docs/25-integration-fabric.md` — the inbound substrate the AI agent and compliance features depend on
- `docs/29-engine-capability-matrix.md` — the ceiling on protocol surface, and the per-engine cost and
  capability data behind 32.7 and 32.10
- `docs/31-session-lifecycle-design.md` — the invariants any flow, agent or inbox feature must not break
- `docs/15-project-roadmap.md` — the historical Phase 1–3 plan; `CHANGELOG.md` is the shipped record
