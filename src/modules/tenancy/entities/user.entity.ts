import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * Sign-in roles. Same two values as ApiKeyRole — login mirrors `User.role` onto the user's key.
 * `orgmenu` is the full-power tier (seeded bootstrap admin, user provisioning); `users` is every
 * other signed-in account.
 */
export enum UserRole {
  ORG_MENU = 'orgmenu',
  USER = 'users',
}

/**
 * Dashboard sign-in identity. MAIN connection (always SQLite — see common/utils/column-types.ts).
 *
 * `passwordHash` holds a self-describing scrypt hash (see modules/auth/password-hash.ts) produced
 * by POST /api/auth/login's seeding and login flow; it is nullable so API-only deployments never
 * need a credential row. `role` is the authorization source of truth for a human sign-in: login
 * mirrors it onto the user's own API-key row (`user:<email>`), which is what the existing
 * X-API-Key guard then enforces.
 *
 * Email uniqueness is enforced by the DB (NOT normalized): `A@b.com` and `a@b.com` are two rows.
 * Sign-in therefore normalizes (trim + lowercase) BEFORE the lookup, so an account can only be
 * reached through its normalized form — the index alone does not do it.
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

  /** Pre-existing rows (created before sign-in existed) default to least privilege. */
  @Column({ type: 'varchar', length: 20, default: UserRole.USER })
  role!: UserRole;

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
