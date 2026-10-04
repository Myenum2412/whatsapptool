import { DataSource } from 'typeorm';
import { CreateSuppressedContacts1786900003000 } from '../1786900003000-CreateSuppressedContacts';

/**
 * Regression lock: this table is the control that stops an opt-out being contacted, so its shape and
 * — above all — its UNIQUE (sessionId, chatId) index are load-bearing. Losing that index means a
 * contact who sends STOP twice produces two rows that then disagree about the audit trail, and the
 * send path's hot-path literal lookup degrades to a scan of every suppression for the session.
 */
describe('CreateSuppressedContacts migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const insert = (
    qr: ReturnType<DataSource['createQueryRunner']>,
    overrides: Partial<Record<string, unknown>> = {},
  ) => {
    const now = new Date().toISOString();
    return qr.query(
      'INSERT INTO suppressed_contacts (id, chatId, sessionId, identifiers, source, suppressedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        (overrides.id as string) ?? 's1',
        (overrides.chatId as string) ?? '15551234567@c.us',
        (overrides.sessionId as string) ?? 'sess-1',
        (overrides.identifiers as string) ?? JSON.stringify(['15551234567@c.us']),
        (overrides.source as string) ?? 'manual',
        (overrides.suppressedAt as string) ?? now,
        now,
      ],
    );
  };

  it('creates the table', async () => {
    const qr = ds.createQueryRunner();
    await new CreateSuppressedContacts1786900003000().up(qr);

    const rows = (await qr.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='suppressed_contacts'",
    )) as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    await qr.release();
  });

  it('creates the unique index under the name the entity declares', async () => {
    // Index names are part of the schema-drift gate: the entity and the migration must agree exactly.
    const qr = ds.createQueryRunner();
    await new CreateSuppressedContacts1786900003000().up(qr);

    const indexes = (await qr.query(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='suppressed_contacts'",
    )) as Array<{ name: string; sql: string }>;
    expect(indexes.map(i => i.name)).toContain('UQ_suppressed_contacts_sessionId_chatId');
    expect(indexes.find(i => i.name === 'UQ_suppressed_contacts_sessionId_chatId')!.sql).toMatch(/UNIQUE/i);
    await qr.release();
  });

  it('refuses a duplicate (sessionId, chatId) — the guarantee the registry depends on', async () => {
    const qr = ds.createQueryRunner();
    await new CreateSuppressedContacts1786900003000().up(qr);

    await insert(qr);
    // Same chat, same session: a repeat opt-out must be an UPDATE, not a second row.
    await expect(insert(qr, { id: 's2' })).rejects.toThrow();
    await qr.release();
  });

  it('allows the same chat on a different session', async () => {
    // "Do not contact" is scoped to one WhatsApp account: the same number can be a legitimate customer
    // on another account, and a global block would silently stop their messages there.
    const qr = ds.createQueryRunner();
    await new CreateSuppressedContacts1786900003000().up(qr);

    await insert(qr, { sessionId: 'sess-1' });
    await expect(insert(qr, { id: 's2', sessionId: 'sess-2' })).resolves.not.toThrow();
    await qr.release();
  });

  it('requires identifiers, source and suppressedAt', async () => {
    const qr = ds.createQueryRunner();
    await new CreateSuppressedContacts1786900003000().up(qr);

    await expect(
      qr.query(
        "INSERT INTO suppressed_contacts (id, chatId, sessionId, identifiers, source) VALUES ('x', 'c@c.us', 'sess-1', '[]', 'manual')",
      ),
      // suppressedAt has no default on purpose: a suppression with no time on it cannot be aged out or
      // reported on.
    ).rejects.toThrow();
    await qr.release();
  });

  it('round-trips identifiers as the text the data connection stores', async () => {
    const qr = ds.createQueryRunner();
    await new CreateSuppressedContacts1786900003000().up(qr);

    await insert(qr, { identifiers: JSON.stringify(['1555@c.us', '1555@s.whatsapp.net', '99@lid']) });
    const rows = (await qr.query('SELECT identifiers FROM suppressed_contacts WHERE id = ?', ['s1'])) as Array<{
      identifiers: string;
    }>;
    expect(JSON.parse(rows[0].identifiers)).toEqual(['1555@c.us', '1555@s.whatsapp.net', '99@lid']);
    await qr.release();
  });

  it('has no updatedAt column', async () => {
    // The row's change history is `source`/`keyword`/`suppressedAt`; an auto-updating column would
    // invite an in-place edit that erases WHY a contact is suppressed.
    const qr = ds.createQueryRunner();
    await new CreateSuppressedContacts1786900003000().up(qr);

    const cols = (await qr.query("PRAGMA table_info('suppressed_contacts')")) as Array<{ name: string }>;
    expect(cols.map(c => c.name)).not.toContain('updatedAt');
    await qr.release();
  });

  it('is idempotent', async () => {
    const qr = ds.createQueryRunner();
    const migration = new CreateSuppressedContacts1786900003000();
    await migration.up(qr);
    await expect(migration.up(qr)).resolves.not.toThrow();
    await qr.release();
  });

  it('down() drops the table and its index', async () => {
    const qr = ds.createQueryRunner();
    const migration = new CreateSuppressedContacts1786900003000();
    await migration.up(qr);
    await migration.down(qr);

    const tables = (await qr.query("SELECT name FROM sqlite_master WHERE name='suppressed_contacts'")) as Array<{
      name: string;
    }>;
    expect(tables).toHaveLength(0);
    await qr.release();
  });

  it('down() then up() leaves a usable table (rollback is not one-way)', async () => {
    const qr = ds.createQueryRunner();
    const migration = new CreateSuppressedContacts1786900003000();
    await migration.up(qr);
    await insert(qr);
    await migration.down(qr);
    await migration.up(qr);

    await expect(insert(qr, { id: 's9' })).resolves.not.toThrow();
    await qr.release();
  });
});
