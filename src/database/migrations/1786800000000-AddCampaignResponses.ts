import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Campaign response options (a poll or numbered replies). The campaign keeps the question, options
 * and style; each recipient row keeps the id of the message it answers (looked up when a poll vote
 * arrives) and its latest answer. `chatId` is indexed for the typed-reply lookup, which starts from
 * the chat an inbound message came from.
 */
export class AddCampaignResponses1786800000000 implements MigrationInterface {
  name = 'AddCampaignResponses1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    const dateType = isPostgres ? 'timestamp' : 'text';
    const falseDefault = isPostgres ? 'false' : '(0)';

    const campaignColumns: Array<[string, string]> = [
      ['responseStyle', 'varchar'],
      ['responseQuestion', 'text'],
      ['responseOptions', 'text'],
      ['responseMultiple', `boolean NOT NULL DEFAULT ${falseDefault}`],
    ];
    for (const [name, type] of campaignColumns) {
      if (!(await queryRunner.hasColumn('campaigns', name))) {
        await queryRunner.query(`ALTER TABLE "campaigns" ADD COLUMN "${name}" ${type}`);
      }
    }

    const recipientColumns: Array<[string, string]> = [
      ['responseMessageId', 'varchar'],
      ['response', 'text'],
      ['responseVia', 'varchar'],
      ['respondedAt', dateType],
    ];
    for (const [name, type] of recipientColumns) {
      if (!(await queryRunner.hasColumn('campaign_recipients', name))) {
        await queryRunner.query(`ALTER TABLE "campaign_recipients" ADD COLUMN "${name}" ${type}`);
      }
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_campaign_recipients_responseMessageId" ON "campaign_recipients" ("responseMessageId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_campaign_recipients_chatId" ON "campaign_recipients" ("chatId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_campaign_recipients_chatId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_campaign_recipients_responseMessageId"`);
    for (const name of ['respondedAt', 'responseVia', 'response', 'responseMessageId']) {
      if (await queryRunner.hasColumn('campaign_recipients', name)) {
        await queryRunner.query(`ALTER TABLE "campaign_recipients" DROP COLUMN "${name}"`);
      }
    }
    for (const name of ['responseMultiple', 'responseOptions', 'responseQuestion', 'responseStyle']) {
      if (await queryRunner.hasColumn('campaigns', name)) {
        await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN "${name}"`);
      }
    }
  }
}
