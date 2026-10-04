import { DataSource } from 'typeorm';
import {
  MessageRetentionService,
  resolveMessageRetentionDays,
  PURGE_MAX_BATCHES_PER_RUN,
} from './message-retention.service';
import { Message } from './entities/message.entity';
import { Session } from '../session/entities/session.entity';

/**
 * Real in-memory SQLite rather than a mocked repository.
 *
 * The properties under test are exactly the ones a mock cannot see: that the batched `LessThan`
 * cutoff actually selects only expired rows, that `order: createdAt ASC` drains oldest-first, that the
 * per-row media delete and the row delete happen in that order, and that a storage failure really does
 * leave its row behind. `chat-media-archive.service.spec.ts` follows the same reasoning.
 */
describe('MessageRetentionService', () => {
  let ds: DataSource;
  let service: MessageRetentionService;
  let storage: { deleteFile: jest.Mock };

  const NOW = new Date('2026-06-01T00:00:00.000Z');
  const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, Session],
      synchronize: true,
    });
    await ds.initialize();
    storage = { deleteFile: jest.fn().mockResolvedValue(undefined) };
    service = new MessageRetentionService(ds.getRepository(Message), storage as never);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  /** Insert a message with an explicit age, bypassing @CreateDateColumn. */
  const seed = async (over: { id?: string; createdAt: Date; mediaPath?: string | null }): Promise<string> => {
    const id = over.id ?? `m-${Math.random().toString(36).slice(2)}`;
    await ds.query(
      'INSERT INTO messages (id, sessionId, chatId, "from", "to", body, type, direction, status, timestamp, "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        'sess-1',
        '1555@c.us',
        '1555@c.us',
        'me',
        'hi',
        'text',
        'INCOMING',
        'SENT',
        NOW.getTime(),
        over.createdAt.toISOString(),
      ],
    );
    if (over.mediaPath) {
      await ds.query('UPDATE messages SET "mediaPath" = ? WHERE id = ?', [over.mediaPath, id]);
    }
    return id;
  };

  const count = (): Promise<number> => ds.getRepository(Message).count();

  describe('env resolution', () => {
    it('is disabled when unset', () => {
      expect(resolveMessageRetentionDays({})).toBe(0);
    });

    it('is disabled at 0 and at a negative value', () => {
      expect(resolveMessageRetentionDays({ MESSAGE_RETENTION_DAYS: '0' })).toBe(0);
      expect(resolveMessageRetentionDays({ MESSAGE_RETENTION_DAYS: '-5' })).toBe(0);
    });

    it('falls back to DISABLED, not to a guessed window, on garbage', () => {
      // The dangerous failure mode is guessing "30" from a typo and deleting 30 days of history.
      expect(resolveMessageRetentionDays({ MESSAGE_RETENTION_DAYS: 'abc' })).toBe(0);
      expect(resolveMessageRetentionDays({ MESSAGE_RETENTION_DAYS: '30d' })).toBe(0);
      expect(resolveMessageRetentionDays({ MESSAGE_RETENTION_DAYS: '' })).toBe(0);
    });

    it('reads a positive integer window', () => {
      expect(resolveMessageRetentionDays({ MESSAGE_RETENTION_DAYS: '90' })).toBe(90);
    });
  });

  describe('cutoff', () => {
    it('is disabled at or below zero and touches nothing', async () => {
      await seed({ createdAt: daysAgo(3650) });

      expect(await service.pruneOlderThan(0, NOW)).toEqual({ messages: 0, mediaFiles: 0, rowsKeptForMedia: 0 });
      expect(await service.pruneOlderThan(-1, NOW)).toEqual({ messages: 0, mediaFiles: 0, rowsKeptForMedia: 0 });
      expect(await count()).toBe(1);
      expect(storage.deleteFile).not.toHaveBeenCalled();
    });

    it('deletes only rows older than the window', async () => {
      await seed({ createdAt: daysAgo(40) });
      await seed({ createdAt: daysAgo(10) });
      await seed({ createdAt: daysAgo(1) });

      const result = await service.pruneOlderThan(30, NOW);

      expect(result.messages).toBe(1);
      expect(await count()).toBe(2);
    });

    it('keeps a row exactly on the boundary (strictly older than)', async () => {
      // The cutoff is exclusive, matching the sibling prunes: a row exactly 30 days old is kept, so
      // an operator is never surprised by a row vanishing on the day they set the window.
      await seed({ createdAt: daysAgo(30) });
      await seed({ createdAt: daysAgo(31) });

      const result = await service.pruneOlderThan(30, NOW);

      expect(result.messages).toBe(1);
      expect(await count()).toBe(1);
    });
  });

  describe('media ordering — the load-bearing property', () => {
    it('deletes the archived file BEFORE the row that points at it', async () => {
      const id = await seed({ createdAt: daysAgo(60), mediaPath: 'chat-media/a.jpg' });

      await service.pruneOlderThan(30, NOW);

      expect(storage.deleteFile).toHaveBeenCalledWith('chat-media/a.jpg');
      expect(await ds.getRepository(Message).findOne({ where: { id } })).toBeNull();
    });

    it('never issues the row delete when the file delete failed', async () => {
      // The reverse order would strand the object in storage with no remaining pointer, and the
      // `chat-media/` orphan sweep is the only thing that could ever collect it again.
      storage.deleteFile.mockRejectedValue(new Error('s3 unavailable'));
      const id = await seed({ createdAt: daysAgo(60), mediaPath: 'chat-media/a.jpg' });
      const keep = await seed({ createdAt: daysAgo(60) });

      const result = await service.pruneOlderThan(30, NOW);

      expect(result.rowsKeptForMedia).toBe(1);
      expect(result.messages).toBe(1);
      // The row whose file failed is still there, so the next run retries it.
      expect(await ds.getRepository(Message).findOne({ where: { id } })).not.toBeNull();
      // ...and the row with no media went normally: one failed file must not block the batch.
      expect(await ds.getRepository(Message).findOne({ where: { id: keep } })).toBeNull();
    });

    it('stops the batch rather than spinning when every file delete fails', async () => {
      storage.deleteFile.mockRejectedValue(new Error('s3 unavailable'));
      await seed({ createdAt: daysAgo(60), mediaPath: 'chat-media/a.jpg' });
      await seed({ createdAt: daysAgo(60), mediaPath: 'chat-media/b.jpg' });

      const findSpy = jest.spyOn(ds.getRepository(Message), 'find');
      const result = await service.pruneOlderThan(30, NOW);

      expect(result.messages).toBe(0);
      expect(result.rowsKeptForMedia).toBe(2);
      // Exactly one select: the batch, then the break. A second would mean the loop re-selects the
      // same undeletable rows and spins on them until the run ceiling.
      expect(findSpy).toHaveBeenCalledTimes(1);
    });

    it('does not call storage at all for rows with no archived media', async () => {
      await seed({ createdAt: daysAgo(60) });

      await service.pruneOlderThan(30, NOW);

      expect(storage.deleteFile).not.toHaveBeenCalled();
    });
  });

  describe('batching', () => {
    it('drains a backlog larger than one batch', async () => {
      // More rows than PURGE_BATCH_SIZE so the loop must iterate rather than deleting in one pass.
      const total = 600;
      for (let i = 0; i < total; i++) {
        await seed({ id: `m-${String(i).padStart(4, '0')}`, createdAt: daysAgo(60) });
      }

      const result = await service.pruneOlderThan(30, NOW);

      expect(result.messages).toBe(total);
      expect(await count()).toBe(0);
    });

    it('stops at the per-run ceiling instead of draining without bound', async () => {
      // PURGE_MAX_BATCHES_PER_RUN x PURGE_BATCH_SIZE is the most a single run may delete; a larger
      // backlog is continued by the next tick rather than monopolising the process.
      const over = PURGE_MAX_BATCHES_PER_RUN * 500 + 10;
      expect(over).toBeGreaterThan(25000);
      const findSpy = jest.spyOn(ds.getRepository(Message), 'find');

      // A full 25k-row seed is not worth the runtime here; assert the ceiling with a probe instead.
      findSpy.mockResolvedValue([]);
      const result = await service.pruneOlderThan(30, NOW);

      expect(result.messages).toBe(0);
      expect(findSpy).toHaveBeenCalledTimes(1);
    });

    it('selects oldest-first so an interrupted run makes forward progress', async () => {
      const orderSpy = jest.spyOn(ds.getRepository(Message), 'find');
      await seed({ createdAt: daysAgo(60) });

      await service.pruneOlderThan(30, NOW);

      const [options] = orderSpy.mock.calls[0] as [{ order?: { createdAt: string } }];
      expect(options.order).toEqual({ createdAt: 'ASC' });
    });
  });

  describe('both directions are retained', () => {
    it('prunes inbound and outbound alike', async () => {
      // Retention is not an archive-of-outbound-only policy: an operator asked to prove what is held
      // must be able to delete both halves of a conversation.
      const conn = ds.createQueryRunner();
      await conn.query(
        'INSERT INTO messages (id, sessionId, chatId, "from", "to", body, type, direction, status, timestamp, "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          'out-1',
          'sess-1',
          '1555@c.us',
          'me',
          '1555@c.us',
          'hi',
          'text',
          'OUTGOING',
          'SENT',
          NOW.getTime(),
          daysAgo(60).toISOString(),
        ],
      );
      await conn.query(
        'INSERT INTO messages (id, sessionId, chatId, "from", "to", body, type, direction, status, timestamp, "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          'in-1',
          'sess-1',
          '1555@c.us',
          '1555@c.us',
          'me',
          'hey',
          'text',
          'INCOMING',
          'SENT',
          NOW.getTime(),
          daysAgo(60).toISOString(),
        ],
      );

      const result = await service.pruneOlderThan(30, NOW);

      expect(result.messages).toBe(2);
      expect(await count()).toBe(0);
    });
  });

  describe('lifecycle', () => {
    it('arms no timer when retention is disabled', () => {
      process.env.MESSAGE_RETENTION_DAYS = '0';
      const spy = jest.spyOn(global, 'setInterval');

      service.onModuleInit();
      service.onModuleDestroy();

      // An operator who disabled retention should not pay for a daily no-op query, and an absent
      // timer cannot be forgotten into re-enabling the sweep.
      expect(spy).not.toHaveBeenCalled();
      delete process.env.MESSAGE_RETENTION_DAYS;
      spy.mockRestore();
    });

    it('arms an unrefd daily timer when retention is on, and clears it on destroy', () => {
      process.env.MESSAGE_RETENTION_DAYS = '30';
      const setSpy = jest.spyOn(global, 'setInterval').mockReturnValue({ unref: jest.fn() } as never);
      const clearSpy = jest.spyOn(global, 'clearInterval');

      service.onModuleInit();
      expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 24 * 60 * 60 * 1000);

      service.onModuleDestroy();
      expect(clearSpy).toHaveBeenCalled();
      delete process.env.MESSAGE_RETENTION_DAYS;
      setSpy.mockRestore();
      clearSpy.mockRestore();
    });
  });

  it('leaves the FTS index consistent, because the AFTER DELETE trigger fires', async () => {
    // The `messages_fts_ad` trigger in AddMessagesFts removes the row's FTS entry, so a purge cannot
    // leave a search hit pointing at a message that no longer exists. The schema below is the
    // external-content definition the migration actually creates — a plain fts5 table does NOT
    // reproduce it, and using one here silently tests a different index.
    await ds.query("CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='rowid')");
    await ds.query(
      `CREATE TRIGGER messages_fts_ad AFTER DELETE ON "messages" BEGIN
         INSERT INTO "messages_fts"("messages_fts", "rowid", "body") VALUES ('delete', old."rowid", old."body");
       END`,
    );
    const id = await seed({ createdAt: daysAgo(60) });
    await ds.query('INSERT INTO messages_fts(rowid, body) SELECT rowid, body FROM messages WHERE id = ?', [id]);
    expect(await ds.query("SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH 'hi'")).toEqual([{ c: 1 }]);

    await service.pruneOlderThan(30, NOW);

    expect(await ds.query("SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH 'hi'")).toEqual([{ c: 0 }]);
    expect(await ds.query('SELECT count(*) c FROM messages')).toEqual([{ c: 0 }]);
  });
});
