import type {
  FlowBlock,
  FlowBlockType,
  MindMapEdge,
  MindMapPosition,
  Plan,
  PlanDraft,
  PlanMindMap,
} from '../types/plans';

let blockSeq = 0;

/** Copy a plan into a fresh draft — editable inputs must never bind to the stored object. */
export function planToDraft(plan: Plan): PlanDraft {
  // A plan's description is nullable on the wire; the draft owns a string, so a null reads as empty
  // rather than propagating into a controlled textarea's value.
  return { title: plan.title, description: plan.description ?? '' };
}

/** ---- Table selection ---- */

export function togglePlanId(selectedIds: readonly string[], id: string): string[] {
  return selectedIds.includes(id) ? selectedIds.filter(current => current !== id) : [...selectedIds, id];
}

/**
 * Select-all should be driven by the rows currently on screen, not by the stored ids: a plan
 * deleted elsewhere must not leave the header box reporting a selection it cannot act on.
 */
export function selectAllPlanIds(plans: readonly Plan[], selectedIds: readonly string[]): string[] {
  const listed = plans.map(plan => plan.id);
  return listed.every(id => selectedIds.includes(id)) ? [] : listed;
}

export function allPlanIdsSelected(plans: readonly Plan[], selectedIds: readonly string[]): boolean {
  return plans.length > 0 && plans.every(plan => selectedIds.includes(plan.id));
}

export function somePlanIdsSelected(plans: readonly Plan[], selectedIds: readonly string[]): boolean {
  return plans.some(plan => selectedIds.includes(plan.id));
}

/* ---- Flow blocks ---- */

/** Mint a unique block id. Sequence number guards against two blocks created in the same ms. */
function nextBlockId(): string {
  blockSeq += 1;
  return `block-${Date.now().toString(36)}-${blockSeq}`;
}

/**
 * Build an empty block of the given type.
 *
 * The yes/no labels are seeded by the caller: this layer has no access to i18n, and a hardcoded
 * "Yes" would render untranslated in every non-English locale.
 */
export function createFlowBlock(type: FlowBlockType, seed: { yes?: string; no?: string } = {}): FlowBlock {
  const id = nextBlockId();
  switch (type) {
    case 'text':
      return { id, type, text: '' };
    case 'image':
    case 'video':
      return { id, type, mediaUrl: '', caption: '' };
    case 'file':
      return { id, type, mediaUrl: '', filename: '', caption: '' };
    case 'poll':
      return { id, type, question: '', options: ['', ''] };
    case 'yesno':
      return { id, type, question: '', yesLabel: seed.yes ?? '', noLabel: seed.no ?? '' };
  }
}

/** The strings a starter example is written in; supplied by the caller so it reads in its locale. */
export interface ExampleFlowContent {
  greeting: string;
  question: string;
  option1: string;
  option2: string;
  confirm: string;
  yes: string;
  no: string;
  closing: string;
}

/**
 * A short, complete step-by-step flow — greet, ask, branch, confirm — that a first-time user can
 * load into an empty plan to see how blocks are meant to fit together, then edit.
 */
export function createExampleFlow(content: ExampleFlowContent): FlowBlock[] {
  return [
    { id: nextBlockId(), type: 'text', text: content.greeting },
    { id: nextBlockId(), type: 'poll', question: content.question, options: [content.option1, content.option2] },
    { id: nextBlockId(), type: 'yesno', question: content.confirm, yesLabel: content.yes, noLabel: content.no },
    { id: nextBlockId(), type: 'text', text: content.closing },
  ];
}

/**
 * Whether a block has everything it needs to actually send. Drives the per-block "incomplete"
 * hint — it is a hint, not a gate, because the flow saves continuously as you type.
 */
export function isFlowBlockComplete(block: FlowBlock): boolean {
  switch (block.type) {
    case 'text':
      return block.text.trim() !== '';
    case 'image':
    case 'video':
      return block.mediaUrl.trim() !== '';
    case 'file':
      return block.mediaUrl.trim() !== '';
    case 'poll':
      return block.question.trim() !== '' && block.options.filter(option => option.trim() !== '').length >= 2;
    case 'yesno':
      return block.question.trim() !== '' && block.yesLabel.trim() !== '' && block.noLabel.trim() !== '';
  }
}

/** Move a block one slot up (-1) or down (+1), clamped to the ends of the list. */
export function moveFlowBlock(blocks: readonly FlowBlock[], index: number, delta: -1 | 1): FlowBlock[] {
  const target = index + delta;
  if (target < 0 || target >= blocks.length) return [...blocks];
  const next = [...blocks];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/** Replace one block wholesale, leaving the rest of the flow untouched. */
export function replaceFlowBlock(blocks: readonly FlowBlock[], updated: FlowBlock): FlowBlock[] {
  return blocks.map(block => (block.id === updated.id ? updated : block));
}

export function removeFlowBlock(blocks: readonly FlowBlock[], id: string): FlowBlock[] {
  return blocks.filter(block => block.id !== id);
}

/**
 * Copy a block, content and all, directly after the original with a fresh id.
 *
 * A new id is the whole point: block ids are the join between the flow and the mind map, so reusing
 * one would give two nodes the same entry in `positions` and two messages on screen at once. The
 * copy keeps the content — duplicating a half-written block to finish both halves is the point — but
 * carries no position of its own, so the layout decides where it lands.
 */
export function duplicateFlowBlock(blocks: readonly FlowBlock[], id: string): FlowBlock[] {
  const index = blocks.findIndex(block => block.id === id);
  if (index === -1) return [...blocks];
  const copy = { ...blocks[index], id: nextBlockId() } as FlowBlock;
  return [...blocks.slice(0, index + 1), copy, ...blocks.slice(index + 1)];
}

/** A poll cannot have fewer than two options to choose between. */
export const MIN_POLL_OPTIONS = 2;

export function addPollOption(options: readonly string[]): string[] {
  return [...options, ''];
}

export function removePollOption(options: readonly string[], index: number): string[] {
  if (options.length <= MIN_POLL_OPTIONS) return [...options];
  return options.filter((_, current) => current !== index);
}

/* ---- Mind-map layout ---- */

/** Origin and row pitch the auto-layout uses; the canvas node box lives in `PlanMindMap`. */
const LAYOUT_X = 48;
const LAYOUT_Y = 48;
const LAYOUT_GAP_Y = 220;

let edgeSeq = 0;

/** The layout is parallel to the flow and may legitimately be empty. */
export function emptyMindMap(): PlanMindMap {
  return { positions: {}, edges: [] };
}

/** Where the block at `index` sits when it has never been placed by hand. */
export function autoLayoutPosition(index: number): MindMapPosition {
  return { x: LAYOUT_X, y: LAYOUT_Y + index * LAYOUT_GAP_Y };
}

/** A tidy single-column layout, in flow order, for blocks that have never been placed. */
export function autoLayoutPositions(blocks: readonly FlowBlock[]): Record<string, MindMapPosition> {
  const positions: Record<string, MindMapPosition> = {};
  blocks.forEach((block, index) => {
    positions[block.id] = autoLayoutPosition(index);
  });
  return positions;
}

/**
 * Reconcile a stored layout against the current blocks: place any block that lacks a position, and
 * drop positions/edges that name a block which no longer exists. Keeps node positions stable across
 * an autosave round-trip, so dragging is not undone by an unrelated edit.
 */
export function reconcileMindMap(blocks: readonly FlowBlock[], mindmap: PlanMindMap): PlanMindMap {
  const ids = new Set(blocks.map(block => block.id));
  const auto = autoLayoutPositions(blocks);
  const positions: Record<string, MindMapPosition> = {};
  for (const block of blocks) {
    positions[block.id] = mindmap.positions[block.id] ?? auto[block.id];
  }
  return {
    positions,
    edges: mindmap.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)),
  };
}

/** Ignore stored positions and lay every node out again in flow order, keeping drawn edges. */
export function autoArrangeMindMap(blocks: readonly FlowBlock[], mindmap: PlanMindMap): PlanMindMap {
  return { positions: autoLayoutPositions(blocks), edges: [...mindmap.edges] };
}

/** Move one node. Unknown ids are placed rather than dropped, so a drag always lands somewhere. */
export function moveMindMapNode(mindmap: PlanMindMap, id: string, position: MindMapPosition): PlanMindMap {
  return { ...mindmap, positions: { ...mindmap.positions, [id]: position } };
}

/** Add a directed connection, ignoring a self-link or one that already exists. */
export function addMindMapEdge(mindmap: PlanMindMap, from: string, to: string): PlanMindMap {
  if (from === to) return mindmap;
  if (mindmap.edges.some(edge => edge.from === from && edge.to === to)) return mindmap;
  edgeSeq += 1;
  const edge: MindMapEdge = { id: `edge-${Date.now().toString(36)}-${edgeSeq}`, from, to };
  return { ...mindmap, edges: [...mindmap.edges, edge] };
}

export function removeMindMapEdge(mindmap: PlanMindMap, edgeId: string): PlanMindMap {
  return { ...mindmap, edges: mindmap.edges.filter(edge => edge.id !== edgeId) };
}

/** A one-line preview of a block's own content, for a compact mind-map node. */
export function flowBlockPreview(block: FlowBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
    case 'video':
      return block.caption.trim() !== '' ? block.caption : block.mediaUrl;
    case 'file':
      return block.filename.trim() !== '' ? block.filename : block.mediaUrl;
    case 'poll':
      return block.question;
    case 'yesno':
      return block.question;
  }
}
