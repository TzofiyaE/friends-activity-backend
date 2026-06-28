import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropLegacySchemas1756100000000 implements MigrationInterface {
  name = 'DropLegacySchemas1756100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP SCHEMA IF EXISTS bronze CASCADE');
    await queryRunner.query('DROP SCHEMA IF EXISTS gold CASCADE');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE SCHEMA IF NOT EXISTS bronze');
    await queryRunner.query('CREATE SCHEMA IF NOT EXISTS gold');
  }
}
