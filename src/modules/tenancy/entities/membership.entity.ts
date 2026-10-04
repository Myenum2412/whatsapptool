import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export enum MembershipRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  MEMBER = 'member',
  VIEWER = 'viewer',
}

/**
 * Joins a User to an Organization with a role. MAIN connection (always SQLite — column-types.ts).
 *
 * Many-to-many: a user may belong to several organizations, and each of those rows carries its own
 * role. The unique (organizationId, userId) index is what makes "one membership per pair" a
 * database guarantee rather than an application convention, so a duplicate invite cannot be written.
 *
 * Plain columns, no @ManyToOne relations — the same choice audit_logs makes for its provenance ids,
 * and for the same reason it matters here: a TypeORM relation emits an `FK_<hash>` constraint whose
 * name is derived from the table+column pair, which the hand-written main-connection migrations
 * would then have to reproduce byte-for-byte. The deletion rule is stated in the migration instead
 * (ON DELETE CASCADE, expressed as application logic because no route deletes a user or an
 * organization yet).
 */
@Entity('memberships')
// Class-level, not property-level: a property-level @Index is treated as covering that one property,
// so the composite uniqueness would have been declared on `organizationId` ALONE — which rejects the
// second and every later member of an organization. That failure is silent at the type level (the
// decorator compiles) and only shows up as a unique-constraint error at insert time, and the drift
// gate is what caught it here.
@Index('IDX_memberships_organizationId_userId', ['organizationId', 'userId'], { unique: true })
export class Membership {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  organizationId!: string;

  @Index('IDX_memberships_userId')
  @Column({ type: 'varchar', length: 36 })
  userId!: string;

  @Column({ type: 'varchar', length: 20, default: MembershipRole.MEMBER })
  role!: MembershipRole;

  // A second call to add a user who already has a membership must be a no-op, not an error, so the
  // membership upsert is an INSERT that tolerates the unique conflict.
  @Column({ type: 'datetime', nullable: true })
  invitedAt!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  acceptedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
