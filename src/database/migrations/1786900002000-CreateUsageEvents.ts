import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `usage_events` — the append-only metered-usage ledger — on the **data** connection.
 *
 * Data connection, not the always-SQLite `main` control plane: this is the highest-write-volume table
 * in the product, so it must be able to run on PostgreSQL and scale, and be pruned on a retention
 * sweep without touching identity. The organizations it points at live on `main`, so `organizationId`
 * is a plain column — a cross-database FK is not expressible.
 *
 * Hand-authored per dialect (AddCampaigns' precedent) because `synchronize` is off on this connection
 * for Postgres. The Postgres branch adds `gen_random_uuid()` so a row inserted without an id gets one;
 * the SQLite branch relies on the driver generating it, matching every other table here.
 *
 * `occurredAt` is `timestamp` on Postgres and `text` on SQLite, and the entity declares it through
 * `dateColumnType()` — the same dialect split the rest of the data schema uses.
 *
 * No `updatedAt`: rows are append-only and immutable, so there is no "last modified" to record. A
 * column that implied one would only invite an in-place UPDATE that breaks invoice reproducibility.
 */
export class CreateUsageEvents1786900002000 implements MigrationInterface {
  name = 'CreateUsageEvents1786900002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (await queryRunner.hasTable('usage_events')) return;

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "usage_events" (` +
          `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"organizationId" varchar(36) NOT NULL, ` +
          `"kind" varchar(50) NOT NULL, ` +
          `"quantity" integer NOT NULL DEFAULT 1, ` +
          `"sessionId" varchar(36), ` +
          `"subject" varchar(255), ` +
          `"occurredAt" timestamp NOT NULL, ` +
          `"metadata" text, ` +
          `"createdAt" timestamp NOT NULL DEFAULT now()` +
          `)`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "usage_events" (` +
          `"id" varchar PRIMARY KEY NOT NULL, ` +
          `"organizationId" varchar(36) NOT NULL, ` +
          `"kind" varchar(50) NOT NULL, ` +
          `"quantity" integer NOT NULL DEFAULT (1), ` +
          `"sessionId" varchar(36), ` +
          `"subject" varchar(255), ` +
          `"occurredAt" text NOT NULL, ` +
          `"metadata" text, ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now'))` +
          `)`,
      );
    }

    // The two composite indexes the entity declares, named as it declares them so the chain-built and
    // synchronize-built schemas agree (index names are part of the drift gate).
    //
    // The first is the read every usage query makes: one organization's usage over a time window. The
    // second is the same window further narrowed by kind, so a per-kind breakdown does not have to
    // filter the whole organization's activity in JS.
    await queryRunner.query(
      `CREATE INDEX "IDX_usage_events_organizationId_occurredAt" ON "usage_events" ("organizationId", "occurredAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_usage_events_organizationId_kind_occurredAt" ON "usage_events" ("organizationId", "kind", "occurredAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_usage_events_organizationId_kind_occurredAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_usage_events_organizationId_occurredAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "usage_events"`);
  }
}
