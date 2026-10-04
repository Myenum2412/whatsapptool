import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `suppressed_contacts` — the "do not contact this chat" registry — on the **data**
 * connection, alongside `messages`.
 *
 * Data connection because suppression is enforced on the send path: a control-plane table on the
 * always-SQLite `main` connection would put a second database in front of every outbound message, and
 * the one time that lookup fails (main locked, main busy, main restored) is exactly the time a
 * "no, don't send" answer must not be lost. `sessions` also lives here, so `sessionId` is a plain
 * column rather than a cross-database FK.
 *
 * Scoped by `sessionId` deliberately: "do not contact" is a property of one WhatsApp account, not of
 * a phone number globally. The same number is a legitimate customer on one account and a complainer on
 * another, and a global block would silently stop a paying customer's messages on their other account.
 *
 * `identifiers` holds every address form the chat is known by (the literal `@c.us`/`@lid`/`@g.us` plus
 * its phone and lid equivalents). It is `text`, NOT a native json/jsonb column, to match the data
 * connection's existing convention (`usage_events.metadata`): the pg driver only auto-parses native
 * json, and no query filters inside this array in SQL. It is matched in memory after a single indexed
 * read of the session's rows — see `SuppressionService.findRow`.
 *
 * No `updatedAt`: the row's history of changes is the point of `source`/`keyword`/`suppressedAt`, and an
 * auto-updating column would only invite an in-place edit that erases the reason a contact is suppressed.
 */
export class CreateSuppressedContacts1786900003000 implements MigrationInterface {
  name = 'CreateSuppressedContacts1786900003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (await queryRunner.hasTable('suppressed_contacts')) return;

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "suppressed_contacts" (` +
          `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"chatId" varchar(100) NOT NULL, ` +
          `"sessionId" varchar(36) NOT NULL, ` +
          `"identifiers" text NOT NULL, ` +
          `"source" varchar(32) NOT NULL, ` +
          `"reason" varchar(255), ` +
          `"keyword" varchar(32), ` +
          `"suppressedAt" timestamp NOT NULL, ` +
          `"createdAt" timestamp NOT NULL DEFAULT now()` +
          `)`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "suppressed_contacts" (` +
          `"id" varchar PRIMARY KEY NOT NULL, ` +
          `"chatId" varchar(100) NOT NULL, ` +
          `"sessionId" varchar(36) NOT NULL, ` +
          `"identifiers" text NOT NULL, ` +
          `"source" varchar(32) NOT NULL, ` +
          `"reason" varchar(255), ` +
          `"keyword" varchar(32), ` +
          `"suppressedAt" text NOT NULL, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now'))` +
          `)`,
      );
    }

    // Named as the entity declares it, because index names are part of the schema-drift gate.
    //
    // Unique on (sessionId, chatId) so a contact who sends STOP twice updates one row instead of
    // accumulating duplicates that then disagree about the audit trail, and so the send path's hot-path
    // literal lookup is a unique-index hit. It leads with sessionId, so it also serves every
    // session-scoped read; a separate single-column index on sessionId would duplicate its leftmost
    // column.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_suppressed_contacts_sessionId_chatId" ON "suppressed_contacts" ("sessionId", "chatId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_suppressed_contacts_sessionId_chatId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "suppressed_contacts"`);
  }
}
