import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * A tenant. Every session, API key-backed actor and billable event resolves to exactly one.
 *
 * MAIN connection (always SQLite — see common/utils/column-types.ts): the control plane holds
 * identity, not activity, so it is small, low-write and must survive a data-DB rebuild.
 *
 * There is no FK from this table to anything: `usage_events.organizationId` and
 * `sessions.organizationId` live on the DATA connection and cannot reference a main-connection
 * table, so referential integrity across the split is enforced by the application
 * (tenancy.service.ts resolves an organization before it is written), not by the database.
 */
@Entity('organizations')
export class Organization {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Unique so a dashboard URL can name an organization without an id, and stable across restarts
  // (unlike `name`, which an operator may edit freely).
  @Index('IDX_organizations_slug', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  slug!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  /**
   * Marks the single organization a single-tenant deployment runs as. Indexed (not unique) because
   * SQLite/Postgres cannot both express "exactly one true row" portably: a partial unique index would
   * be correct on Postgres but the main connection is always SQLite. Uniqueness is instead enforced
   * by construction — the default row is seeded with a fixed id by CreateTenancyTables and no route
   * may create a second one.
   */
  @Index('IDX_organizations_isDefault')
  @Column({ type: 'boolean', default: false })
  isDefault!: boolean;

  /**
   * Commercial tier. NOT a billing source of truth — usage_events is — so it is stored as a plain
   * label that an operator or a later billing integration sets. 'community' is the free
   * self-hosted default and must stay the migration default: a fresh install cannot land on a paid
   * tier by accident.
   */
  @Column({ type: 'varchar', length: 32, default: 'community' })
  plan!: string;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status!: string;

  // `datetime`, not dateColumnType(): the main connection is ALWAYS SQLite, so the data-connection
  // dialect helper must never be called here (it would emit `timestamp` and break a SQLite main DB
  // whenever DATABASE_TYPE=postgres).
  @Column({ type: 'datetime', nullable: true })
  trialEndsAt!: Date | null;

  // simple-json, not jsonColumnType(): same reason as the date column above.
  @Column({ type: 'simple-json', nullable: true })
  settings!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
