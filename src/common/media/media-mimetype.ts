/**
 * MIME-type resolution for uploaded media, shared by the campaign and plan upload paths.
 *
 * Browsers report `application/octet-stream` (or nothing at all) for many file types, so an
 * uninformative value falls back to the file extension. Kept in `common/` so neither feature module
 * has to depend on the other for a pure lookup.
 */

const EXTENSION_MIMETYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  '3gp': 'video/3gpp',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
};

/**
 * A usable MIME type for an uploaded file. The reported type wins when it is informative; otherwise
 * the extension decides, with octet-stream as the last resort.
 */
export function resolveMimetype(filename: string, reported?: string | null): string {
  const value = (reported ?? '').trim().toLowerCase();
  if (value && value !== 'application/octet-stream') return value;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MIMETYPES[ext] ?? 'application/octet-stream';
}
