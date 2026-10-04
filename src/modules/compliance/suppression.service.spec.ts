import { DataSource } from 'typeorm';
import { HttpException, HttpStatus } from '@nestjs/common';
import { SuppressionService, RECIPIENT_SUPPRESSED, isRecipientSuppressedError } from './suppression.service';
import { SuppressedContact, SuppressionSource } from './entities/suppressed-contact.entity';
import { Session } from '../session/entities/session.entity';
import { matchOptOut } from './compliance-keywords';
import { OptOutAction } from './entities/suppressed-contact.entity';

/**
 * Real SQLite rather than a mocked repository.
 *
 * The properties that matter here are exactly the ones a mock cannot see: that `identifiers` really
 * round-trips through the data connection's json column type, that the unique (sessionId, chatId)
 * index really makes a repeat opt-out an update rather than a duplicate row, and that a cross-form
 * lookup matches on identity instead of on the string that happened to be stored first.
 */
describe('SuppressionService', () => {
  let ds: DataSource;
  let service: SuppressionService;
  const rows = (): Promise<SuppressedContact[]> => ds.getRepository(SuppressedContact).find();

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [SuppressedContact, Session],
      synchronize: true,
    });
    await ds.initialize();
    service = new SuppressionService(ds.getRepository(SuppressedContact));
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const PHONE = '15551234567@c.us';
  const LID = '99887766@lid';

  describe('suppression', () => {
    it('suppresses a chat and expands every address form it is known by', async () => {
      await service.suppress(
        'sess-1',
        PHONE,
        SuppressionSource.OPT_OUT_KEYWORD,
        'Contact sent an opt-out keyword',
        'STOP',
      );

      expect(await service.isSuppressed('sess-1', PHONE)).toBe(true);
      // The whole point of storing candidates: the same person addressed the other way round is still
      // the same person, and a literal-string check would let the opt-out be walked around for free.
      expect(await service.isSuppressed('sess-1', '15551234567@s.whatsapp.net')).toBe(true);
    });

    it('does not suppress a different chat', async () => {
      await service.suppress('sess-1', PHONE, SuppressionSource.MANUAL);

      expect(await service.isSuppressed('sess-1', '15559999999@c.us')).toBe(false);
    });

    it('does not suppress the same number on a different session', async () => {
      // "Do not contact" is a property of one WhatsApp account, not of a phone number globally: the
      // same number can be a legitimate customer on another account.
      await service.suppress('sess-1', PHONE, SuppressionSource.MANUAL);

      expect(await service.isSuppressed('sess-2', PHONE)).toBe(false);
    });

    it('records the keyword and source so the refusal can be justified later', async () => {
      await service.suppress(
        'sess-1',
        PHONE,
        SuppressionSource.OPT_OUT_KEYWORD,
        'Contact sent an opt-out keyword',
        'STOP',
      );

      const [row] = await rows();
      expect(row).toMatchObject({
        chatId: PHONE,
        sessionId: 'sess-1',
        source: SuppressionSource.OPT_OUT_KEYWORD,
        keyword: 'STOP',
      });
    });

    it('updates rather than duplicating when the same chat opts out again', async () => {
      await service.suppress('sess-1', PHONE, SuppressionSource.OPT_OUT_KEYWORD, null, 'STOP');
      await service.suppress('sess-1', PHONE, SuppressionSource.OPT_OUT_KEYWORD, null, 'UNSUBSCRIBE');

      const all = await rows();
      // A contact who sends STOP twice must not produce two rows that then disagree about the audit trail.
      expect(all).toHaveLength(1);
      expect(all[0].keyword).toBe('UNSUBSCRIBE');
    });

    it('never downgrades a BLOCKED suppression to a keyword opt-out', async () => {
      await service.suppress('sess-1', PHONE, SuppressionSource.BLOCKED);
      await service.suppress('sess-1', PHONE, SuppressionSource.OPT_OUT_KEYWORD, null, 'STOP');

      const [row] = await rows();
      // The strongest reason to stay suppressed should be the one on record.
      expect(row.source).toBe(SuppressionSource.BLOCKED);
    });

    it('keeps a MANUAL suppression over a later keyword opt-out', async () => {
      await service.suppress('sess-1', PHONE, SuppressionSource.MANUAL, 'Legal request');
      await service.suppress('sess-1', PHONE, SuppressionSource.OPT_OUT_KEYWORD, null, 'STOP');

      const [row] = await rows();
      expect(row.source).toBe(SuppressionSource.MANUAL);
      expect(row.reason).toBe('Legal request');
    });

    it('unions identifiers so a later address form does not reopen the door', async () => {
      await service.suppress('sess-1', PHONE, SuppressionSource.MANUAL);
      await ds.query('UPDATE suppressed_contacts SET chatId = ? , identifiers = ? WHERE sessionId = ?', [
        '15559999999@c.us',
        JSON.stringify(['15559999999@c.us']),
        'sess-1',
      ]);

      // A second, distinct row for a differently-addressed view of the same number.
      await ds.query(
        'INSERT INTO suppressed_contacts (id, chatId, sessionId, identifiers, source, suppressedAt, createdAt) VALUES (?,?,?,?,?,?,?)',
        [
          'id-2',
          PHONE,
          'sess-1',
          JSON.stringify([PHONE]),
          SuppressionSource.MANUAL,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );

      // Both rows exist; a lookup by the first form still finds a suppression.
      expect(await service.isSuppressed('sess-1', PHONE)).toBe(true);
      expect(await rows()).toHaveLength(2);
    });
  });

  describe('assertNotSuppressed', () => {
    it('returns normally for a contactable chat', async () => {
      await expect(service.assertNotSuppressed('sess-1', PHONE)).resolves.toBeUndefined();
    });

    it('refuses a suppressed chat with a 409 carrying RECIPIENT_SUPPRESSED', async () => {
      await service.suppress('sess-1', PHONE, SuppressionSource.OPT_OUT_KEYWORD, null, 'STOP');

      const error = await service.assertNotSuppressed('sess-1', PHONE).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpException);
      const body = (error as HttpException).getResponse() as { statusCode: number; code: string };
      // 409, not 403: nothing about the caller's credentials is wrong and the refusal is liftable.
      expect(body.statusCode).toBe(HttpStatus.CONFLICT);
      expect(body.code).toBe(RECIPIENT_SUPPRESSED);
    });

    it('is recognised by the shared predicate, so callers treat it as a refusal not a failure', async () => {
      await service.suppress('sess-1', PHONE, SuppressionSource.MANUAL);

      const error = await service.assertNotSuppressed('sess-1', PHONE).catch((e: unknown) => e);

      expect(isRecipientSuppressedError(error)).toBe(true);
      expect(isRecipientSuppressedError(new HttpException('nope', 409))).toBe(false);
      expect(isRecipientSuppressedError(new Error('boom'))).toBe(false);
    });
  });

  describe('lifting a suppression', () => {
    it('lifts a keyword opt-out', async () => {
      await service.suppress('sess-1', PHONE, SuppressionSource.OPT_OUT_KEYWORD, null, 'STOP');

      expect(await service.unsuppress('sess-1', PHONE, 'START')).toBe(true);
      expect(await service.isSuppressed('sess-1', PHONE)).toBe(false);
    });

    it('lifts a MANUAL suppression, since an operator may reconsider', async () => {
      await service.suppress('sess-1', PHONE, SuppressionSource.MANUAL, 'Complaint');

      expect(await service.unsuppress('sess-1', PHONE)).toBe(true);
      expect(await rows()).toHaveLength(0);
    });

    it('refuses to lift a BLOCKED suppression', async () => {
      // WhatsApp reports the contact blocked us; an opt-in keyword cannot undo that, and the platform
      // enforces it regardless of what we store. The row stays so the operator can see why.
      await service.suppress('sess-1', PHONE, SuppressionSource.BLOCKED);

      expect(await service.unsuppress('sess-1', PHONE, 'START')).toBe(false);
      expect(await service.isSuppressed('sess-1', PHONE)).toBe(true);
      expect((await rows())[0].source).toBe(SuppressionSource.BLOCKED);
    });

    it('reports false when there was nothing to lift', async () => {
      expect(await service.unsuppress('sess-1', PHONE)).toBe(false);
    });
  });

  describe('inbound commands', () => {
    it('suppresses on STOP and reports what it did', async () => {
      expect(await service.applyInbound('sess-1', PHONE, 'STOP')).toBe(OptOutAction.OPT_OUT);
      expect(await service.isSuppressed('sess-1', PHONE)).toBe(true);
    });

    it('lifts on START', async () => {
      await service.suppress('sess-1', PHONE, SuppressionSource.OPT_OUT_KEYWORD, null, 'STOP');

      expect(await service.applyInbound('sess-1', PHONE, 'start')).toBe(OptOutAction.OPT_IN);
      expect(await service.isSuppressed('sess-1', PHONE)).toBe(false);
    });

    it('leaves an ordinary conversation alone', async () => {
      expect(await service.applyInbound('sess-1', PHONE, 'Can you send me the invoice please?')).toBeNull();
      expect(await rows()).toHaveLength(0);
    });

    it('ignores a keyword in a GROUP rather than silencing everyone in it', async () => {
      // In a group `from` is the group JID and one member typing STOP would otherwise suppress the
      // whole conversation for every other member.
      expect(await service.applyInbound('sess-1', '12345@g.us', 'STOP')).toBeNull();
      expect(await rows()).toHaveLength(0);
    });

    it('honours custom keywords', async () => {
      expect(await service.applyInbound('sess-1', PHONE, 'LEAVE', ['LEAVE'], ['JOIN'])).toBe(OptOutAction.OPT_OUT);
      expect(await service.isSuppressed('sess-1', PHONE)).toBe(true);
    });
  });

  describe('listing', () => {
    it("returns one session's suppressions, newest first", async () => {
      await service.suppress('sess-1', PHONE, SuppressionSource.MANUAL);
      await service.suppress('sess-1', LID, SuppressionSource.BLOCKED);
      await service.suppress('sess-2', PHONE, SuppressionSource.MANUAL);

      const list = await service.listForSession('sess-1');

      expect(list).toHaveLength(2);
      expect(list.map(r => r.chatId)).toEqual([LID, PHONE]);
    });
  });

  describe('blocked contacts', () => {
    it('marks a chat blocked and keeps it suppressed through an opt-in', async () => {
      await service.markBlocked('sess-1', PHONE);
      await service.applyInbound('sess-1', PHONE, 'START');

      expect(await service.isSuppressed('sess-1', PHONE)).toBe(true);
    });
  });
});

describe('matchOptOut', () => {
  it('matches the keywords WhatsApp requires, case- and punctuation-insensitively', () => {
    for (const body of ['STOP', 'stop', 'Stop!', ' STOP. ', 'UNSUBSCRIBE', 'unsubscribe', 'END', 'Cancel', 'QUIT']) {
      expect(matchOptOut(body)?.action).toBe(OptOutAction.OPT_OUT);
    }
  });

  it('matches opt-ins', () => {
    expect(matchOptOut('START')?.action).toBe(OptOutAction.OPT_IN);
    expect(matchOptOut('resume')?.action).toBe(OptOutAction.OPT_IN);
  });

  it('reports the keyword as written, normalized, for the audit trail', () => {
    expect(matchOptOut('stop!')?.keyword).toBe('STOP');
  });

  it('does NOT match a keyword as a substring of ordinary conversation', () => {
    // This is the failure that quietly fills an opt-out list with people who never asked to leave.
    for (const body of [
      'do not STOP asking',
      'I want to subscribe to the newsletter',
      'the endpoint is down',
      'cancel my subscription please, thanks',
      'this is a stop sign joke',
    ]) {
      expect(matchOptOut(body)).toBeNull();
    }
  });

  it('ignores decoration a client or human adds', () => {
    expect(matchOptOut('stop🛑')).not.toBeNull();
    expect(matchOptOut('*STOP*')).not.toBeNull();
    expect(matchOptOut('#STOP')).not.toBeNull();
  });

  it('handles empty and absent bodies', () => {
    expect(matchOptOut('')).toBeNull();
    expect(matchOptOut(null)).toBeNull();
    expect(matchOptOut(undefined)).toBeNull();
    expect(matchOptOut('   ')).toBeNull();
  });

  it('does not scan a pasted essay', () => {
    expect(matchOptOut(`STOP and also ${'x'.repeat(200)}`)).toBeNull();
  });

  it('falls back to the defaults when a custom list is empty', () => {
    expect(matchOptOut('STOP', [], [])?.action).toBe(OptOutAction.OPT_OUT);
  });
});
