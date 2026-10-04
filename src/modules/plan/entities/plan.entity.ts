import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Session } from '../../session/entities/session.entity';
import { jsonColumnType } from '../../../common/utils/column-types';
import { PLAN_TITLE_MAX_LENGTH, PlanFlowBlock } from '../flow/flow-block-types';
// `import type` is required: `emitDecoratorMetadata` references the declared type of the decorated
// `mindmap` property, and `PlanMindMap` has no runtime value.
import type { PlanMindMap } from '../flow/mind-map-types';

// One plan title per session: the dashboard's table addresses a plan by id, so this only exists to
// reject an accidental duplicate rather than to resolve by name. Mirrored by the AddPlans migration.
@Index('IDX_plans_session_title', ['sessionId', 'title'], { unique: true })
@Entity('plans')
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // varchar (not uuid) to match the authoritative migration DDL and sessions.id; the data connection
  // runs synchronize:false, so a 'uuid' decorator here would only mislead schema diffs / a stray sync.
  @Column({ type: 'varchar' })
  sessionId!: string;

  // CASCADE, so deleting a session takes its plans with it rather than orphaning a flow that can
  // never be reached again through the session-scoped routes.
  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session!: Session;

  @Column({ type: 'varchar', length: PLAN_TITLE_MAX_LENGTH })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /**
   * The message flow, as the ordered block list the dashboard's /flow editor writes.
   *
   * simple-json, not a native JSON column: the block vocabulary is a discriminated union that this
   * codebase validates in JS (see `flow-block-validator.ts`), nothing queries inside it, and a
   * `jsonb` column would return raw strings through the pg driver. See `column-types.ts`.
   *
   * Defaults to the empty flow, so a plan is creatable from the title/description form alone and the
   * flow can be built afterwards on its own page.
   */
  @Column({ type: jsonColumnType(), default: '[]' })
  flow!: PlanFlowBlock[];

  /**
   * The mind-map layout over the same blocks (node positions + drawn connections). Stored in its own
   * `simple-json` column, parallel to `flow`, for the same reason: nothing queries inside it and the
   * shape is validated in JS. It carries no message content — nodes are addressed by block id — so a
   * plan remains fully sendable even if the operator has never opened the map view.
   */
  @Column({ type: jsonColumnType(), default: '{"positions":{},"edges":[]}' })
  mindmap!: PlanMindMap;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
