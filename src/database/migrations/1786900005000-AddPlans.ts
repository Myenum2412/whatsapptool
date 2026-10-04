import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `plans` table backing the dashboard's `/flow` plan builder.
 *
 * Each plan belongs to a session via a CASCADE foreign key, so plans are removed when their session
 * is deleted. `flow` is a `text` column holding the JSON-stringified ordered block list, matching the
 * entity's `simple-json` column: it must NOT be `jsonb`, because the pg driver only auto-parses real
 * JSON columns and a `jsonb`-typed entity reading an actual `text` column hands back a raw string.
 * `mindmap` is a second such column, holding the parallel node-position/edge layout over the flow.
 *
 * Hand-authored because `synchronize` is disabled for the `data` connection on PostgreSQL (and may be
 * disabled on SQLite via DATABASE_SYNCHRONIZE=false).
 *
 * The FK constraint is named with TypeORM's own hash (`FK_<sha1>`) rather than the readable
 * `FK_plans_sessionId` that AddTemplates uses. Both work at runtime, but the hash is what
 * `synchronize` emits for this entity, so naming it that way leaves this table contributing NO
 * pinned migration drift. AddTemplates predates that and its readable name is pinned in
 * `known-migration-drift.json`; adding new pinned drift for a brand-new table would just be debt.
 */
export class AddPlans1786900005000 implements MigrationInterface {
  name = 'AddPlans1786900005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    const exists = await queryRunner.hasTable('plans');
    if (exists) return;

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "plans" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, "sessionId" varchar NOT NULL, "title" varchar(100) NOT NULL, "description" text, "flow" text NOT NULL DEFAULT ('[]'), "mindmap" text NOT NULL DEFAULT ('{"positions":{},"edges":[]}'), "createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), CONSTRAINT "FK_143d7ec580d7f5074bafd59c6ff" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "plans" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "title" varchar(100) NOT NULL, "description" text, "flow" text NOT NULL DEFAULT ('[]'), "mindmap" text NOT NULL DEFAULT ('{"positions":{},"edges":[]}'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_143d7ec580d7f5074bafd59c6ff" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
    }

    // Only the composite unique index the entity declares. A standalone index on sessionId is NOT
    // created here even though AddTemplates makes one: the composite's leading column already serves
    // every session-scoped lookup, so the extra index is a redundant write cost. TypeORM does not
    // synthesise an index for the relation's join column, so adding one here would be drift.
    await queryRunner.query(`CREATE UNIQUE INDEX "IDX_plans_session_title" ON "plans" ("sessionId", "title")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS so revert is idempotent on a synchronize-bootstrapped DB, where this migration was
    // recorded via the up() hasTable early-return and the named index was never created.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_plans_session_title"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "plans"`);
  }
}
