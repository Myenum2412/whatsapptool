import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `api_keys.ownerUserId` on the **main** connection — the dashboard account (`users.id`) a
 * sign-in minted the key for. NULL means hand-minted operator key (the account-private FIFO from the
 * sessions side: see AddSessionOwnerUserId, which adds the matching column on the `data` connection).
 *
 * Runs AFTER RenameAuthRoles (1787000000001), whose api_keys table rebuild copies a fixed column
 * list; a later timestamp guarantees this column is added to the rebuilt table, never dropped by it.
 *
 * NULLABLE so existing rows (hand-minted keys) stay NULL, and idempotent: the column is probed before
 * the ALTER (same shape as AddUserRole), so an interrupted run and a synchronize-created DB are both
 * safe to adopt.
 */
export class AddApiKeyOwnerUserId1787000002000 implements MigrationInterface {
  name = 'AddApiKeyOwnerUserId1787000002000';

  private async hasColumn(queryRunner: QueryRunner, name: string): Promise<boolean> {
    if (queryRunner.connection.options.type === 'postgres') {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'api_keys' AND column_name = '${name}'`,
      )) as unknown[];
      return rows.length > 0;
    }
    const rows = (await queryRunner.query(`PRAGMA table_info("api_keys")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(queryRunner, 'ownerUserId'))) {
      await queryRunner.query(`ALTER TABLE "api_keys" ADD COLUMN "ownerUserId" varchar(36) NULL`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasColumn(queryRunner, 'ownerUserId')) {
      await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN "ownerUserId"`);
    }
  }
}
