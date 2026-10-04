import type { PollVoteEvent } from '../../../engine/interfaces/whatsapp-engine.interface';
import type { CampaignResponseStyle } from '../entities/campaign.entity';

/** WhatsApp caps a poll at 12 options; a numbered list has no such cap, but past 20 nobody reads it. */
export const RESPONSE_OPTION_LIMITS: Record<CampaignResponseStyle, { min: number; max: number }> = {
  poll: { min: 2, max: 12 },
  reply: { min: 2, max: 20 },
};
export const RESPONSE_OPTION_MAX_CHARS = 100;
/** WhatsApp's poll-question limit; the same bound keeps a numbered-list heading short. */
export const RESPONSE_QUESTION_MAX_CHARS = 255;

/**
 * The block appended to a `reply`-style message: the question, then the options numbered from 1.
 * Deliberately no fixed instruction text — the operator's question carries it ("Reply with the
 * number of your choice:") in the recipients' own language.
 */
export function replyOptionsBlock(question: string | null | undefined, options: string[]): string {
  const lines = options.map((option, i) => `${i + 1}. ${option}`);
  return [question?.trim(), ...lines].filter(Boolean).join('\n');
}

const EDGE_PUNCTUATION = /^[\s"'“”‘’`.,!?¿¡:;()[\]{}*_~#-]+|[\s"'“”‘’`.,!?¿¡:;()[\]{}*_~-]+$/gu;

/** Lower-case, trim edge punctuation, collapse whitespace, and read keycap emoji (1️⃣) as digits. */
export function normalizeAnswer(text: string): string {
  return text
    .replace(/([0-9])️?⃣/gu, '$1')
    .normalize('NFKC')
    .toLowerCase()
    .replace(EDGE_PUNCTUATION, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read a typed reply as a choice among `options`, or null when it is not one. Accepted: the option's
 * number (`2`, `#2`, `2.`, `2️⃣`), the option's text in any letter case, and — when several answers
 * are allowed — a list of numbers (`1, 3`, `1 and 3`). Anything else is ordinary conversation and is
 * left alone, so a recipient who writes "can you call me?" is never recorded as having answered.
 */
export function matchReply(body: string, options: string[], multiple: boolean): string[] | null {
  const answer = normalizeAnswer(body);
  if (!answer || options.length === 0) return null;

  const byNumber = (n: number): string | undefined => (n >= 1 && n <= options.length ? options[n - 1] : undefined);

  if (/^\d+$/.test(answer)) {
    const option = byNumber(Number(answer));
    return option ? [option] : null;
  }
  if (multiple && /^\d+(\s*(,|&|\/|and|\s)\s*\d+)+$/.test(answer)) {
    const picked = answer.match(/\d+/g)!.map(n => byNumber(Number(n)));
    if (picked.some(p => p === undefined)) return null;
    return [...new Set(picked as string[])];
  }
  const option = options.find(o => normalizeAnswer(o) === answer);
  return option ? [option] : null;
}

/**
 * Resolve a poll vote to the campaign's option texts. Names are authoritative when the engine
 * reports them; positions are the fallback (whatsapp-web.js loses names when the poll message has
 * left its page store, Baileys always has both). An empty result is a withdrawn vote.
 */
export function resolveVote(
  event: Pick<PollVoteEvent, 'selectedOptions' | 'selectedIndexes'>,
  options: string[],
): string[] {
  const byName = event.selectedOptions.filter(name => options.includes(name));
  if (byName.length > 0 && byName.length === event.selectedOptions.length) return byName;
  const byIndex = (event.selectedIndexes ?? []).map(i => options[i]).filter((o): o is string => o !== undefined);
  if (byIndex.length > 0) return [...new Set(byIndex)];
  return byName;
}

/**
 * Validate response options for a style. Returns the cleaned list (trimmed) or an error message.
 * Options must be distinct ignoring case, because a typed reply is matched case-insensitively and a
 * vote by name would otherwise be ambiguous.
 */
export function validateResponseOptions(style: CampaignResponseStyle, raw: string[]): string[] | string {
  const options = raw.map(o => o.trim());
  const { min, max } = RESPONSE_OPTION_LIMITS[style];
  if (options.length < min || options.length > max) {
    return `A ${style === 'poll' ? 'poll' : 'numbered reply'} needs ${min} to ${max} options; got ${options.length}`;
  }
  if (options.some(o => !o)) return 'Response options cannot be empty';
  const tooLong = options.find(o => o.length > RESPONSE_OPTION_MAX_CHARS);
  if (tooLong) return `Response option "${tooLong.slice(0, 30)}…" is over ${RESPONSE_OPTION_MAX_CHARS} characters`;
  const seen = new Set<string>();
  for (const o of options) {
    const key = normalizeAnswer(o);
    if (seen.has(key)) return `Response option "${o}" is listed twice`;
    seen.add(key);
  }
  if (style === 'reply' && options.some(o => /^\d+$/.test(normalizeAnswer(o)))) {
    return 'A numbered-reply option cannot be just a number, or "1" would be ambiguous';
  }
  return options;
}
