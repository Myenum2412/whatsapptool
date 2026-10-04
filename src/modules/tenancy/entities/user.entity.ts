import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * A named human operator. MAIN connection (always SQLite — see common/utils/column-types.ts).
 *
 * Deliberately NOT an authentication credential source yet: there is no login route in this
 * increment, so nothing here can be used to authenticate. `passwordHash` exists so the column does
 * not have to be added later under a migration while rows exist, and it is nullable because the
 * supported auth model for now remains an API key (see ApiKeyRole).
 *
 * Email uniqueness is enforced by the DB (not normalized), so `A@b.com` and `a@b.com` are two rows.
 * Sign-in is out of scope for this increment; whoever builds it must normalize first, and this
 * comment is the warning that the index alone does not do it.
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_users_email', { unique: true })
  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  passwordHash!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  // `datetime`, not dateColumnType(): the main connection is ALWAYS SQLite (column-types.ts).
  @Column({ type: 'datetime', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
