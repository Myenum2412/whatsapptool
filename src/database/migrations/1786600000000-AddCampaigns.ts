import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `campaigns` and `campaign_recipients` — mail-merge sends (one template rendered per
 * spreadsheet row). JSON columns are plain text (`simple-json` on both dialects, never jsonb), and
 * the FK names are the ones TypeORM derives from the entities so the chain-built and
 * synchronize-built schemas match. `sessions` → `campaigns` → `campaign_recipients` cascade on
 * delete: a campaign means nothing without its session, a row nothing without its campaign.
 * Hand-authored because `synchronize` is off on the `data` connection for Postgres.
 */
export class AddCampaigns1786600000000 implements MigrationInterface {
  name = 'AddCampaigns1786600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (!(await queryRunner.hasTable('campaigns'))) {
      if (isPostgres) {
        await queryRunner.query(
          `CREATE TABLE "campaigns" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
            `"sessionId" varchar NOT NULL, "name" varchar(100) NOT NULL, "status" varchar NOT NULL DEFAULT 'draft', ` +
            `"pauseReason" varchar, "templateId" varchar, "header" text, "body" text NOT NULL, "footer" text, ` +
            `"columns" text NOT NULL, "phoneColumn" varchar(200) NOT NULL, "mediaColumn" varchar(200), ` +
            `"mediaType" varchar NOT NULL DEFAULT 'auto', "delayMs" integer NOT NULL DEFAULT 5000, ` +
            `"randomizeDelay" boolean NOT NULL DEFAULT true, "progress" text NOT NULL, "sourceFilename" varchar(255), ` +
            `"createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now(), ` +
            `"startedAt" timestamp, "completedAt" timestamp, ` +
            `CONSTRAINT "FK_e2f4f52f1c6344b6cc9af37f036" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
        );
      } else {
        await queryRunner.query(
          `CREATE TABLE "campaigns" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, ` +
            `"name" varchar(100) NOT NULL, "status" varchar NOT NULL DEFAULT ('draft'), "pauseReason" varchar, ` +
            `"templateId" varchar, "header" text, "body" text NOT NULL, "footer" text, "columns" text NOT NULL, ` +
            `"phoneColumn" varchar(200) NOT NULL, "mediaColumn" varchar(200), "mediaType" varchar NOT NULL DEFAULT ('auto'), ` +
            `"delayMs" integer NOT NULL DEFAULT (5000), "randomizeDelay" boolean NOT NULL DEFAULT (1), ` +
            `"progress" text NOT NULL, "sourceFilename" varchar(255), ` +
            `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
            `"startedAt" text, "completedAt" text, ` +
            `CONSTRAINT "FK_e2f4f52f1c6344b6cc9af37f036" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
        );
      }
      await queryRunner.query(`CREATE INDEX "IDX_campaigns_sessionId" ON "campaigns" ("sessionId")`);
    }

    if (!(await queryRunner.hasTable('campaign_recipients'))) {
      if (isPostgres) {
        await queryRunner.query(
          `CREATE TABLE "campaign_recipients" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
            `"campaignId" varchar NOT NULL, "rowNumber" integer NOT NULL, "chatId" varchar, "variables" text NOT NULL, ` +
            `"status" varchar NOT NULL DEFAULT 'pending', "errorCode" varchar, "errorMessage" text, "messageId" varchar, ` +
            `"sentAt" timestamp, ` +
            `CONSTRAINT "FK_3e9c3dcf81739170d74e9265e1b" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
        );
      } else {
        await queryRunner.query(
          `CREATE TABLE "campaign_recipients" ("id" varchar PRIMARY KEY NOT NULL, "campaignId" varchar NOT NULL, ` +
            `"rowNumber" integer NOT NULL, "chatId" varchar, "variables" text NOT NULL, ` +
            `"status" varchar NOT NULL DEFAULT ('pending'), "errorCode" varchar, "errorMessage" text, "messageId" varchar, ` +
            `"sentAt" text, ` +
            `CONSTRAINT "FK_3e9c3dcf81739170d74e9265e1b" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
        );
      }
      await queryRunner.query(
        `CREATE INDEX "IDX_campaign_recipients_campaign_status_row" ON "campaign_recipients" ("campaignId", "status", "rowNumber")`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_campaign_recipients_campaign_status_row"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "campaign_recipients"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_campaigns_sessionId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "campaigns"`);
  }
}
