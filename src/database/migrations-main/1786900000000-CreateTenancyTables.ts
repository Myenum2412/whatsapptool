import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  DEFAULT_ORGANIZATION_ID,
  DEFAULT_ORGANIZATION_NAME,
  DEFAULT_ORGANIZATION_SLUG,
} from '../../modules/tenancy/tenancy.constants';

/**
 * Creates the tenancy control plane on the **main** connection: `organizations`, `users`,
 * `memberships`.
 *
 * MAIN connection, always SQLite (app.module.ts hardcodes `type: 'better-sqlite3'`), so this
 * migration uses SQLite-only DDL — `datetime`, `boolean DEFAULT (1)`, no `gen_random_uuid()` — unlike
 * the data migrations, which must branch per dialect. The entities match it exactly (`datetime` and
 * `simple-json`, never the data-connection `dateColumnType()`/`jsonColumnType()` helpers, which
 * resolve `DATABASE_TYPE` and would emit `timestamp` into a SQLite database).
 *
 * `IF NOT EXISTS` throughout so this is safe to adopt on a database a previous `synchronize: true`
 * build already created, matching CreateAuthAuditTables.
 *
 * No FKs. `memberships` references `organizations` and `users`, which all live on this connection, so
 * constraints are expressible — but they are deliberately omitted: TypeORM derives FK names from the
 * table+column hash, and a hand-written migration would have to reproduce that hash exactly or the
 * drift gate would report a rebuild nobody made. There is no route that deletes a user or an
 * organization in this increment, so nothing can produce an orphan yet; the deletion rule is a
 * cascade to be added with the route that needs it.
 */
export class CreateTenancyTables1786900000000 implements MigrationInterface {
  name = 'CreateTenancyTables1786900000000';

  // The default organization's id/slug/name come from tenancy.constants rather than being repeated
  // here as literals, because the DATA-connection migration that backfills sessions.organizationId
  // must name the same row from another database and another migration chain. That constant is
  // frozen; the tenancy migration-parity spec asserts the two migrations and the runtime resolver
  // all agree on it, so changing it cannot pass unnoticed.

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "organizations" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"slug" varchar(64) NOT NULL, ` +
        `"name" varchar(200) NOT NULL, ` +
        `"isDefault" boolean NOT NULL DEFAULT (0), ` +
        `"plan" varchar(32) NOT NULL DEFAULT ('community'), ` +
        `"status" varchar(20) NOT NULL DEFAULT ('active'), ` +
        `"trialEndsAt" datetime, ` +
        `"settings" text, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_organizations_slug" ON "organizations" ("slug")`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_organizations_isDefault" ON "organizations" ("isDefault")`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "users" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"email" varchar(320) NOT NULL, ` +
        `"name" varchar(200) NOT NULL, ` +
        `"passwordHash" varchar(255), ` +
        `"isActive" boolean NOT NULL DEFAULT (1), ` +
        `"lastLoginAt" datetime, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_email" ON "users" ("email")`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "memberships" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"organizationId" varchar(36) NOT NULL, ` +
        `"userId" varchar(36) NOT NULL, ` +
        `"role" varchar(20) NOT NULL DEFAULT ('member'), ` +
        `"invitedAt" datetime, ` +
        `"acceptedAt" datetime, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_memberships_organizationId_userId" ON "memberships" ("organizationId", "userId")`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_memberships_userId" ON "memberships" ("userId")`);

    // The default organization, seeded here rather than at runtime so that a single-tenant install has
    // a real row to resolve against from the first boot — an install that only gets its default
    // organization when some request happens to create one would report usage against no tenant in
    // the meantime.
    //
    // `INSERT OR IGNORE` on the primary key makes this idempotent: re-running the migration, or
    // adopting it on a database a previous `synchronize: true` build already populated, must not fail
    // on the unique id. The other rows an operator may legitimately have added are untouched because
    // nothing is updated here.
    //
    // No user and no membership row are seeded: an operator's identity belongs to the auth surface
    // (API keys today), and inventing a placeholder user that no credential can log in as would be a
    // row that only ever confuses the first person to read the table.
    await queryRunner.query(
      `INSERT OR IGNORE INTO "organizations" (` +
        `"id", "slug", "name", "isDefault", "plan", "status", "settings", "createdAt", "updatedAt"` +
        `) VALUES (?, ?, ?, 1, 'community', 'active', NULL, datetime('now'), datetime('now'))`,
      [DEFAULT_ORGANIZATION_ID, DEFAULT_ORGANIZATION_SLUG, DEFAULT_ORGANIZATION_NAME],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The default organization is dropped with the table, but `sessions.organizationId` and
    // `usage_events.organizationId` live on the OTHER connection and still name this id. Reversing
    // this migration alone therefore leaves those columns dangling at an organization that no longer
    // exists, so the data-connection migrations must be reverted too — same order-independence the
    // rest of the schema split already has, and the reason no code may assume the id is present.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_memberships_userId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_memberships_organizationId_userId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "memberships"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_organizations_isDefault"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_organizations_slug"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "organizations"`);
  }
}
