import { OptOutAction } from './entities/suppressed-contact.entity';

/** Keywords that opt a contact OUT. WhatsApp's required baseline is STOP, UNSUBSCRIBE and END. */
export const DEFAULT_OPT_OUT_KEYWORDS: readonly string[] = ['STOP', 'UNSUBSCRIBE', 'END', 'CANCEL', 'QUIT'];

/** Keywords that opt a contact back IN. */
export const DEFAULT_OPT_IN_KEYWORDS: readonly string[] = ['START', 'SUBSCRIBE', 'RESUME'];

export interface OptOutMatch {
  action: OptOutAction;
  /** The keyword as written by the contact, for the audit trail. */
  keyword: string;
}

const stripDecoration = (raw: string): string =>
  raw
    // Emoji and variation selectors are not word characters in JS regex, so a bare \b would split
    // "STOP🛑" into a match on the wrong edge and then keep the emoji out of the comparison entirely.
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu, ' ')
    // Punctuation WhatsApp clients and humans add around a keyword. `#` is in the set because a
    // hash-prefixed command ("#STOP") is one of the commonest ways a contact opts out.
    .replace(/[.!?,;:()[\]{}'"`#*_\-~^>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

const normalizeKeywords = (list: readonly string[] | undefined, fallback: readonly string[]): string[] =>
  (list?.length ? list : fallback).map(kw => stripDecoration(kw)).filter(kw => kw.length > 0);

/**
 * Decide whether an inbound message is an opt-out/opt-in command.
 *
 * Matching is on the WHOLE trimmed message, not a substring: `"do not STOP asking"` and
 * `"I want to subscribe to the newsletter"` both contain a keyword and neither is a command. A
 * substring test here is how a suppression list ends up carrying people who never asked to leave —
 * and, worse, how an opt-out list grows from ordinary conversation.
 *
 * The comparison is uppercase and punctuation-insensitive so `stop`, `Stop!`, `STOP.` and
 * `stop now` all work, but still whole-message, so multi-word keywords work without substring risk.
 */
export function matchOptOut(
  body: string | null | undefined,
  optOutKeywords: readonly string[] = DEFAULT_OPT_OUT_KEYWORDS,
  optInKeywords: readonly string[] = DEFAULT_OPT_IN_KEYWORDS,
): OptOutMatch | null {
  if (!body) return null;
  // A command is short by nature; capping the scan keeps a pasted essay from being compared against
  // every keyword for nothing.
  if (body.length > 64) return null;
  const normalized = stripDecoration(body);
  if (!normalized) return null;

  for (const keyword of normalizeKeywords(optOutKeywords, DEFAULT_OPT_OUT_KEYWORDS)) {
    if (normalized === keyword) return { action: OptOutAction.OPT_OUT, keyword: keyword };
  }
  for (const keyword of normalizeKeywords(optInKeywords, DEFAULT_OPT_IN_KEYWORDS)) {
    if (normalized === keyword) return { action: OptOutAction.OPT_IN, keyword: keyword };
  }
  return null;
}
