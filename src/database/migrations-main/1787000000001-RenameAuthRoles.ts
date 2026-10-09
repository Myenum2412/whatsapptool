import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Collapses the three authorization roles (`admin`, `operator`, `viewer`) into two —
 * `orgmenu` (full power: key management, infrastructure, user provisioning) and `users`
 * (everything else) — on both the `api_keys` and `users` tables of the main connection.
 *
 * The enum members in code are now `orgmenu`/`users` (ApiKeyRole.ORG_MENU / ApiKeyRole.USER), so
 * any row still storing an old value would be unrecognised until this runs — and an unrecognised
 * role is rejected by the guard as unauthorized, i.e. a hard lockout rather than a demotion. Two
 * separate concerns, one migration:
 *
 *  1. Value remap — `admin` -> `orgmenu`; `operator`/`viewer` -> `users` — on both tables, so
 *     every existing row keeps exactly the power it had before the rename.
 *  2. Column default — SQLite cannot ALTER a column default, so `api_keys` is rebuilt with the
 *     new `DEFAULT ('users')`, keeping the chain end-state identical to the entity metadata (the
 *     migration-drift gate compares the two; a mismatch would surface as a spurious table rebuild
 *     on the next `migration:generate`). `users.role` is a brand-new column introduced by the
 *     still-unreleased AddUserRole with the `'users'` default directly, so only `api_keys` needs
 *     the rebuild.
 *
 * Runs on the **main** connection (auth/tenancy), always SQLite (app.module.ts hardcodes
 * `better-sqlite3`). The value remap is plain UPDATE and dialect-neutral; the rebuild is
 * SQLite-style DDL matching CreateTenancyTables, with a Postgres branch for the default. The
 * rebuild copies every existing row verbatim and recreates the unique `keyHash` index, and the
 * remap maps values onto themselves once the data is current, so the migration is safe on both a
 * pre-rename database and one already carrying the new roles.
 */
export class RenameAuthRoles1787000000001 implements MigrationInterface {
  name = 'RenameAuthRoles1787000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "users" SET "role" = 'orgmenu' WHERE "role" = 'admin'`);
    await queryRunner.query(`UPDATE "users" SET "role" = 'users' WHERE "role" IN ('operator', 'viewer')`);
    await queryRunner.query(`UPDATE "api_keys" SET "role" = 'orgmenu' WHERE "role" = 'admin'`);
    await queryRunner.query(`UPDATE "api_keys" SET "role" = 'users' WHERE "role" IN ('operator', 'viewer')`);

    if (queryRunner.connection.options.type === 'postgres') {
      await queryRunner.query(`ALTER TABLE "api_keys" ALTER COLUMN "role" SET DEFAULT 'users'`);
      return;
    }

    await this.rebuildApiKeys(queryRunner, "'users'");
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "api_keys" SET "role" = 'admin' WHERE "role" = 'orgmenu'`);
    await queryRunner.query(`UPDATE "api_keys" SET "role" = 'operator' WHERE "role" = 'users'`);

    if (queryRunner.connection.options.type === 'postgres') {
      await queryRunner.query(`ALTER TABLE "api_keys" ALTER COLUMN "role" SET DEFAULT 'operator'`);
      return;
    }

    await this.rebuildApiKeys(queryRunner, "'operator'");
  }

  private async rebuildApiKeys(queryRunner: QueryRunner, defaultLiteral: string): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "api_keys_tmp" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"name" varchar(100) NOT NULL, ` +
        `"keyHash" varchar(64) NOT NULL, ` +
        `"keyPrefix" varchar(12) NOT NULL, ` +
        `"role" varchar(20) NOT NULL DEFAULT (${defaultLiteral}), ` +
        `"allowedIps" text, ` +
        `"allowedSessions" text, ` +
        `"allowedChats" text, ` +
        `"isActive" boolean NOT NULL DEFAULT (1), ` +
        `"expiresAt" datetime, ` +
        `"lastUsedAt" datetime, ` +
        `"usageCount" integer NOT NULL DEFAULT (0), ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(
      `INSERT INTO "api_keys_tmp" (` +
        `"id", "name", "keyHash", "keyPrefix", "role", "allowedIps", "allowedSessions", "allowedChats", ` +
        `"isActive", "expiresAt", "lastUsedAt", "usageCount", "createdAt", "updatedAt"` +
        `) SELECT ` +
        `"id", "name", "keyHash", "keyPrefix", "role", "allowedIps", "allowedSessions", "allowedChats", ` +
        `"isActive", "expiresAt", "lastUsedAt", "usageCount", "createdAt", "updatedAt" FROM "api_keys"`,
    );
    await queryRunner.query(`DROP TABLE "api_keys"`);
    await queryRunner.query(`ALTER TABLE "api_keys_tmp" RENAME TO "api_keys"`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_api_keys_keyHash" ON "api_keys" ("keyHash")`);
  }
}
