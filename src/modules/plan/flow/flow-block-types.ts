/**
 * The block vocabulary of a plan's message flow.
 *
 * This lives in its own file because both sides need it and neither should depend on the other: the
 * entity types its `flow` column with this union, and the request DTOs validate incoming bodies
 * against it. An entity importing from `dto/` - or the reverse - would tie the persistence layer to
 * the request layer for the sake of a type.
 *
 * A discriminated union, mirroring the dashboard's `FlowBlock`: narrowing on `type` then guarantees
 * a media block has a `mediaUrl` and a poll block has `options`, so neither side can read a field
 * that was never validated.
 */

export const FLOW_BLOCK_TYPES = ['text', 'image', 'video', 'file', 'poll', 'yesno'] as const;

export type FlowBlockType = (typeof FLOW_BLOCK_TYPES)[number];

interface FlowBlockBase {
  /**
   * Client-minted and stable across a reorder, so a flow autosave update identifies the block it
   * replaces without the server needing to diff the whole list.
   */
  id: string;
}

/** A plain WhatsApp text message. */
export interface TextFlowBlock extends FlowBlockBase {
  type: 'text';
  text: string;
}

/** An image or a video, sent as a link. */
export interface MediaFlowBlock extends FlowBlockBase {
  type: 'image' | 'video';
  mediaUrl: string;
  caption: string;
}

/** A document (PDF, audio, office file…) sent as a downloadable attachment. */
export interface FileFlowBlock extends FlowBlockBase {
  type: 'file';
  mediaUrl: string;
  filename: string;
  caption: string;
}

/** An interactive poll. Options may be blank while the operator is still typing them. */
export interface PollFlowBlock extends FlowBlockBase {
  type: 'poll';
  question: string;
  options: string[];
}

/** A yes/no quick-reply pair. */
export interface YesNoFlowBlock extends FlowBlockBase {
  type: 'yesno';
  question: string;
  yesLabel: string;
  noLabel: string;
}

export type PlanFlowBlock = TextFlowBlock | MediaFlowBlock | FileFlowBlock | PollFlowBlock | YesNoFlowBlock;

/**
 * Per-field ceilings. Enforced on the way in so one block cannot grow the `flow` column without
 * bound; nothing queries inside the JSON, so these exist to cap a single payload, not to index it.
 */
export const FLOW_LIMITS = {
  /** Blocks per plan. A plan past this is a campaign, which has its own module and pacing. */
  blocks: 100,
  id: 64,
  text: 4096,
  mediaUrl: 2048,
  filename: 255,
  caption: 1024,
  question: 1024,
  option: 200,
  options: 12,
  label: 64,
} as const;

/** Plan column ceilings, kept here so the DTO and the migration cannot disagree about them. */
export const PLAN_TITLE_MAX_LENGTH = 100;
export const PLAN_DESCRIPTION_MAX_LENGTH = 1024;
