/**
 * The persisted layout of a plan's mind-map view.
 *
 * The map owns no content of its own: every node is a block from the plan's `flow`, addressed by its
 * id, so the two views cannot drift apart. What is stored here is only what the ordered block array
 * cannot express — where the operator placed each node, and which nodes are joined by a drawn line.
 *
 * Sending is unchanged. The blocks are still the messages and their array order is still the send
 * order; the map is a spatial editor over that same list, not a second send path.
 */

/** A node's top-left corner, in canvas pixels relative to the map's origin. */
export interface MindMapPosition {
  x: number;
  y: number;
}

/** A drawn connection between two blocks. `from`/`to` are block ids. */
export interface MindMapEdge {
  id: string;
  from: string;
  to: string;
}

export interface PlanMindMap {
  /** Keyed by block id. A block with no entry is laid out by the dashboard on first render. */
  positions: Record<string, MindMapPosition>;
  /** Drawn connections. The dashboard defaults to a chain over the block order. */
  edges: MindMapEdge[];
}

/**
 * Bounds. A coordinate is "far outside any sane canvas" rather than a layout opinion; the edge count
 * is a payload cap, not a graph-theory limit. Kept beside the types so the DTO and the migration
 * cannot disagree about them.
 */
export const MIND_MAP_LIMITS = {
  coordinate: 1_000_000,
  edges: 200,
  edgeId: 64,
} as const;

/** The empty layout, stored as the column default and used when a plan is created without one. */
export function emptyMindMap(): PlanMindMap {
  return { positions: {}, edges: [] };
}
