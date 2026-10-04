import { DataSource } from 'typeorm';
import { CreateContactConsents1786900004000 } from '../1786900004000-CreateContactConsents';
import { ContactConsent } from '../../../modules/compliance/entities/contact-consent.entity';

/**
 * The consent ledger's migration is only trustworthy if the SCHEMA matches the entity, because the
 * service reads it with `synchronize: false` on Postgres. A column the entity declares but the migration
 * omits does not fail loudly — it fails as `no such column` on a customer's first consent query, which is
 * the worst possible moment to discover it. So every column is asserted, not just the table's existence.
 */
describe('CreateContactConsents1786900004000', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ContactConsent],
      synchronize: false,
    });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const migrate = async (): Promise<void> => new CreateContactConsents1786900004000().up(ds.createQueryRunner());

  interface ColumnInfo {
    name: string;
    type: string;
    notnull: number;
    pk: number;
    dflt_value: unknown;
  }

  /** `DataSource.query` is `any`; every assertion below wants a shape, so name it once. */
  const query = async <T>(sql: string): Promise<T[]> => await ds.query(sql);

  /** `PRAGMA table_info` keyed by column name, so assertions read as `info.contact?.notnull`. */
  const columns = async (): Promise<Record<string, ColumnInfo>> => {
    const rows = await query<ColumnInfo>(`PRAGMA table_info('contact_consents')`);
    return Object.fromEntries(rows.map((r: ColumnInfo) => [r.name, r]));
  };

  it('creates the table', async () => {
    await migrate();

    expect(
      await ds.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='contact_consents'`),
    ).toHaveLength(1);
  });

  it('creates both indexes', async () => {
    await migrate();

    const names = (
      await query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='contact_consents'`)
    ).map(r => r.name);

    expect(names).toContain('IDX_contact_consents_sessionId_contact_decidedAt');
    expect(names).toContain('IDX_contact_consents_sessionId_basis');
  });

  it('has a unique primary key on id', async () => {
    await migrate();

    const info = await columns();

    expect(info.id?.pk).toBe(1);
  });

  it('defaults id on PostgreSQL only, and leaves SQLite to the app', async () => {
    // SQLite has no `gen_random_uuid()`: the id is generated in the service. A migration that emitted the
    // PG default for SQLite would fail at CREATE TABLE, so this is the line most worth pinning.
    await migrate();

    const info = await columns();

    expect(info.id?.dflt_value ?? null).toBeNull();
  });

  it.each(['contact', 'sessionId', 'basis', 'action', 'source', 'decidedAt'])('requires %s', async column => {
    // A consent event with no contact, basis or decision is not an event.
    await migrate();

    const info = await columns();

    expect(info[column]?.notnull).toBe(1);
  });

  it.each(['operatorId', 'note'])('leaves %s nullable', async column => {
    // A contact's own STOP carries no operator; an operator's bulk import may carry no free-text note.
    // NOT NULL on either would make the common path unwritable.
    await migrate();

    const info = await columns();

    expect(info[column]?.notnull).toBe(0);
  });

  it('stores decidedAt as text on SQLite, matching dateColumnType()', async () => {
    await migrate();

    const info = await columns();

    expect(info.decidedAt?.type.toLowerCase()).toBe('text');
  });

  it('matches the entity column for column', async () => {
    // The drift gate that matters: if the entity grows a column and the migration does not, this fails
    // here rather than in production.
    await migrate();

    const metadata = ds.getMetadata(ContactConsent);
    const declared = metadata.columns.map(c => c.databaseName).sort();
    const migrated = Object.keys(await columns()).sort();

    expect(migrated).toEqual(declared);
  });

  it('does not add a unique constraint on (sessionId, contact, basis)', async () => {
    // The whole point: this is an EVENT log. A second STOP must be a new row, not an error or an
    // in-place update, or the audit trail cannot answer "when did they ask, and how often".
    await migrate();

    const indexes = await query<ColumnInfo>(`PRAGMA table_info('contact_consents')`);
    // `PRAGMA index_list` includes SQLite's implicit `sqlite_autoindex_*` for the PRIMARY KEY, which is
    // unique by definition; only explicitly declared indexes are interesting here.
    const declared = indexes.filter(i => i.pk === 0);
    expect(declared).not.toHaveLength(0);
  });

  it('allows the same contact+basis to be recorded repeatedly', async () => {
    await migrate();

    await expect(
      ds.query(
        `INSERT INTO contact_consents (id, contact, sessionId, basis, action, source, decidedAt, createdAt)
         VALUES ('a', '1@c.us', 's1', 'marketing', 'withdrawn', 'keyword', '2026-01-01T00:00:00.000Z', datetime('now'))`,
      ),
    ).resolves.toBeDefined();

    await expect(
      ds.query(
        `INSERT INTO contact_consents (id, contact, sessionId, basis, action, source, decidedAt, createdAt)
         VALUES ('b', '1@c.us', 's1', 'marketing', 'granted', 'keyword', '2026-01-02T00:00:00.000Z', datetime('now'))`,
      ),
    ).resolves.toBeDefined();

    const rows = await query<{ id: string }>(`SELECT id FROM contact_consents ORDER BY id`);

    expect(rows.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('is idempotent', async () => {
    // synchronize:true on a SQLite data connection creates the table WITHOUT running the migration, so a
    // deployment can legitimately have the table before the migration is first executed. `hasTable` is
    // what keeps that from being a startup crash.
    await migrate();
    await expect(migrate()).resolves.toBeUndefined();
  });

  it('drops the table and both indexes on down', async () => {
    await migrate();

    await new CreateContactConsents1786900004000().down(ds.createQueryRunner());

    expect(await query(`SELECT name FROM sqlite_master WHERE name='contact_consents'`)).toHaveLength(0);
    expect(
      await query(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'IDX_contact_consents%'`),
    ).toHaveLength(0);
  });

  it('down is safe to run on a database that never had the table', async () => {
    await expect(new CreateContactConsents1786900004000().down(ds.createQueryRunner())).resolves.toBeUndefined();
  });
});
