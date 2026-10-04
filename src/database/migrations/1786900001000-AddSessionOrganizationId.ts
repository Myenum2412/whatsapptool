import { MigrationInterface, QueryRunner } from 'typeorm';
import { DEFAULT_ORGANIZATION_ID } from '../../modules/tenancy/tenancy.constants';

/**
 * Adds `sessions.organizationId` (the tenant join key) on the **data** connection, and points every
 * pre-existing session at the default organization.
 *
 * Split from CreateUsageEvents so the backfill is reviewable on its own: it rewrites every row in
 * `sessions`, and on a large install that is the only part of this increment that can lock.
 *
 * NULLABLE + backfilled, not NOT NULL. SQLite cannot add a NOT NULL column to a table that has rows
 * without rebuilding the table, and enforcement is a later increment behind MULTITENANCY_ENABLED — so
 * this lands the column, indexes it and fills it, and nothing enforces it yet.
 *
 * The default organization id is a constant imported from tenancy.constants, not looked up: it lives
 * on the `main` connection and this runs against `data`. See the constant's doc for why it is frozen.
 */
export class AddSessionOrganizationId1786900001000 implements MigrationInterface {
  name = 'AddSessionOrganizationId1786900001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // PRAGMA guard (AddSessionOwnership's precedent): SQLite has no `ADD COLUMN IF NOT EXISTS`, and
    // this must be safe to adopt on a database a previous `synchronize: true` build already altered.
    const rows = (await queryRunner.query(`PRAGMA table_info("sessions")`)) as Array<{ name: string }>;
    if (!rows.some(column => column.name === 'organizationId')) {
      await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "organizationId" varchar(36) NULL`);
    }

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_sessions_organizationId" ON "sessions" ("organizationId")`,
    );

    // Backfill every session that predates tenancy, and any row a half-applied earlier attempt left
    // NULL. Idempotent: re-running rewrites the same rows to the same id.
    //
    // Rows written AFTER this migration are NOT backfilled here — they are written NULL on purpose and
    // resolved by tenancy.service.ts at use time, which is the enforcement path the flag will gate.
    // So this statement is a one-time upgrade of history, not a standing invariant.
    await queryRunner.query(`UPDATE "sessions" SET "organizationId" = ? WHERE "organizationId" IS NULL`, [
      DEFAULT_ORGANIZATION_ID,
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The column is left in place rather than dropped: SQLite cannot drop a column that an index
    // covers, and dropping the table-wide column would also destroy the backfill. A reverted tenant
    // migration is a support action that ships as a new forward migration, so the honest `down` here
    // is the one that loses nothing.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sessions_organizationId"`);
  }
}
