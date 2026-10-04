// A campaign is the highest-volume send path an operator can trigger with one upload, so the
// contract is about what it will NOT do: never send a skipped row, never burn the rest of the list as
// failures when pacing or the session says "not now", never re-send a row whose fate is unknown after
// a restart, and never let a spreadsheet cell become a formula in the exported report. These run the
// real send loop against an in-memory DB with only the WhatsApp side stubbed.
import { DataSource } from 'typeorm';
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { CampaignService, csvCell, renderCampaignText } from './campaign.service';
import { Campaign, CampaignPauseReason, CampaignStatus } from './entities/campaign.entity';
import { CampaignRecipient, CampaignRecipientStatus } from './entities/campaign-recipient.entity';
import { CampaignAttachment } from './entities/campaign-attachment.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import type { StorageService } from '../../common/storage/storage.service';
import { CampaignResponseService } from './responses/campaign-response.service';
import type { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { SEND_PACING_LIMITED } from '../message/send-pacing.service';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import type { MessageService } from '../message/message.service';
import type { TemplateService } from '../template/template.service';
import type { EngineRegistry } from '../../engine/engine-registry.service';
import type { SessionOwnershipService } from '../session/session-ownership.service';

type Sent = {
  kind: string;
  chatId: string;
  text?: string;
  caption?: string;
  url?: string;
  filename?: string;
  base64?: string;
  mimetype?: string;
  name?: string;
  options?: string[];
  allowMultipleAnswers?: boolean;
};

describe('CampaignService', () => {
  let ds: DataSource;
  let service: CampaignService;
  let sent: Sent[];
  let engineUp: boolean;
  let failNext: ((dto: { chatId: string }) => unknown) | null;
  let beforeSend: (() => Promise<void>) | null;
  let templates: Record<string, { id: string; header: string | null; body: string; footer: string | null }>;
  let files: Map<string, Buffer>;
  let responses: CampaignResponseService;
  let storageReads: number;

  const storage = {
    putFile: (key: string, data: Buffer) => {
      files.set(key, data);
      return Promise.resolve();
    },
    getFile: (key: string) => {
      storageReads++;
      const data = files.get(key);
      return data ? Promise.resolve(data) : Promise.reject(new Error(`no file ${key}`));
    },
    deleteFile: (key: string) => {
      files.delete(key);
      return Promise.resolve();
    },
    async *iterateFiles(prefix = '') {
      for (const key of [...files.keys()]) if (key.startsWith(prefix)) yield await Promise.resolve(key);
    },
  } as unknown as StorageService;

  const send =
    (kind: string) =>
    async (_sessionId: string, dto: Omit<Sent, 'kind'>): Promise<{ messageId: string }> => {
      await beforeSend?.();
      const failure = failNext?.(dto);
      if (failure) throw failure instanceof Error ? failure : new Error('send failed');
      sent.push({ kind, ...dto });
      const messageId = `wamid.${sent.length}`;
      // Like the real send path: a base64 send persists its whole payload in the message row.
      if (dto.base64) {
        const messages = ds.getRepository(Message);
        await messages.save(
          messages.create({
            sessionId: 'sessA',
            waMessageId: messageId,
            chatId: dto.chatId,
            from: 'me',
            to: dto.chatId,
            type: kind,
            direction: MessageDirection.OUTGOING,
            status: MessageStatus.SENT,
            metadata: { media: { data: dto.base64, mimetype: dto.mimetype, filename: dto.filename } },
          }),
        );
      }
      return { messageId };
    };

  const build = (ownership?: SessionOwnershipService): CampaignService =>
    new CampaignService(
      ds.getRepository(Campaign),
      ds.getRepository(CampaignRecipient),
      ds.getRepository(Session),
      ds.getRepository(CampaignAttachment),
      ds.getRepository(Message),
      storage,
      {
        findOne: (_s: string, id: string) =>
          templates[id] ? Promise.resolve(templates[id]) : Promise.reject(new Error('Template not found')),
      } as unknown as TemplateService,
      {
        sendText: send('text'),
        sendImage: send('image'),
        sendVideo: send('video'),
        sendDocument: send('document'),
        sendAudio: send('audio'),
        sendPoll: send('poll'),
      } as unknown as MessageService,
      { get: () => (engineUp ? {} : undefined) } as unknown as EngineRegistry,
      ownership,
      undefined,
      responses,
    );

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Campaign, CampaignRecipient, CampaignAttachment, Message],
      synchronize: true,
    });
    await ds.initialize();
    const sessions = ds.getRepository(Session);
    await sessions.save(sessions.create({ id: 'sessA', name: 'sessA', status: SessionStatus.READY, config: {} }));
    sent = [];
    engineUp = true;
    failNext = null;
    beforeSend = null;
    files = new Map();
    storageReads = 0;
    responses = new CampaignResponseService(ds.getRepository(Campaign), ds.getRepository(CampaignRecipient));
    templates = {
      tpl1: { id: 'tpl1', header: 'Acme', body: 'Hi {{Name}}, you owe {{Amount}}.', footer: 'Reply STOP to opt out' },
    };
    service = build();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const csv = (text: string) => ({ buffer: Buffer.from(text), originalname: 'list.csv' });

  /** Create a campaign and make its loop run without real delays. */
  const createFast = async (sheet: string, over: Record<string, unknown> = {}) => {
    const detail = await service.create(
      'sessA',
      { name: 'Test', templateId: 'tpl1', phoneColumn: 'Phone', defaultCountryCode: '91', ...over },
      csv(sheet),
    );
    await ds.getRepository(Campaign).update({ id: detail.id }, { delayMs: 0, randomizeDelay: false });
    return detail;
  };

  const rows = async (id: string) =>
    (await ds.getRepository(CampaignRecipient).find({ where: { campaignId: id }, order: { rowNumber: 'ASC' } })).map(
      r => [r.rowNumber, r.status, r.errorCode],
    );

  describe('create', () => {
    it('validates every row up front and previews the rendered text', async () => {
      const detail = await createFast(
        'Name,Phone,Amount\nAsha,9876543210,100\nRavi,bad,50\nAsha2,+91 98765 43210,10\n,9000000001,5\n',
      );
      expect(detail.status).toBe(CampaignStatus.DRAFT);
      expect(detail.progress).toEqual({ total: 4, pending: 1, sent: 0, failed: 0, skipped: 3 });
      expect(detail.skippedByReason).toEqual({ INVALID_PHONE: 1, DUPLICATE_PHONE: 1, MISSING_VALUE: 1 });
      expect(detail.preview).toEqual([
        {
          attachments: [],
          rowNumber: 2,
          chatId: '919876543210@c.us',
          text: 'Acme\n\nHi Asha, you owe 100.\n\nReply STOP to opt out',
        },
      ]);
      expect(sent).toEqual([]);
    });

    it('refuses a placeholder that names no column, listing the ones that exist', async () => {
      await expect(
        service.create(
          'sessA',
          { name: 'T', body: 'Hi {{Nmae}}', phoneColumn: 'Phone' },
          csv('Name,Phone\nA,9876543210'),
        ),
      ).rejects.toThrow(/\{\{Nmae\}\}.*Available: \{\{Name\}\}, \{\{Phone\}\}/);
    });

    it('accepts a column by header text and stores its key', async () => {
      const detail = await service.create(
        'sessA',
        { name: 'T', body: 'Hi {{First_Name}}', phoneColumn: 'mobile number' },
        csv('First Name,Mobile Number\nA,919876543210'),
      );
      expect(detail.phoneColumn).toBe('Mobile_Number');
      await expect(
        service.create('sessA', { name: 'T', body: 'x', phoneColumn: 'Nope' }, csv('A,B\n1,2')),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('send loop', () => {
    it('sends pending rows in sheet order, skips the rest, and completes', async () => {
      const { id } = await createFast('Name,Phone,Amount\nAsha,9876543210,1\nBad,x,2\nRavi,9123456780,3\n');
      await service.start('sessA', id);
      await service.run(id);

      expect(sent.map(s => [s.kind, s.chatId, s.text])).toEqual([
        ['text', '919876543210@c.us', 'Acme\n\nHi Asha, you owe 1.\n\nReply STOP to opt out'],
        ['text', '919123456780@c.us', 'Acme\n\nHi Ravi, you owe 3.\n\nReply STOP to opt out'],
      ]);
      const campaign = await service.findOne('sessA', id);
      expect(campaign.status).toBe(CampaignStatus.COMPLETED);
      expect(campaign.progress).toEqual({ total: 3, pending: 0, sent: 2, failed: 0, skipped: 1 });
      expect(await rows(id)).toEqual([
        [2, 'sent', null],
        [3, 'skipped', 'INVALID_PHONE'],
        [4, 'sent', null],
      ]);
    });

    it('fails one row on an ordinary send error and carries on', async () => {
      const { id } = await createFast('Name,Phone,Amount\nA,9000000001,1\nB,9000000002,2\n');
      failNext = dto => (dto.chatId === '919000000001@c.us' ? new BadRequestException('not on WhatsApp') : null);
      await service.start('sessA', id);
      await service.run(id);
      expect(await rows(id)).toEqual([
        [2, 'failed', 'SEND_FAILED'],
        [3, 'sent', null],
      ]);
      expect((await service.findOne('sessA', id)).status).toBe(CampaignStatus.COMPLETED);
    });

    it('pauses on a pacing refusal without failing the row, then resumes where it stopped', async () => {
      const { id } = await createFast('Name,Phone,Amount\nA,9000000001,1\nB,9000000002,2\nC,9000000003,3\n');
      failNext = dto =>
        dto.chatId === '919000000002@c.us'
          ? new HttpException({ code: SEND_PACING_LIMITED, message: 'daily cap' }, HttpStatus.TOO_MANY_REQUESTS)
          : null;
      await service.start('sessA', id);
      await service.run(id);

      let campaign = await service.findOne('sessA', id);
      expect(campaign.status).toBe(CampaignStatus.PAUSED);
      expect(campaign.pauseReason).toBe(CampaignPauseReason.PACING_LIMITED);
      expect(await rows(id)).toEqual([
        [2, 'sent', null],
        [3, 'pending', null],
        [4, 'pending', null],
      ]);

      failNext = null;
      await service.start('sessA', id);
      await service.run(id);
      campaign = await service.findOne('sessA', id);
      expect(campaign.status).toBe(CampaignStatus.COMPLETED);
      expect(sent.map(s => s.chatId)).toEqual(['919000000001@c.us', '919000000002@c.us', '919000000003@c.us']);
    });

    it('pauses when the session drops, and will not start without one', async () => {
      const { id } = await createFast('Name,Phone,Amount\nA,9000000001,1\nB,9000000002,2\n');
      engineUp = false;
      await expect(service.start('sessA', id)).rejects.toThrow(EngineNotReadyError);

      engineUp = true;
      failNext = () => {
        engineUp = false;
        return new EngineNotReadyError();
      };
      await service.start('sessA', id);
      await service.run(id);
      const campaign = await service.findOne('sessA', id);
      expect(campaign.pauseReason).toBe(CampaignPauseReason.SESSION_NOT_READY);
      expect(await rows(id)).toEqual([
        [2, 'pending', null],
        [3, 'pending', null],
      ]);
    });

    it('stops at the next row once paused or cancelled', async () => {
      const { id } = await createFast('Name,Phone,Amount\nA,9000000001,1\nB,9000000002,2\n');
      await service.start('sessA', id);
      beforeSend = async () => {
        beforeSend = null;
        await service.cancel('sessA', id);
      };
      await service.run(id);
      expect(sent).toHaveLength(1);
      expect((await service.findOne('sessA', id)).status).toBe(CampaignStatus.CANCELLED);
      await expect(service.start('sessA', id)).rejects.toThrow(/cancelled/);
    });

    it('sends a per-row link with the text as caption, or text first when too long for a caption', async () => {
      templates.long = { id: 'long', header: null, body: '{{Note}}', footer: null };
      const longNote = 'n'.repeat(1100);
      const { id } = await createFast(
        `Name,Phone,Amount,Url,Note\n` +
          `A,9000000001,1,https://cdn.example.com/a.jpg,short\n` +
          `B,9000000002,2,https://cdn.example.com/inv/B%201.pdf,${longNote}\n` +
          `C,9000000003,3,,plain\n`,
        { templateId: 'long', mediaColumn: 'Url' },
      );
      await service.start('sessA', id);
      await service.run(id);
      expect(sent.map(s => [s.kind, s.chatId, s.caption ?? s.text?.slice(0, 5), s.filename])).toEqual([
        ['image', '919000000001@c.us', 'short', 'a.jpg'],
        ['text', '919000000002@c.us', 'nnnnn', undefined],
        ['document', '919000000002@c.us', undefined, 'B 1.pdf'],
        ['text', '919000000003@c.us', 'plain', undefined],
      ]);
    });
  });

  describe('uploaded attachments', () => {
    const file = (name: string, mimetype: string, body = name) => ({
      buffer: Buffer.from(body),
      originalname: name,
      mimetype,
    });

    it('holds rows naming a file until it is uploaded, then sends the shared file plus each row’s own', async () => {
      const detail = await createFast(
        'Name,Phone,Amount,Invoice\nAsha,9000000001,10,INV-1.pdf\nRavi,9000000002,20,inv-2.PDF\nMeera,9000000003,30,\n',
        { mediaColumn: 'Invoice' },
      );
      expect(detail.skippedByReason).toEqual({ MISSING_ATTACHMENT: 2 });
      expect(detail.missingAttachments).toEqual(['INV-1.pdf', 'inv-2.PDF']);

      await service.addAttachment('sessA', detail.id, 'all', file('Brochure.pdf', 'application/pdf'));
      expect(
        (await service.addAttachment('sessA', detail.id, 'row', file('inv-1.pdf', 'application/octet-stream')))
          .rowsMatched,
      ).toBe(1);
      expect(
        (await service.addAttachment('sessA', detail.id, 'row', file('INV-2.pdf', 'application/pdf'))).rowsMatched,
      ).toBe(1);

      const ready = await service.getDetail('sessA', detail.id);
      expect(ready.progress).toMatchObject({ pending: 3, skipped: 0 });
      expect(ready.missingAttachments).toEqual([]);
      expect(ready.preview.map(p => p.attachments)).toEqual([
        ['Brochure.pdf', 'inv-1.pdf'],
        ['Brochure.pdf', 'INV-2.pdf'],
        ['Brochure.pdf'],
      ]);

      await service.start('sessA', detail.id);
      await service.run(detail.id);

      expect(sent.map(s => [s.chatId.slice(0, 12), s.kind, s.filename, s.caption?.slice(0, 8), s.mimetype])).toEqual([
        ['919000000001', 'document', 'Brochure.pdf', 'Acme\n\nHi', 'application/pdf'],
        ['919000000001', 'document', 'inv-1.pdf', undefined, 'application/pdf'],
        ['919000000002', 'document', 'Brochure.pdf', 'Acme\n\nHi', 'application/pdf'],
        ['919000000002', 'document', 'INV-2.pdf', undefined, 'application/pdf'],
        ['919000000003', 'document', 'Brochure.pdf', 'Acme\n\nHi', 'application/pdf'],
      ]);
      expect(Buffer.from(sent[1].base64 ?? '', 'base64').toString()).toBe('inv-1.pdf');
      // The file for everyone is read from storage once, not once per recipient.
      expect(storageReads).toBe(3);
      expect((await service.findOne('sessA', detail.id)).status).toBe(CampaignStatus.COMPLETED);

      // No sent message keeps a copy of the file in its row.
      const rows = await ds.getRepository(Message).find();
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.metadata.media).toMatchObject({ omitted: true });
        expect((row.metadata.media as { data?: string }).data).toBeUndefined();
      }
    });

    it('sends photos and videos inline, audio without the caption, and everything as a document on request', async () => {
      const { id } = await createFast('Name,Phone,Amount\nA,9000000001,1\n');
      await service.addAttachment('sessA', id, 'all', file('voice.mp3', 'audio/mpeg'));
      await service.addAttachment('sessA', id, 'all', file('photo.jpg', 'image/jpeg'));
      await service.addAttachment('sessA', id, 'all', file('clip.mp4', 'video/mp4'));
      await service.start('sessA', id);
      await service.run(id);
      // Audio cannot carry a caption, so the text rides on the first file that can.
      expect(sent.map(s => [s.kind, s.filename, !!s.caption])).toEqual([
        ['audio', 'voice.mp3', false],
        ['image', 'photo.jpg', true],
        ['video', 'clip.mp4', false],
      ]);

      sent = [];
      const second = await createFast('Name,Phone,Amount\nA,9000000001,1\n', { mediaType: 'document' });
      await service.addAttachment('sessA', second.id, 'all', file('photo.jpg', 'image/jpeg'));
      await service.start('sessA', second.id);
      await service.run(second.id);
      expect(sent.map(s => s.kind)).toEqual(['document']);
    });

    it('fails a row that broke after part of it was sent, rather than re-sending that part', async () => {
      const { id } = await createFast('Name,Phone,Amount\nA,9000000001,1\nB,9000000002,2\n');
      await service.addAttachment('sessA', id, 'all', file('one.pdf', 'application/pdf'));
      await service.addAttachment('sessA', id, 'all', file('two.pdf', 'application/pdf'));
      failNext = dto =>
        dto.chatId === '919000000001@c.us' && sent.some(s => s.chatId === dto.chatId)
          ? new BadRequestException('upload rejected')
          : null;
      await service.start('sessA', id);
      await service.run(id);
      const [a, b] = (
        await ds.getRepository(CampaignRecipient).find({ where: { campaignId: id }, order: { rowNumber: 'ASC' } })
      ).map(r => [r.status, r.errorCode, r.errorMessage]);
      expect(a).toEqual(['failed', 'PARTIAL_SEND', 'Sent 1 of 2 messages before failing: upload rejected']);
      expect(b).toEqual(['sent', null, null]);
    });

    it('only changes attachments on a draft, refuses duplicate names, and un-matches rows when a file is removed', async () => {
      const { id } = await createFast('Name,Phone,Amount,Invoice\nA,9000000001,1,x.pdf\n', { mediaColumn: 'Invoice' });
      const { attachment } = await service.addAttachment('sessA', id, 'row', file('x.pdf', 'application/pdf'));
      await expect(service.addAttachment('sessA', id, 'all', file('X.PDF', 'application/pdf'))).rejects.toThrow(
        /already attached/,
      );
      expect((await service.getDetail('sessA', id)).progress.pending).toBe(1);

      await service.removeAttachment('sessA', id, attachment.id);
      const detail = await service.getDetail('sessA', id);
      expect(detail.skippedByReason).toEqual({ MISSING_ATTACHMENT: 1 });
      expect(files.size).toBe(0);

      await service.addAttachment('sessA', id, 'row', file('x.pdf', 'application/pdf'));
      await ds.getRepository(Campaign).update({ id }, { status: CampaignStatus.PAUSED });
      await expect(service.addAttachment('sessA', id, 'all', file('y.pdf', 'application/pdf'))).rejects.toThrow(
        /only be changed while the campaign is a draft/,
      );
    });

    it('refuses a per-row file on a campaign without an attachment column', async () => {
      const { id } = await createFast('Name,Phone,Amount\nA,9000000001,1\n');
      await expect(service.addAttachment('sessA', id, 'row', file('x.pdf', 'application/pdf'))).rejects.toThrow(
        /no attachment column/,
      );
    });

    it('deletes stored files with the campaign, and sweeps files whose campaign vanished with its session', async () => {
      const { id } = await createFast('Name,Phone,Amount\nA,9000000001,1\n');
      await service.addAttachment('sessA', id, 'all', file('a.pdf', 'application/pdf'));
      await service.delete('sessA', id);
      expect(files.size).toBe(0);

      const kept = await createFast('Name,Phone,Amount\nA,9000000001,1\n');
      await service.addAttachment('sessA', kept.id, 'all', file('b.pdf', 'application/pdf'));
      files.set('campaign-media/gone-campaign/1.pdf', Buffer.from('x'));
      expect(await service.sweepOrphanedAttachments()).toBe(1);
      expect([...files.keys()].every(k => k.startsWith(`campaign-media/${kept.id}/`))).toBe(true);
    });
  });

  describe('response options', () => {
    const inbound = (chatId: string, body: string): IncomingMessage =>
      ({
        id: `in-${Math.random()}`,
        from: chatId,
        chatId,
        body,
        type: 'text',
        timestamp: Math.floor(Date.now() / 1000),
        fromMe: false,
        isGroup: false,
      }) as IncomingMessage;

    it('sends a personalised poll after the message and records taps, typed answers and withdrawals', async () => {
      const { id } = await createFast('Name,Phone,Amount\nAsha,9000000001,1\nRavi,9000000002,2\nMeera,9000000003,3\n', {
        responseOptions: ['Interested', 'Not interested'],
        responseQuestion: 'Interested, {{Name}}?',
      });
      expect((await service.getDetail('sessA', id)).preview[1].poll).toEqual({
        question: 'Interested, Ravi?',
        options: ['Interested', 'Not interested'],
      });
      await service.start('sessA', id);
      await service.run(id);

      expect(
        sent.filter(s => s.chatId === '919000000001@c.us').map(s => [s.kind, s.name ?? null, s.options ?? null]),
      ).toEqual([
        ['text', null, null],
        ['poll', 'Interested, Asha?', ['Interested', 'Not interested']],
      ]);
      const pollIds = (
        await ds.getRepository(CampaignRecipient).find({ where: { campaignId: id }, order: { rowNumber: 'ASC' } })
      ).map(r => r.responseMessageId);
      expect(pollIds).toEqual(['wamid.2', 'wamid.4', 'wamid.6']);

      // Asha taps "Interested"; Ravi types "2"; Meera says something unrelated.
      expect(
        await responses.recordPollVote('sessA', {
          pollMessageId: 'wamid.2',
          chatId: '919000000001@c.us',
          voterId: '919000000001@c.us',
          selectedOptions: ['Interested'],
          selectedIndexes: [0],
          timestamp: 1_800_000_000,
        }),
      ).toBe(true);
      expect(await responses.recordReply('sessA', inbound('919000000002@c.us', ' 2 '))).toBe(true);
      expect(await responses.recordReply('sessA', inbound('919000000003@c.us', 'call me tomorrow'))).toBe(false);
      // The account voting on its own poll from the phone is not the recipient's answer.
      expect(
        await responses.recordPollVote('sessA', {
          pollMessageId: 'wamid.6',
          chatId: '919000000003@c.us',
          voterId: '919999999999@c.us',
          selectedOptions: ['Interested'],
          timestamp: 1_800_000_000,
        }),
      ).toBe(false);

      let detail = await service.getDetail('sessA', id);
      expect(detail.responseSummary).toEqual({
        options: [
          { option: 'Interested', count: 1 },
          { option: 'Not interested', count: 1 },
        ],
        responded: 2,
        awaiting: 1,
      });

      const interested = await service.listRecipients('sessA', id, { response: 'Interested' });
      expect(interested.items.map(r => [r.rowNumber, r.response, r.responseVia])).toEqual([
        [2, ['Interested'], 'poll'],
      ]);
      const notInterested = await service.listRecipients('sessA', id, { response: 'Not interested' });
      expect(notInterested.items.map(r => r.rowNumber)).toEqual([3]);
      expect((await service.listRecipients('sessA', id, { responded: 'no' })).items.map(r => r.rowNumber)).toEqual([4]);

      // Asha withdraws her vote: her answer clears.
      await responses.recordPollVote('sessA', {
        pollMessageId: 'wamid.2',
        chatId: '919000000001@c.us',
        voterId: '919000000001@c.us',
        selectedOptions: [],
        timestamp: 1_800_000_100,
      });
      detail = await service.getDetail('sessA', id);
      expect(detail.responseSummary?.responded).toBe(1);

      const report = (await service.exportResults('sessA', id)).csv
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n');
      expect(report[0]).toMatch(/,Response,Responded At,Responded Via$/);
      expect(report[2]).toMatch(/,Not interested,[^,]+,reply$/);
    });

    it('lists numbered options under the message for reply style, and takes the number or the text', async () => {
      const { id } = await createFast('Name,Phone,Amount\nAsha,9000000001,1\n', {
        responseStyle: 'reply',
        responseOptions: ['Yes', 'No', 'Maybe'],
        responseQuestion: 'Reply with a number, {{Name}}:',
        responseMultiple: true,
      });
      const detail = await service.getDetail('sessA', id);
      expect(detail.preview[0].text.endsWith('Reply with a number, Asha:\n1. Yes\n2. No\n3. Maybe')).toBe(true);

      await service.start('sessA', id);
      await service.run(id);
      expect(sent.map(s => s.kind)).toEqual(['text']);
      const [row] = await ds.getRepository(CampaignRecipient).find({ where: { campaignId: id } });
      expect(row.responseMessageId).toBe('wamid.1');

      expect(await responses.recordReply('sessA', inbound('919000000001@c.us', '1 and 3'))).toBe(true);
      expect((await ds.getRepository(CampaignRecipient).findOneBy({ id: row.id }))?.response).toEqual(['Yes', 'Maybe']);
      // The latest answer wins.
      expect(await responses.recordReply('sessA', inbound('919000000001@c.us', 'no'))).toBe(true);
      expect((await ds.getRepository(CampaignRecipient).findOneBy({ id: row.id }))?.response).toEqual(['No']);
    });

    it('refuses invalid options and a poll without a question', async () => {
      await expect(
        createFast('Name,Phone,Amount\nA,9000000001,1\n', { responseOptions: ['Only'], responseQuestion: 'Q?' }),
      ).rejects.toThrow(/2 to 12 options/);
      await expect(
        createFast('Name,Phone,Amount\nA,9000000001,1\n', { responseOptions: ['Yes', 'No'] }),
      ).rejects.toThrow(/A poll needs a question/);
      await expect(
        createFast('Name,Phone,Amount\nA,9000000001,1\n', {
          responseOptions: ['Yes', 'No'],
          responseQuestion: '{{Nope}}?',
        }),
      ).rejects.toThrow(/\{\{Nope\}\}/);
    });

    it('fails a row whose poll could not be sent after its message went out, without re-sending the message', async () => {
      const { id } = await createFast('Name,Phone,Amount\nA,9000000001,1\n', {
        responseOptions: ['Yes', 'No'],
        responseQuestion: 'OK?',
      });
      failNext = () => (sent.length === 1 ? new BadRequestException('poll refused') : null);
      await service.start('sessA', id);
      await service.run(id);
      expect(await rows(id)).toEqual([[2, 'failed', 'PARTIAL_SEND']]);
    });
  });

  describe('restart recovery', () => {
    it('pauses a running campaign and fails the row whose send was in flight, never re-sending it', async () => {
      const { id } = await createFast('Name,Phone,Amount\nA,9000000001,1\nB,9000000002,2\n');
      await ds.getRepository(Campaign).update({ id }, { status: CampaignStatus.RUNNING });
      await ds
        .getRepository(CampaignRecipient)
        .update({ campaignId: id, rowNumber: 2 }, { status: CampaignRecipientStatus.SENDING });

      await build().onApplicationBootstrap();

      const campaign = await service.findOne('sessA', id);
      expect(campaign.status).toBe(CampaignStatus.PAUSED);
      expect(campaign.pauseReason).toBe(CampaignPauseReason.INTERRUPTED);
      expect(await rows(id)).toEqual([
        [2, 'failed', 'INTERRUPTED'],
        [3, 'pending', null],
      ]);
    });

    it('leaves a campaign alone when another node holds its session', async () => {
      const { id } = await createFast('Name,Phone,Amount\nA,9000000001,1\n');
      await ds.getRepository(Campaign).update({ id }, { status: CampaignStatus.RUNNING });
      await build({
        claimable: () => Promise.resolve([]),
      } as unknown as SessionOwnershipService).onApplicationBootstrap();
      expect((await service.findOne('sessA', id)).status).toBe(CampaignStatus.RUNNING);
    });
  });

  describe('lifecycle guards', () => {
    it('refuses to delete a running campaign and to pause one that is not running', async () => {
      const { id } = await createFast('Name,Phone,Amount\nA,9000000001,1\n');
      await expect(service.pause('sessA', id)).rejects.toThrow(/only a running/);
      await ds.getRepository(Campaign).update({ id }, { status: CampaignStatus.RUNNING });
      await expect(service.delete('sessA', id)).rejects.toThrow(/Pause or cancel/);
      await service.pause('sessA', id);
      await service.delete('sessA', id);
      expect(await ds.getRepository(CampaignRecipient).count()).toBe(0);
    });

    it('scopes every read to the URL session', async () => {
      const { id } = await createFast('Name,Phone,Amount\nA,9000000001,1\n');
      await expect(service.findOne('sessB', id)).rejects.toThrow(/not found/);
    });
  });

  describe('export', () => {
    it('writes the original cells plus the outcome, with formula-looking cells neutralised', async () => {
      const { id } = await createFast('Name,Phone,Amount\n=HYPERLINK("x"),9000000001,1\n');
      await service.start('sessA', id);
      await service.run(id);
      const { filename, csv: out } = await service.exportResults('sessA', id);
      expect(filename).toBe('Test-results.csv');
      const lines = out
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n');
      expect(lines[0]).toBe('Row,Name,Phone,Amount,Chat ID,Status,Error,Message ID,Sent At');
      expect(lines[1]).toMatch(/^2,"'=HYPERLINK\(""x""\)",9000000001,1,919000000001@c\.us,sent,,wamid\.1,\d{4}-/);
    });
  });
});

describe('campaign helpers', () => {
  it('csvCell quotes separators and defuses formula prefixes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('+123')).toBe("'+123");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell(null)).toBe('');
  });

  it('renderCampaignText drops empty header/footer segments', () => {
    expect(renderCampaignText({ header: null, body: 'Hi {{n}}', footer: '' }, { n: 'A' })).toBe('Hi A');
  });
});
