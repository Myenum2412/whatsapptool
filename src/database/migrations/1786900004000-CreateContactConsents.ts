import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `contact_consents` — the append-only consent ledger — on the **data** connection.
 *
 * Data connection for the same reason as `suppressed_contacts`: a consent record must be producible
 * alongside the messages it authorises, and `operatorId` points at a `users` row on the always-SQLite
 * `main` connection, so it is a plain column rather than a cross-database FK.
 *
 * No UNIQUE constraint on (sessionId, contact, basis): the table is an EVENT log, so a second
 * withdrawal is a new row and not an error. Making it unique would force the service to update in place
 * and destroy the audit trail this table exists to preserve — which is precisely the mistake
 * `suppressed_contacts` is allowed to make (one row per contact, current state) and this one is not.
 *
 * Hand-authored per dialect because `synchronize` is off for Postgres on the data connection
 * (`AddCampaigns`' precedent). `decidedAt` is `timestamp` on Postgres and `text` on SQLite, declared by
 * the entity through `dateColumnType()`.
 *
 * No `updatedAt`: append-only, so there is no "last modified" to record.
 */
export class CreateContactConsents1786900004000 implements MigrationInterface {
  name = 'CreateContactConsents1786900004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (await queryRunner.hasTable('contact_consents')) return;

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "contact_consents" (` +
          `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"contact" varchar(100) NOT NULL, ` +
          `"sessionId" varchar(36) NOT NULL, ` +
          `"basis" varchar(24) NOT NULL, ` +
          `"action" varchar(16) NOT NULL, ` +
          `"source" varchar(24) NOT NULL, ` +
          `"operatorId" varchar(36), ` +
          `"note" varchar(255), ` +
          `"decidedAt" timestamp NOT NULL, ` +
          `"createdAt" timestamp NOT NULL DEFAULT now()` +
          `)`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "contact_consents" (` +
          `"id" varchar PRIMARY KEY NOT NULL, ` +
          `"contact" varchar(100) NOT NULL, ` +
          `"sessionId" varchar(36) NOT NULL, ` +
          `"basis" varchar(24) NOT NULL, ` +
          `"action" varchar(16) NOT NULL, ` +
          `"source" varchar(24) NOT NULL, ` +
          `"operatorId" varchar(36), ` +
          `"note" varchar(255), ` +
          `"decidedAt" text NOT NULL, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now'))` +
          `)`,
      );
    }

    // Named as the entity declares them; index names are part of the schema-drift gate.
    //
    // The composite one is the read every question takes: "what did this contact decide, in order" — which
    // is both `currentState` (latest wins) and `summary` (the whole trail) in a single index range.
    await queryRunner.query(
      `CREATE INDEX "IDX_contact_consents_sessionId_contact_decidedAt" ON "contact_consents" ("sessionId", "contact", "decidedAt")`,
    );
    // "Show me every consent event of one kind across the session" — the audit/reconciliation query, which
    // must not degrade into a scan of the whole ledger.
    await queryRunner.query(
      `CREATE INDEX "IDX_contact_consents_sessionId_basis" ON "contact_consents" ("sessionId", "basis")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_contact_consents_sessionId_basis"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_contact_consents_sessionId_contact_decidedAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "contact_consents"`);
  }
}
