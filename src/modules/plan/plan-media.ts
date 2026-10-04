import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { resolveMimetype } from '../../common/media/media-mimetype';

/**
 * Plan media: files an operator uploads into a plan's flow (images, videos, documents).
 *
 * Stored under a per-plan prefix — `plan-media/<sessionId>/<planId>/<uuid>.<ext>` — so a plan's
 * uploads can be swept in one pass when the plan is deleted, without touching another plan's files
 * or the campaign store. The block keeps the API-relative URL, not the storage key, so the dashboard
 * can fetch it back through the same authenticated endpoint it uploaded to.
 */

export const PLAN_MEDIA_PREFIX = 'plan-media/';

export interface UploadedPlanMedia {
  buffer?: Buffer;
  originalname?: string;
  mimetype?: string;
}

/** What an upload hands back to the dashboard to drop into a block. */
export interface PlanMediaUploadResult {
  url: string;
  filename: string;
  mimetype: string;
  sizeBytes: number;
}

export interface StoredPlanMedia {
  buffer: Buffer;
  mimetype: string;
  filename: string;
}

/**
 * Mimetypes a flow-media file may be served as. Everything else — documents, and notably
 * `image/svg+xml`, which is scriptable despite the `image/` prefix — is served as inert
 * octet-stream so the media endpoint cannot host active content on the API origin.
 */
const INERT_MEDIA_MIMETYPE =
  /^(image\/(jpeg|png|gif|webp|bmp)|video\/(mp4|webm|quicktime|3gpp)|audio\/(mpeg|mp4|ogg|aac|wav|webm))(;|$)/;

/** The declared mimetype when it is safe to echo back, else inert octet-stream. */
export function inertPlanMimetype(mimetype: string): string {
  return INERT_MEDIA_MIMETYPE.test(mimetype) ? mimetype : 'application/octet-stream';
}

/** A stored media id: one path segment, no separators or traversal. */
const PLAN_MEDIA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isPlanMediaId(mediaId: string): boolean {
  return PLAN_MEDIA_ID.test(mediaId);
}

/**
 * Multer mis-decodes UTF-8 filenames as latin1; recover the original when that is what happened.
 * Mirrors the campaign upload path. Control characters are dropped, and only the last path segment
 * is kept, so a client-supplied `../../etc/passwd` cannot escape the store.
 */
export function decodePlanMediaFilename(name: string | undefined): string {
  const raw = [...(name ?? '')]
    .filter(ch => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim();
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  const best = /[\u0080-\u00ff]/.test(raw) && !decoded.includes('\uFFFD') ? decoded : raw;
  return (best.split(/[\\/]/).pop() ?? '').slice(0, 255);
}

/** A collision-free stored name that keeps the extension so the MIME can be inferred on read. */
export function planMediaStoredName(filename: string): string {
  const ext = /\.([a-z0-9]{1,10})$/i.exec(filename)?.[1]?.toLowerCase();
  return `${randomUUID()}${ext ? `.${ext}` : ''}`;
}

export function planMediaKey(sessionId: string, planId: string, storedName: string): string {
  return `${PLAN_MEDIA_PREFIX}${sessionId}/${planId}/${storedName}`;
}

/** The API-relative URL a block stores, resolved against `/api` by the dashboard's request layer. */
export function planMediaUrl(sessionId: string, planId: string, storedName: string): string {
  return `/sessions/${sessionId}/plans/${planId}/media/${storedName}`;
}

/** Resolve the MIME of a stored file from its (uuid + extension) name. */
export function storedMediaMimetype(storedName: string): string {
  return inertPlanMimetype(resolveMimetype(storedName));
}

/** Guard a route param before it is turned into a storage key. */
export function assertPlanMediaId(mediaId: string): void {
  if (!isPlanMediaId(mediaId)) {
    throw new BadRequestException('The media id is not a valid stored file name');
  }
}
