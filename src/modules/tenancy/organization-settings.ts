import { assertValidQuietHours } from '../compliance/quiet-hours';
import { QuietHoursSettingsDto, UpdateOrganizationSettingsDto } from './dto/organization-settings.dto';

/** The settings blob as the rest of the gateway sees it: known keys typed, unknown keys preserved. */
export type OrganizationSettings = Record<string, unknown>;

/** A window with at least one field an operator typed — the trigger for validating it. */
const WINDOW_FIELDS = ['start', 'end', 'timezone', 'weekdays'] as const;

/**
 * Apply a settings PATCH to what is stored, and validate the result.
 *
 * The validation runs on the MERGED window, not on the patch, and that placement is the whole point.
 * A PATCH carrying `{start: "22:00"}` is not a valid window and not an invalid one — it is half of
 * every window that has a complete `end` and `timezone` already stored. Validating the patch would
 * either reject every field-by-field edit or accept an edit that leaves the stored window broken, and
 * the first is what a form that saves one field at a time actually does. So the patch is a delta, the
 * merge is the window, and `assertValidQuietHours` sees a window — which is the same function the
 * evaluator's own fall-open path documents, so what is rejected here is exactly what would otherwise
 * have been stored and then warned about on every send.
 *
 * Unknown top-level keys are carried through untouched. `settings` is a blob shared with features
 * that have not shipped yet, and a key this DTO cannot name is not a key to delete.
 */
export function mergeOrganizationSettings(
  current: OrganizationSettings | null | undefined,
  patch: UpdateOrganizationSettingsDto,
): OrganizationSettings {
  const merged: OrganizationSettings = { ...(current ?? {}) };
  if (patch?.quietHours === undefined) return merged;

  // Shallow-merge the window rather than replacing it, so `{enabled: false}` does not take the times
  // with it. `undefined` keys are skipped: the global validation pipe cannot distinguish an absent
  // JSON key from an explicit `undefined`, and treating the latter as "set to undefined" would store a
  // key whose presence some future reader might mistake for a value.
  const currentWindow = (merged['quietHours'] ?? {}) as QuietHoursSettingsDto;
  const window: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(currentWindow)) {
    if (value !== undefined) window[key] = value;
  }
  for (const [key, value] of Object.entries(patch.quietHours)) {
    if (value !== undefined) window[key] = value;
  }
  merged['quietHours'] = window;

  assertMergedWindowIsUsable(window);
  return merged;
}

/**
 * Refuse a merged window that could never work, once any field of it has been supplied.
 *
 * Two deliberate asymmetries:
 *
 * - **It runs even when `enabled` is `false`.** The values are inert while paused, so an argument
 *   exists for ignoring them — but the operator who turns the window back on is then met by a window
 *   that silently never applied, with no log line saying why (the evaluator falls open and warns
 *   instead of muting). Catching the typo at the moment it is typed is the only point where anyone is
 *   looking at the value.
 * - **It is skipped entirely when no window field is present.** `{enabled: true}` on its own is
 *   incomplete but not wrong: the stored times are still the ones that will apply, and demanding a
 *   window in the same request would break the toggle on its own.
 */
function assertMergedWindowIsUsable(window: Record<string, unknown>): void {
  const supplied = WINDOW_FIELDS.filter(field => window[field] !== undefined);
  if (supplied.length === 0) return;
  // A stored window with a field MISSING (a hand-edited row, an older schema) is rejected rather than
  // completed: naming the missing field is what tells the operator which part of their window to fix.
  assertValidQuietHours(window);
}

/**
 * The typed view of a settings blob for the API response.
 *
 * Reads only `quietHours` and leaves everything else alone. Returning the whole blob would be simpler
 * but would publish whatever any future feature stores there — which may not be something a read-only
 * admin key should see — so the surface is the set of keys this gateway knows how to interpret.
 */
export function toSettingsResponse(
  organizationId: string,
  settings: OrganizationSettings | null,
): {
  organizationId: string;
  quietHours?: QuietHoursSettingsDto;
} {
  const quietHours = settings?.['quietHours'];
  if (!quietHours || typeof quietHours !== 'object') return { organizationId };
  return { organizationId, quietHours };
}
