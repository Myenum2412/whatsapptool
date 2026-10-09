import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `sessions.ownerUserId` on the **data** connection — the dashboard account (`users.id` on the
 * `main` connection) whose login key owns a session.
 *
 * An account's `users`-role key may reach exactly the sessions it owns, so each connection a
 * dashboard sign-in creates is private to that account, and sessions that predate this migration —
 * ownerUserId NULL — become orgmenu-only: no account key owns them.
 *
 * NULLABLE, not NOT NULL, and NO backfill, deliberately: NULL is the "not an account's session"
 * marker (hand-minted API keys and all pre-existing rows), and the privacy rule keys off that. A
 * NOT NULL column here would also break every write path that has not threaded the account through
 * yet, and SQLite cannot add a NOT NULL column to a table with rows without a rebuild.
 *
 * Indexed on the owner exactly like organizationId (its precedent), so both "sessions this account
 * owns" queries and the GET /sessions owner filter are a range scan, not a table walk.
 *
 * Idempotent: the column is probed independently of the index, so a run interrupted between the
 * two still completes and a database previously altered by `synchronize` is safe to adopt.
 */
export class AddSessionOwnerUserId1787000002000 implements MigrationInterface {
  name = 'AddSessionOwnerUserId1787000002000';

  private async hasColumn(queryRunner: QueryRunner, name: string): Promise<boolean> {
    if (queryRunner.connection.options.type === 'postgres') {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'sessions' AND column_name = '${name}'`,
      )) as unknown[];
      return rows.length > 0;
    }
    const rows = (await queryRunner.query(`PRAGMA table_info("sessions")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(queryRunner, 'ownerUserId'))) {
      await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "ownerUserId" varchar(36) NULL`);
    }
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sessions_ownerUserId" ON "sessions" ("ownerUserId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The column is left in place rather than dropped, matching AddSessionOrganizationId: SQLite
    // cannot drop a column that an index covers, and a reverted ownership migration is a support
    // action that ships as a new forward migration, so the honest `down` drops nothing but the index.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sessions_ownerUserId"`);
  }
}
