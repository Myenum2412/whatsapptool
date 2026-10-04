import {
  CampaignSkipReason,
  filenameFromUrl,
  inferMediaType,
  normalizePhoneToChatId,
  normalizeAttachmentName,
  prepareRecipients,
  resolveMimetype,
  sendTypeForMimetype,
} from './campaign-rows';

describe('normalizePhoneToChatId', () => {
  it.each([
    ['919876543210', undefined, '919876543210@c.us'],
    ['+91 98765-43210', undefined, '919876543210@c.us'],
    ['0091 98765 43210', undefined, '919876543210@c.us'],
    ['9876543210', '91', '919876543210@c.us'],
    ['09876543210', '+91', '919876543210@c.us'],
    // Already carries a country code (longer than a national number): left alone.
    ['919876543210', '91', '919876543210@c.us'],
    // International prefix wins over the default.
    ['+15550102233', '91', '15550102233@c.us'],
    ['628123456789@c.us', '91', '628123456789@c.us'],
    ['120363000000000000@g.us', undefined, '120363000000000000@g.us'],
  ])('%s (default %s) -> %s', (raw, code, expected) => {
    expect(normalizePhoneToChatId(raw, code)).toBe(expected);
  });

  it.each(['', 'N/A', '12345', '1234567890123456', 'someone@example.com', 'ext 1234567'])('rejects %p', raw => {
    expect(normalizePhoneToChatId(raw, '91')).toBeNull();
  });
});

describe('prepareRecipients', () => {
  const rows = [
    { rowNumber: 2, values: { Name: 'Asha', Phone: '9876543210', Url: '' } },
    { rowNumber: 3, values: { Name: 'Ravi', Phone: 'unknown', Url: '' } },
    { rowNumber: 4, values: { Name: 'Asha again', Phone: '+91 98765 43210', Url: '' } },
    { rowNumber: 5, values: { Name: '', Phone: '9123456780', Url: '' } },
    { rowNumber: 6, values: { Name: 'Meera', Phone: '9000000001', Url: 'Invoices\\INV-7.PDF' } },
    { rowNumber: 7, values: { Name: 'Kiran', Phone: '9000000002', Url: 'https://cdn.example.com/k.pdf' } },
    { rowNumber: 8, values: { Name: 'Devi', Phone: '9000000003', Url: 'inv-8.pdf' } },
  ];

  it('skips each bad row with its reason and keeps the rest', () => {
    const prepared = prepareRecipients(rows, {
      phoneKey: 'Phone',
      placeholders: ['Name'],
      mediaKey: 'Url',
      uploadedNames: new Set(['inv-8.pdf']),
      defaultCountryCode: '91',
      skipRowsWithMissingValues: true,
    });
    expect(prepared.map(p => [p.rowNumber, p.chatId, p.skipReason, p.attachmentName])).toEqual([
      [2, '919876543210@c.us', undefined, null],
      [3, null, CampaignSkipReason.INVALID_PHONE, null],
      [4, '919876543210@c.us', CampaignSkipReason.DUPLICATE_PHONE, null],
      [5, '919123456780@c.us', CampaignSkipReason.MISSING_VALUE, null],
      // Names a file not uploaded yet: skipped, but remembers which file releases it.
      [6, '919000000001@c.us', CampaignSkipReason.MISSING_ATTACHMENT, 'inv-7.pdf'],
      // A link is sent as-is, not matched against uploads.
      [7, '919000000002@c.us', undefined, null],
      [8, '919000000003@c.us', undefined, 'inv-8.pdf'],
    ]);
    expect(prepared[4].skipDetail).toBe('No uploaded file named "Invoices\\INV-7.PDF"');
  });

  it('keeps a row with an empty value when skipping is turned off', () => {
    const [, , , row5] = prepareRecipients(rows, {
      phoneKey: 'Phone',
      placeholders: ['Name'],
      defaultCountryCode: '91',
      skipRowsWithMissingValues: false,
    });
    expect(row5.skipReason).toBeUndefined();
  });
});

describe('media helpers', () => {
  it('infers the send type from the URL path, ignoring the query string', () => {
    expect(inferMediaType('https://x.io/a/photo.JPG?sig=1')).toBe('image');
    expect(inferMediaType('https://x.io/clip.mp4')).toBe('video');
    expect(inferMediaType('https://x.io/voice.mp3')).toBe('audio');
    expect(inferMediaType('https://x.io/invoice.pdf')).toBe('document');
    expect(inferMediaType('https://x.io/download?id=7')).toBe('document');
  });

  it('matches a sheet cell to an upload on the bare, lower-cased filename', () => {
    expect(normalizeAttachmentName('  C:\\Invoices\\INV-1001.PDF ')).toBe('inv-1001.pdf');
    expect(normalizeAttachmentName('folder/Brochure 2026.pdf')).toBe('brochure 2026.pdf');
  });

  it('falls back to the extension when the browser reports no useful MIME type', () => {
    expect(resolveMimetype('scan.pdf', 'application/octet-stream')).toBe('application/pdf');
    expect(resolveMimetype('photo.HEIC', '')).toBe('application/octet-stream');
    expect(resolveMimetype('clip.mp4', 'video/mp4')).toBe('video/mp4');
  });

  it('sends only formats WhatsApp plays inline as media; everything else, or everything on request, as a document', () => {
    expect(sendTypeForMimetype('image/png')).toBe('image');
    expect(sendTypeForMimetype('image/heic')).toBe('document');
    expect(sendTypeForMimetype('video/mp4')).toBe('video');
    expect(sendTypeForMimetype('video/quicktime')).toBe('document');
    expect(sendTypeForMimetype('audio/mpeg')).toBe('audio');
    expect(sendTypeForMimetype('application/pdf')).toBe('document');
    expect(sendTypeForMimetype('image/png', true)).toBe('document');
  });

  it('takes the document filename from the last path segment', () => {
    expect(filenameFromUrl('https://x.io/inv/Invoice%201001.pdf?t=1')).toBe('Invoice 1001.pdf');
    expect(filenameFromUrl('https://x.io/')).toBeUndefined();
  });
});
