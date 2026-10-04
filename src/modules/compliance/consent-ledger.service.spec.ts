import { DataSource, Repository } from 'typeorm';
import { ConsentLedgerService, ConsentDecisionInput } from './consent-ledger.service';
import { ContactConsent, ConsentAction, ConsentBasis, ConsentSource } from './entities/contact-consent.entity';
import { SuppressedContact } from './entities/suppressed-contact.entity';
import { Session } from '../session/entities/session.entity';

/**
 * Real in-memory SQLite rather than a mocked repository.
 *
 * The properties under test are the ones a mock cannot see: that `decidedAt` (not `createdAt`) is what
 * orders the ledger, that the append-only table actually accepts a second withdrawal instead of a unique
 * violation, and that there is no UPDATE path in the entity at all.
 */
describe('ConsentLedgerService', () => {
  let ds: DataSource;
  let service: ConsentLedgerService;
  const repo = (): Repository<ContactConsent> => ds.getRepository(ContactConsent);

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ContactConsent, SuppressedContact, Session],
      synchronize: true,
    });
    await ds.initialize();
    service = new ConsentLedgerService(ds.getRepository(ContactConsent));
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const CONTACT = '15551234567@c.us';
  const operator = (over: Partial<ConsentDecisionInput> = {}): ConsentDecisionInput => ({
    action: ConsentAction.GRANTED,
    source: ConsentSource.OPERATOR,
    operatorId: 'user-1',
    ...over,
  });

  describe('recording', () => {
    it('records a decision with the time it was made, not the time the row landed', async () => {
      // An operator backfilling a form from last week must record last week's date; using createdAt would
      // date the consent to the day of the import, which reads as consent taken AFTER the messages it
      // supposedly authorised.
      const decidedAt = new Date('2026-01-01T10:00:00.000Z');
      const row = await service.record('sess-1', CONTACT, ConsentBasis.MARKETING, {
        action: ConsentAction.GRANTED,
        source: ConsentSource.CONTACT,
        at: decidedAt,
      });

      expect(row.decidedAt.toISOString()).toBe('2026-01-01T10:00:00.000Z');
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(row.decidedAt.getTime());
    });

    it('refuses an imported claim with no operatorId too', async () => {
      // An import is how a consent list gets laundered: a spreadsheet of "active customers" quietly
      // becomes thousands of GRANTED rows nobody confirmed. The importer is the only person who can say
      // where they came from, so an unattributed import is refused for the same reason an unattributed
      // operator claim is.
      await expect(
        service.record('sess-1', CONTACT, ConsentBasis.MARKETING, {
          action: ConsentAction.GRANTED,
          source: ConsentSource.IMPORT,
        }),
      ).rejects.toThrow(/operatorId/);
    });

    it('accepts an imported claim that names its operator', async () => {
      const saved = await service.record('sess-1', CONTACT, ConsentBasis.MARKETING, {
        action: ConsentAction.GRANTED,
        source: ConsentSource.IMPORT,
        operatorId: 'user-7',
        note: 'q3-cleanup.csv',
      });

      expect(saved.operatorId).toBe('user-7');
    });

    it("leaves the contact's own keywords unattributed", async () => {
      // No human is involved when someone types STOP, so demanding an operatorId here would make the
      // most trustworthy source in the ledger the hardest to record.
      const saved = await service.record('sess-1', CONTACT, ConsentBasis.MARKETING, {
        action: ConsentAction.WITHDRAWN,
        source: ConsentSource.KEYWORD,
      });

      expect(saved.operatorId).toBeNull();
    });

    it('refuses an operator-sourced claim with no operatorId', async () => {
      // An unattributed consent record cannot be audited, which is the only reason this ledger exists.
      await expect(
        service.record('sess-1', CONTACT, ConsentBasis.MARKETING, {
          action: ConsentAction.GRANTED,
          source: ConsentSource.OPERATOR,
        }),
      ).rejects.toThrow(/operatorId/);
      expect(await repo().count()).toBe(0);
    });

    it('allows a contact-sourced claim with no operatorId', async () => {
      // The contact IS the authority; requiring an operator would be nonsense.
      await expect(
        service.record('sess-1', CONTACT, ConsentBasis.MARKETING, {
          action: ConsentAction.GRANTED,
          source: ConsentSource.CONTACT,
        }),
      ).resolves.toBeTruthy();
    });

    it('records the note verbatim, including the keyword', async () => {
      const row = await service.record('sess-1', CONTACT, ConsentBasis.MARKETING, {
        action: ConsentAction.WITHDRAWN,
        source: ConsentSource.KEYWORD,
        note: 'Contact sent "STOP"',
      });

      expect(row.note).toBe('Contact sent "STOP"');
    });
  });

  describe('append-only', () => {
    it('accumulates rows rather than replacing them — a repeat withdrawal is its own evidence', async () => {
      await service.record('sess-1', CONTACT, ConsentBasis.MARKETING, operator({ action: ConsentAction.GRANTED }));
      await service.record('sess-1', CONTACT, ConsentBasis.MARKETING, {
        action: ConsentAction.WITHDRAWN,
        source: ConsentSource.KEYWORD,
        at: new Date('2026-02-01T00:00:00Z'),
      });
      await service.record('sess-1', CONTACT, ConsentBasis.MARKETING, {
        action: ConsentAction.WITHDRAWN,
        source: ConsentSource.KEYWORD,
        at: new Date('2026-03-01T00:00:00Z'),
      });

      const all = await repo().find();
      // Three rows. The second withdrawal is the evidence the FIRST was honoured — unique-ing the table
      // would force an in-place update and destroy exactly that.
      expect(all).toHaveLength(3);
      expect(all.filter((r: ContactConsent) => r.action === ConsentAction.WITHDRAWN)).toHaveLength(2);
    });

    it('has no updatedAt column', () => {
      const cols = ds.getMetadata(ContactConsent).columns.map(c => c.propertyName);
      expect(cols).not.toContain('updatedAt');
      expect(cols).toContain('createdAt');
    });

    it('does not declare an UPDATE timestamp in its metadata', () => {
      expect(ds.getMetadata(ContactConsent).updateDateColumn).toBeUndefined();
    });
  });

  describe('current state', () => {
    it('defaults to granted for a contact with no record', async () => {
      // A fresh install with a pre-existing customer list must be able to message them; requiring an
      // opt-in record before any send would make the compliance feature break the product on day one.
      const state = await service.currentState('sess-1', CONTACT);

      expect(state[ConsentBasis.MARKETING]).toBe(ConsentAction.GRANTED);
      expect(state[ConsentBasis.TRANSACTIONAL]).toBe(ConsentAction.GRANTED);
    });

    it('reports the LATEST decision per basis', async () => {
      await service.record(
        'sess-1',
        CONTACT,
        ConsentBasis.MARKETING,
        operator({ action: ConsentAction.GRANTED, at: new Date('2026-01-01T00:00:00Z') }),
      );
      await service.record('sess-1', CONTACT, ConsentBasis.MARKETING, {
        action: ConsentAction.WITHDRAWN,
        source: ConsentSource.KEYWORD,
        at: new Date('2026-02-01T00:00:00Z'),
      });
      await service.record('sess-1', CONTACT, ConsentBasis.MARKETING, {
        action: ConsentAction.GRANTED,
        source: ConsentSource.KEYWORD,
        at: new Date('2026-03-01T00:00:00Z'),
      });

      expect((await service.currentState('sess-1', CONTACT))[ConsentBasis.MARKETING]).toBe(ConsentAction.GRANTED);
    });

    it('does not let a later decision on one basis change the other', async () => {
      // The mistake that produces a contact missing their invoice because they opted out of marketing.
      await service.record('sess-1', CONTACT, ConsentBasis.MARKETING, {
        action: ConsentAction.WITHDRAWN,
        source: ConsentSource.KEYWORD,
      });

      const state = await service.currentState('sess-1', CONTACT);
      expect(state[ConsentBasis.MARKETING]).toBe(ConsentAction.WITHDRAWN);
      expect(state[ConsentBasis.TRANSACTIONAL]).toBe(ConsentAction.GRANTED);
    });

    it('is per-session: the same number on another account is unaffected', async () => {
      await service.record('sess-1', CONTACT, ConsentBasis.MARKETING, {
        action: ConsentAction.WITHDRAWN,
        source: ConsentSource.KEYWORD,
      });

      expect(await service.isPermitted('sess-2', CONTACT, ConsentBasis.MARKETING)).toBe(true);
    });
  });

  describe('summary — the answer to "prove it"', () => {
    it('returns current state AND the full trail, oldest first', async () => {
      await service.record(
        'sess-1',
        CONTACT,
        ConsentBasis.MARKETING,
        operator({ action: ConsentAction.GRANTED, at: new Date('2026-01-01T00:00:00Z') }),
      );
      await service.record('sess-1', CONTACT, ConsentBasis.MARKETING, {
        action: ConsentAction.WITHDRAWN,
        source: ConsentSource.KEYWORD,
        at: new Date('2026-02-01T00:00:00Z'),
      });

      const summary = await service.summary('sess-1', CONTACT);

      expect(summary.contact).toBe(CONTACT);
      expect(summary.current[ConsentBasis.MARKETING]).toBe(ConsentAction.WITHDRAWN);
      expect(summary.history.map(r => r.decidedAt.toISOString())).toEqual([
        '2026-01-01T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z',
      ]);
      // The grant is still visible — the whole reason this is not a mutable state table.
      expect(summary.history[0].action).toBe(ConsentAction.GRANTED);
    });
  });

  describe('inbound keywords', () => {
    it('records a withdrawal on STOP', async () => {
      expect(await service.applyInboundKeyword('sess-1', CONTACT, 'STOP')).toBe(ConsentAction.WITHDRAWN);

      const [row] = await repo().find();
      expect(row).toMatchObject({
        contact: CONTACT,
        basis: ConsentBasis.MARKETING,
        action: ConsentAction.WITHDRAWN,
        source: ConsentSource.KEYWORD,
      });
      expect(row.note).toContain('STOP');
    });

    it('records a grant on START', async () => {
      await service.applyInboundKeyword('sess-1', CONTACT, 'STOP');
      expect(await service.applyInboundKeyword('sess-1', CONTACT, 'START')).toBe(ConsentAction.GRANTED);

      // Two rows: the withdrawal is still on the record.
      expect(await repo().count()).toBe(2);
      expect((await service.currentState('sess-1', CONTACT))[ConsentBasis.MARKETING]).toBe(ConsentAction.GRANTED);
    });

    it('records nothing for ordinary conversation', async () => {
      expect(await service.applyInboundKeyword('sess-1', CONTACT, 'can you send me the invoice?')).toBeNull();
      expect(await repo().count()).toBe(0);
    });

    it('refuses to record consent state for a group', async () => {
      // In a group `from` is the group JID, so a withdrawal would fabricate consent state for every
      // participant — including people who never asked for anything.
      expect(await service.applyInboundKeyword('sess-1', '12345@g.us', 'STOP')).toBeNull();
      expect(await repo().count()).toBe(0);
    });

    it('can target a different basis', async () => {
      await service.applyInboundKeyword('sess-1', CONTACT, 'STOP', ConsentBasis.TRANSACTIONAL);

      const state = await service.currentState('sess-1', CONTACT);
      expect(state[ConsentBasis.TRANSACTIONAL]).toBe(ConsentAction.WITHDRAWN);
      expect(state[ConsentBasis.MARKETING]).toBe(ConsentAction.GRANTED);
    });
  });
});
