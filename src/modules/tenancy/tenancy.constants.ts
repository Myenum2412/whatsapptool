/**
 * The id of the organization a single-tenant install runs as.
 *
 * Imported by BOTH the main-connection migration that seeds the row and the data-connection
 * migration that backfills `sessions.organizationId`, because those are two databases and two
 * migration files: the backfill cannot look the id up, so it has to name it.
 *
 * FROZEN. It is already the value existing `sessions.organizationId` and `usage_events.organizationId`
 * rows point at, so changing it would orphan them. A migration that genuinely needs to change it must
 * re-point those rows first. This is why it is a literal constant rather than a generated uuid.
 *
 * Deliberately not a valid v4 random-looking uuid (`...4000-8000-...` with an all-zero tail): it
 * should be recognizable in a database dump as the seeded default and never collide with a
 * generated id.
 */
export const DEFAULT_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';

/** Slug of the seeded default organization. Also frozen: it is unique-indexed. */
export const DEFAULT_ORGANIZATION_SLUG = 'default';

/** Display name of the seeded default organization. */
export const DEFAULT_ORGANIZATION_NAME = 'Default Organization';

/**
 * Whether multi-tenant ENFORCEMENT is on.
 *
 * The schema always exists; this only controls whether a request must carry and resolve an
 * organization. Default off, so every existing deployment keeps its current behaviour on upgrade,
 * and so a wrong value in a fresh `.env` cannot turn a self-hosted install into a multi-tenant one
 * with no way back.
 *
 * Read with a bare `=== 'true'` like the other feature flags, which is why `MULTITENANCY_ENABLED` is
 * in the `checkBool` list in env.validation.ts: a typo there would otherwise silently leave
 * enforcement OFF while the operator believed it was on.
 */
export const isMultitenancyEnabled = (): boolean => process.env.MULTITENANCY_ENABLED === 'true';

/**
 * How long an organization's `settings` blob may be reused before it is re-read, in milliseconds.
 *
 * `TenancyService.settingsForSession` sits on the outbound send path — once per message — and would
 * otherwise add a read against the `main` connection to every send, doubling the database round trips
 * the compliance gate costs for a value an operator changes perhaps monthly.
 *
 * Thirty seconds is chosen for its failure mode rather than its hit rate: the worst a change can be
 * wrong for is that long. A quiet-hours window that takes effect 30s late mutes a few messages rather
 * than persisting indefinitely, which is what a cache without a bound would risk.
 *
 * Deliberately in-process and per-node. A multi-node gateway therefore converges within this window
 * per node rather than instantly, which is the correct trade for an outbound policy: the node that
 * applies it is the one that sends.
 *
 * A settings WRITE calls `TenancyService.forgetOrganizationSettings`, so the API path bypasses this
 * window entirely; only an edit made by hand in SQL is subject to it.
 */
export const ORGANIZATION_SETTINGS_TTL_MS = 30_000;
