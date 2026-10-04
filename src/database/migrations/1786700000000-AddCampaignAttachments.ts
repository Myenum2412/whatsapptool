import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Uploaded campaign attachments. `campaign_attachments` holds one row per uploaded file (the bytes
 * live in the storage backend under `storageKey`), and `campaign_recipients.attachmentName` records
 * which uploaded file a row's attachment cell names, so an upload or removal can update exactly the
 * rows that wait for it. FK name matches what TypeORM derives from the entity (no drift).
 */
export class AddCampaignAttachments1786700000000 implements MigrationInterface {
  name = 'AddCampaignAttachments1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (!(await queryRunner.hasTable('campaign_attachments'))) {
      if (isPostgres) {
        await queryRunner.query(
          `CREATE TABLE "campaign_attachments" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
            `"campaignId" varchar NOT NULL, "scope" varchar NOT NULL, "filename" varchar(255) NOT NULL, ` +
            `"normalizedName" varchar(255) NOT NULL, "mimetype" varchar(255) NOT NULL, "sizeBytes" integer NOT NULL, ` +
            `"storageKey" varchar(500) NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now(), "position" integer NOT NULL DEFAULT 0, ` +
            `CONSTRAINT "FK_e2efa973f0a10c2c5b57ad56bea" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
        );
      } else {
        await queryRunner.query(
          `CREATE TABLE "campaign_attachments" ("id" varchar PRIMARY KEY NOT NULL, "campaignId" varchar NOT NULL, ` +
            `"scope" varchar NOT NULL, "filename" varchar(255) NOT NULL, "normalizedName" varchar(255) NOT NULL, ` +
            `"mimetype" varchar(255) NOT NULL, "sizeBytes" integer NOT NULL, "storageKey" varchar(500) NOT NULL, ` +
            `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "position" integer NOT NULL DEFAULT (0), ` +
            `CONSTRAINT "FK_e2efa973f0a10c2c5b57ad56bea" FOREIGN KEY ("campaignId") REFERENCES "campaigns" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
        );
      }
      await queryRunner.query(
        `CREATE UNIQUE INDEX "IDX_campaign_attachments_campaign_name" ON "campaign_attachments" ("campaignId", "normalizedName")`,
      );
    }

    if (!(await queryRunner.hasColumn('campaign_recipients', 'attachmentName'))) {
      await queryRunner.query(`ALTER TABLE "campaign_recipients" ADD COLUMN "attachmentName" varchar(255)`);
      await queryRunner.query(
        `CREATE INDEX "IDX_campaign_recipients_campaign_attachment" ON "campaign_recipients" ("campaignId", "attachmentName")`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_campaign_recipients_campaign_attachment"`);
    if (await queryRunner.hasColumn('campaign_recipients', 'attachmentName')) {
      await queryRunner.query(`ALTER TABLE "campaign_recipients" DROP COLUMN "attachmentName"`);
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_campaign_attachments_campaign_name"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "campaign_attachments"`);
  }
}
