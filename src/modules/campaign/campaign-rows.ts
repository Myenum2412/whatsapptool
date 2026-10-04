import { isMediaUrl } from '../../common/media/media-url';
import { resolveMimetype } from '../../common/media/media-mimetype';
import { SpreadsheetRow } from './spreadsheet-parser';

// Re-exported so existing callers keep importing it from here; the implementation now lives in
// `common/media` so the plan module can share it without depending on campaigns.
export { resolveMimetype } from '../../common/media/media-mimetype';

/** Why a spreadsheet row was left out of a campaign before anything was sent. */
export enum CampaignSkipReason {
  INVALID_PHONE = 'INVALID_PHONE',
  DUPLICATE_PHONE = 'DUPLICATE_PHONE',
  MISSING_VALUE = 'MISSING_VALUE',
  /** The attachment cell names a file that has not been uploaded (yet). Cleared by uploading it. */
  MISSING_ATTACHMENT = 'MISSING_ATTACHMENT',
}

export interface PreparedRecipient {
  rowNumber: number;
  chatId: string | null;
  variables: Record<string, string>;
  /** Normalised filename the attachment cell names; null when empty or an http(s) link. */
  attachmentName: string | null;
  skipReason?: CampaignSkipReason;
  skipDetail?: string;
}

export interface PrepareOptions {
  phoneKey: string;
  placeholders: string[];
  mediaKey?: string | null;
  /** Normalised names of the files already uploaded for per-row matching. */
  uploadedNames?: ReadonlySet<string>;
  defaultCountryCode?: string | null;
  skipRowsWithMissingValues: boolean;
}

// Same digit bounds the session form and the gateway enforce for a phone number (E.164 caps at 15).
const MIN_PHONE_DIGITS = 6;
const MAX_PHONE_DIGITS = 15;
// A national number this long or shorter is assumed to lack its country code when a default is set.
const NATIONAL_NUMBER_MAX_DIGITS = 10;
const CHAT_ID_PATTERN = /^[0-9]{6,15}@c\.us$|^[0-9]+-?[0-9]*@g\.us$/;

/**
 * Normalise one phone cell to a chat id, or return null when it cannot be one.
 *
 * - A full chat id (`628123@c.us`, `1203…@g.us`) passes through unchanged.
 * - Formatting (spaces, dashes, dots, parentheses) is stripped. A leading `+` or `00` marks the number
 *   as international and it is used as written.
 * - Otherwise, when `defaultCountryCode` is set, a national trunk `0` is dropped and the code is
 *   prepended to numbers of at most 10 digits — longer numbers are taken to already carry one.
 */
export function normalizePhoneToChatId(raw: string, defaultCountryCode?: string | null): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.includes('@')) return CHAT_ID_PATTERN.test(value) ? value : null;
  // Letters mean this is not a phone number (a name in the wrong column, "N/A", an extension note).
  if (/[a-z]/i.test(value)) return null;

  const international = value.startsWith('+') || value.startsWith('00');
  let digits = value.replace(/[^0-9]/g, '');
  if (value.startsWith('00')) digits = digits.slice(2);

  const code = defaultCountryCode?.replace(/[^0-9]/g, '');
  if (!international && code) {
    const national = digits.replace(/^0+/, '');
    if (national.length <= NATIONAL_NUMBER_MAX_DIGITS) {
      // Too short to be anyone's number on its own: prefixing it would only disguise the typo.
      if (national.length < MIN_PHONE_DIGITS) return null;
      digits = code + national;
    }
  }

  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) return null;
  return `${digits}@c.us`;
}

/**
 * Validate every row up front and decide which will be sent. Nothing about a row is guessed: a bad
 * phone, a repeat of an earlier row's number, a blank value a placeholder needs, or an attachment
 * cell naming a file that has not been uploaded each skip the row with a reason the operator can
 * fix. An attachment cell holds either an http(s) link or the name of an uploaded file.
 */
export function prepareRecipients(rows: SpreadsheetRow[], options: PrepareOptions): PreparedRecipient[] {
  const seenChatIds = new Set<string>();
  return rows.map(row => {
    const variables = row.values;
    const cell = options.mediaKey ? (variables[options.mediaKey] ?? '').trim() : '';
    const attachmentName = cell && !isMediaUrl(cell) ? normalizeAttachmentName(cell) : null;
    const prepared: PreparedRecipient = { rowNumber: row.rowNumber, chatId: null, variables, attachmentName };

    const chatId = normalizePhoneToChatId(variables[options.phoneKey] ?? '', options.defaultCountryCode);
    if (!chatId) {
      return {
        ...prepared,
        skipReason: CampaignSkipReason.INVALID_PHONE,
        skipDetail: `"${variables[options.phoneKey] ?? ''}" is not a valid phone number`,
      };
    }
    prepared.chatId = chatId;

    if (seenChatIds.has(chatId)) {
      return {
        ...prepared,
        skipReason: CampaignSkipReason.DUPLICATE_PHONE,
        skipDetail: 'Same number as an earlier row',
      };
    }
    seenChatIds.add(chatId);

    if (options.skipRowsWithMissingValues) {
      const missing = options.placeholders.filter(key => !variables[key]);
      if (missing.length > 0) {
        return {
          ...prepared,
          skipReason: CampaignSkipReason.MISSING_VALUE,
          skipDetail: `Empty: ${missing.join(', ')}`,
        };
      }
    }

    if (attachmentName && !options.uploadedNames?.has(attachmentName)) {
      return {
        ...prepared,
        skipReason: CampaignSkipReason.MISSING_ATTACHMENT,
        skipDetail: missingAttachmentDetail(cell),
      };
    }
    return prepared;
  });
}

/** The skip detail for a row whose attachment cell names a file not uploaded. */
export function missingAttachmentDetail(cell: string): string {
  return `No uploaded file named "${cell}"`;
}

/**
 * The key a cell and an uploaded file are matched on: the last path segment, trimmed and
 * lower-cased, so `Invoices\\INV-1001.PDF` in a sheet matches an upload named `inv-1001.pdf`.
 */
export function normalizeAttachmentName(name: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? '';
  return base.trim().toLowerCase().slice(0, 255);
}

export type CampaignSendType = 'image' | 'video' | 'audio' | 'document';

// The formats WhatsApp plays inline. Anything else (HEIC, MKV, AVI…) still arrives, as a document.
const INLINE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const INLINE_VIDEO = new Set(['video/mp4', 'video/3gpp']);

/** How to send a file of this type: inline as a photo/video/audio when WhatsApp can play it, else as a document. */
export function sendTypeForMimetype(mimetype: string, asDocument = false): CampaignSendType {
  if (asDocument) return 'document';
  if (INLINE_IMAGE.has(mimetype)) return 'image';
  if (INLINE_VIDEO.has(mimetype)) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
}

/** How to send a per-row http(s) link: by its file extension. */
export function inferMediaType(url: string): CampaignSendType {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Validated as a URL before this runs; fall back to the raw string if not.
  }
  return sendTypeForMimetype(resolveMimetype(pathname));
}

/** The last path segment of a media URL, used as the document filename WhatsApp shows. */
export function filenameFromUrl(url: string): string | undefined {
  try {
    const segment = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return segment || undefined;
  } catch {
    return undefined;
  }
}
