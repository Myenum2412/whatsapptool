/**
 * Resolve the effective session filter for a scoped read. The calling key's `allowedSessions` is
 * authoritative: a request-supplied `sessionId` may only narrow WITHIN that scope, never broaden it.
 * This is the shared fix for endpoints that accept `sessionId` as a query param, which the
 * ApiKeyGuard's route-param-only fence does not cover (see audit + webhook delivery-failures).
 *
 * Returns:
 *   - `null`     → no filter; the caller queries all sessions (unrestricted key, no narrowing)
 *   - `string[]` (non-empty) → filter `sessionId IN (...)` (the whole allowlist, or a single narrowed id)
 *   - `[]`       → the requested session is outside the key's scope; the caller must return nothing
 *
 * A null/empty `allowedSessions` means "unrestricted" (e.g. an ADMIN key), mirroring the guard model.
 */
export function resolveSessionScope(
  allowedSessions: string[] | null | undefined,
  requestedSessionId?: string,
): string[] | null {
  const scoped = allowedSessions != null && allowedSessions.length > 0;
  if (scoped) {
    return requestedSessionId ? allowedSessions.filter(s => s === requestedSessionId) : allowedSessions;
  }
  return requestedSessionId ? [requestedSessionId] : null;
}

/**
 * True when `sessionScope` — a resource's session binding, where null/undefined means "all
 * sessions" — falls inside the calling key's `allowedSessions`. An unrestricted key (no allowlist)
 * sees every scope; a scoped key only sees resources bound to one of its own sessions, so a null
 * scope (and the '*' wildcard) is never inside its fence. Use this on surfaces whose session
 * binding travels in the request body or in persisted rows, which the ApiKeyGuard's route-param
 * fence cannot reach (the same body/persisted-scope pattern the integration-instance controller
 * uses to confine a scoped key to instances bound inside its allowedSessions).
 */
export function sessionScopeVisible(
  allowedSessions: string[] | null | undefined,
  sessionScope: string | null | undefined,
): boolean {
  if (allowedSessions == null || allowedSessions.length === 0) return true;
  return sessionScope != null && sessionScope !== '*' && allowedSessions.includes(sessionScope);
}

// ── Account ownership (private sessions per account) ─────────────────────────────────────────────

/**
 * The session restraint of one API key, for surfaces that carry no route-param sessionId for the
 * guard fence to scope (list/aggregate reads and query-param handlers). Two independent axes:
 *
 *  - `allowedSessions` — the explicit allowlist an operator set on a hand-minted key (unchanged).
 *  - `ownerUserId` — the dashboard account a sign-in minted the key for. When set AND the key's role
 *    is `users`, the account sees exactly the sessions it owns (`sessions.ownerUserId`), so a
 *    `users` account's WhatsApp connections are private to it. `orgmenu` account keys and hand-minted
 *    operator keys (ownerUserId NULL) keep the pre-existing fail-open model.
 */
export interface SessionScopeContext {
  allowedSessions?: string[] | null;
  ownerUserId?: string | null;
}

/** The calling key's fields the ownership rule reads; structural so session-scope stays import-free. */
export interface SessionScopeKeyLike {
  allowedSessions?: string[] | null;
  ownerUserId?: string | null;
  role?: string | null;
}

export const ACCOUNT_USER_ROLE = 'users';

/**
 * Derive a key's {@link SessionScopeContext}. Only a key that is BOTH account-owned and `users`-role
 * carries `ownerUserId`; an `orgmenu` account key and any hand-minted key get `null`, i.e. no owner
 * restraint (they see all — that is the operator model this increment preserves).
 */
export function sessionScopeContext(apiKey?: SessionScopeKeyLike | null): SessionScopeContext {
  if (!apiKey) return {};
  const isAccountUserKey = apiKey.ownerUserId != null && apiKey.role === ACCOUNT_USER_ROLE;
  return {
    allowedSessions: apiKey.allowedSessions,
    ownerUserId: isAccountUserKey ? apiKey.ownerUserId : null,
  };
}

/**
 * Normalize a caller-supplied session filter into a {@link SessionScopeContext}, accepting the
 * legacy bare `string[] | null` form (the allowedSessions argument of findBySession-style services)
 * so existing callers and call sites that only know an allowlist stay on the pre-ownership shape.
 */
export function normalizeSessionScope(scope?: SessionScopeContext | string[] | null): SessionScopeContext {
  if (scope == null || Array.isArray(scope)) {
    return { allowedSessions: Array.isArray(scope) ? scope : null };
  }
  return scope;
}
