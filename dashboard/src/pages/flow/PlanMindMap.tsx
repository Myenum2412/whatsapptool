import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ChevronDown, ChevronUp, Copy, Link2, Trash2, X } from 'lucide-react';
import {
  addMindMapEdge,
  autoArrangeMindMap,
  moveFlowBlock,
  moveMindMapNode,
  reconcileMindMap,
  removeMindMapEdge,
} from '../../utils/plans';
import { BlockFields, type MediaUploader } from './FlowBlockFields';
import { BLOCK_ICONS, BLOCK_TYPE_KEYS } from './flowBlockMeta';
import { FlowCardMediaUpload } from './FlowCardMediaUpload';
import { FlowMediaThumb } from './FlowMedia';
import { NodeInlineField, NodeSummary } from './FlowNodeInlineFields';
import type { FlowBlock, MindMapPosition, PlanMindMap } from '../../types/plans';

/** Node box, in canvas pixels. Kept in step with the `LAYOUT_*` constants in `utils/plans.ts`. */
const NODE_WIDTH = 280;
const NODE_HEIGHT = 160;
const CANVAS_PADDING = 56;
const MIN_CANVAS_WIDTH = 1000;
const MIN_CANVAS_HEIGHT = 600;

interface DragState {
  id: string;
  dx: number;
  dy: number;
}

/** An in-progress connection: where it started, where the pointer is, and which node it is over. */
interface ConnectState {
  fromId: string;
  pointer: MindMapPosition;
  overId: string | null;
}

/** Pointer capture throws for a stale id, and jsdom does not implement it at all. */
function capturePointer(element: Element, pointerId: number): void {
  if (typeof element.setPointerCapture !== 'function') return;
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Ignore: without capture the handlers still run, the gesture is just less forgiving.
  }
}

/** The block shapes that own a media hero on a card: an image, a video or a document. */
function isMediaBlock(block: FlowBlock): block is Extract<FlowBlock, { type: 'image' | 'video' | 'file' }> {
  return block.type === 'image' || block.type === 'video' || block.type === 'file';
}

/** True when the press landed on a control that owns the gesture, rather than on the card itself. */
function isControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-node-control]') !== null;
}

/** The selected edge, if it still exists: removing a node drops its edges in the reconciliation. */
function selectedEdgeOf(mindmap: PlanMindMap, edgeId: string | null): PlanMindMap['edges'][number] | null {
  if (edgeId === null) return null;
  return mindmap.edges.find(edge => edge.id === edgeId) ?? null;
}

/**
 * Name an edge by the blocks it joins, the same wording the remove button on the line itself uses.
 * Falls back to a bare delete when a block has gone and the pair can no longer be named.
 */
function edgeLabel(t: TFunction, blocks: readonly FlowBlock[], edge: PlanMindMap['edges'][number]): string {
  const from = blocks.find(block => block.id === edge.from);
  const to = blocks.find(block => block.id === edge.to);
  if (!from || !to) return t('common.delete');
  return t('flow.map.removeEdgeFor', { from: t(BLOCK_TYPE_KEYS[from.type]), to: t(BLOCK_TYPE_KEYS[to.type]) });
}

/**
 * The mind map: a spatial view of the same blocks the list view edits.
 *
 * It is a *view*, not a second document: nodes are blocks addressed by id, positions and edges are
 * the only thing stored here, and content is edited on the card and in the side panel through the
 * same `BlockFields` the list uses. Dragging a node, connecting two, or auto-arranging writes the
 * layout through immediately; content edits are debounced by the caller.
 *
 * Every node is also a small editor. The card shows the media full-bleed, floats its type chip over
 * it, and edits the one field the block is about in place, so the common case — read a node, fix a
 * word — never needs the panel. The actions that change the *flow* rather than the content (reorder,
 * duplicate, delete, rewire an edge) sit on the card and in the panel, so the chart is not a
 * read-only view of something only the list can change.
 *
 * Connecting is a direct drag: press the dot on the bottom edge of a block, and a live line follows
 * the cursor until it is released on another block. A drawn edge can be clicked to select it and then
 * removed with the button at its midpoint or the Delete key.
 */
export function PlanMindMap({
  blocks,
  mindmap,
  onLayoutChange,
  onBlockChange,
  onFlowChange,
  onDuplicateBlock,
  onUploadMedia,
  onCanvasDrop,
}: {
  blocks: FlowBlock[];
  mindmap: PlanMindMap;
  onLayoutChange: (next: PlanMindMap, immediate: boolean) => void;
  onBlockChange: (next: FlowBlock) => void;
  /** A structural edit to the block list — reorder or delete — written through immediately. */
  onFlowChange: (next: FlowBlock[]) => void;
  /** Copy a block into the flow *and* place its node, since a block without a position has none. */
  onDuplicateBlock: (id: string) => string | undefined;
  onUploadMedia: MediaUploader;
  onCanvasDrop: (position: MindMapPosition) => void;
}) {
  const { t } = useTranslation();
  const markerBase = `flow-map-arrow-${useId().replace(/:/g, '')}`;
  const edgeMarker = `${markerBase}-edge`;
  const autoMarker = `${markerBase}-auto`;
  const connectMarker = `${markerBase}-connect`;
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connect, setConnect] = useState<ConnectState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dragPosition, setDragPosition] = useState<MindMapPosition | null>(null);

  // Place any block that lacks a position and drop references to blocks that are gone, so the map
  // stays consistent with the list without persisting a cleanup on every unrelated edit.
  const reconciled = useMemo(() => reconcileMindMap(blocks, mindmap), [blocks, mindmap]);

  const positionOf = (id: string): MindMapPosition =>
    drag?.id === id && dragPosition ? dragPosition : (reconciled.positions[id] ?? { x: 0, y: 0 });

  let maxX = MIN_CANVAS_WIDTH - CANVAS_PADDING;
  let maxY = MIN_CANVAS_HEIGHT - CANVAS_PADDING;
  for (const block of blocks) {
    const position = positionOf(block.id);
    maxX = Math.max(maxX, position.x + NODE_WIDTH);
    maxY = Math.max(maxY, position.y + NODE_HEIGHT);
  }
  const canvasWidth = maxX + CANVAS_PADDING;
  const canvasHeight = maxY + CANVAS_PADDING;

  useEffect(() => {
    if (!connect) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConnect(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [connect]);

  const typeName = (block: FlowBlock) => t(BLOCK_TYPE_KEYS[block.type]);

  // Canvas-local point from a viewport point, so hit-testing and the live line share one space.
  const toCanvasPoint = (clientX: number, clientY: number): MindMapPosition => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  // Which node sits under a canvas point, topmost first. Geometry rather than DOM hit-testing, since
  // the pointer is captured by the source handle for the whole gesture.
  const nodeAt = (point: MindMapPosition): string | null => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const id = blocks[index].id;
      const position = positionOf(id);
      if (
        point.x >= position.x &&
        point.x <= position.x + NODE_WIDTH &&
        point.y >= position.y &&
        point.y <= position.y + NODE_HEIGHT
      ) {
        return id;
      }
    }
    return null;
  };

  const onNodePointerDown = (event: ReactPointerEvent<HTMLDivElement>, block: FlowBlock) => {
    // A press on a field or an action belongs to that control, not to the drag.
    if (isControlTarget(event.target)) return;
    capturePointer(event.currentTarget, event.pointerId);
    const position = positionOf(block.id);
    setDrag({ id: block.id, dx: event.clientX - position.x, dy: event.clientY - position.y });
    setDragPosition(position);
  };

  const onNodePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDragPosition({ x: event.clientX - drag.dx, y: event.clientY - drag.dy });
  };

  const onNodePointerUp = () => {
    if (drag && dragPosition) {
      const original = reconciled.positions[drag.id] ?? { x: 0, y: 0 };
      // A plain click presses and releases without moving; do not write a layout it did not change.
      if (dragPosition.x !== original.x || dragPosition.y !== original.y) {
        onLayoutChange(moveMindMapNode(reconciled, drag.id, dragPosition), true);
      }
    }
    setDrag(null);
    setDragPosition(null);
  };

  const onPortPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, block: FlowBlock) => {
    event.preventDefault();
    event.stopPropagation();
    capturePointer(event.currentTarget, event.pointerId);
    setConnect({ fromId: block.id, pointer: toCanvasPoint(event.clientX, event.clientY), overId: null });
  };

  const onPortPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!connect) return;
    const pointer = toCanvasPoint(event.clientX, event.clientY);
    const over = nodeAt(pointer);
    setConnect(current => (current ? { ...current, pointer, overId: over === current.fromId ? null : over } : current));
  };

  const onPortPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!connect) return;
    const target = nodeAt(toCanvasPoint(event.clientX, event.clientY));
    if (target && target !== connect.fromId) {
      onLayoutChange(addMindMapEdge(reconciled, connect.fromId, target), true);
      setSelectedId(target);
    }
    setConnect(null);
  };

  const onCanvasDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    // Accept every drag over the canvas and let the drop decide. Browsers disagree about what
    // `dataTransfer.types` exposes mid-drag, and gating on it silently rejected valid drops.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  const onCanvasDropAt = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    // A drop event without usable coordinates (some synthetic/assistive paths) lands at the origin
    // rather than seeding the layout with NaN.
    const clientX = Number.isFinite(event.clientX) ? event.clientX : 0;
    const clientY = Number.isFinite(event.clientY) ? event.clientY : 0;
    // Center the node on the cursor rather than hanging it off the pointer's corner.
    onCanvasDrop({
      x: Math.max(0, Math.round(clientX - rect.left - NODE_WIDTH / 2)),
      y: Math.max(0, Math.round(clientY - rect.top - NODE_HEIGHT / 2)),
    });
  };

  const selectedBlock = blocks.find(block => block.id === selectedId) ?? null;
  const selectedIndex = selectedBlock ? blocks.findIndex(block => block.id === selectedBlock.id) : -1;
  const connectSource = connect ? (blocks.find(block => block.id === connect.fromId) ?? null) : null;

  /* ---- Structural actions on a node ---- */

  const removeBlock = (block: FlowBlock) => {
    onFlowChange(blocks.filter(candidate => candidate.id !== block.id));
    setSelectedId(null);
  };

  const reorderBlock = (block: FlowBlock, delta: -1 | 1) => {
    const index = blocks.findIndex(candidate => candidate.id === block.id);
    if (index === -1 || index + delta < 0 || index + delta >= blocks.length) return;
    onFlowChange(moveFlowBlock(blocks, index, delta));
  };

  const duplicateBlock = (block: FlowBlock) => {
    // The parent owns the copy: it is the only layer that can place the new node, and it reports the
    // new id back so the chart can select what it just made.
    const copyId = onDuplicateBlock(block.id);
    if (copyId) setSelectedId(copyId);
  };

  const removeEdge = (edgeId: string) => {
    onLayoutChange(removeMindMapEdge(reconciled, edgeId), true);
    setSelectedEdgeId(null);
  };

  /* ---- Edge selection ---- */

  // A selected edge is only selected while it still exists: deleting one of its nodes drops the edge
  // in the reconciliation, and a dangling id would have the Delete key write a no-op layout.
  const activeEdge = selectedEdgeOf(reconciled, selectedEdgeId);
  const activeEdgeId = activeEdge?.id ?? null;

  useEffect(() => {
    if (!activeEdgeId) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedEdgeId(null);
        return;
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      // Typing in a node's field is not a request to delete a line.
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null) return;
      event.preventDefault();
      onLayoutChange(removeMindMapEdge(reconciled, activeEdgeId), true);
      setSelectedEdgeId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeEdgeId, reconciled, onLayoutChange]);

  const edgeGeometry = (edge: PlanMindMap['edges'][number]) => {
    const from = positionOf(edge.from);
    const to = positionOf(edge.to);
    return {
      x1: from.x + NODE_WIDTH / 2,
      y1: from.y + NODE_HEIGHT,
      x2: to.x + NODE_WIDTH / 2,
      y2: to.y,
      midX: (from.x + to.x + NODE_WIDTH) / 2,
      midY: (from.y + NODE_HEIGHT + to.y) / 2,
    };
  };

  // The live line snaps to the hovered target's top edge, so the release point is unambiguous.
  const connectEnd: MindMapPosition | null = connect
    ? connect.overId
      ? { x: positionOf(connect.overId).x + NODE_WIDTH / 2, y: positionOf(connect.overId).y }
      : connect.pointer
    : null;
  const connectStart = connect ? positionOf(connect.fromId) : null;

  // The flow reads top-to-bottom, so link each consecutive pair even when the user has not drawn a
  // connection. These are derived, never persisted, and skipped where a manual edge already links
  // the pair so the two lines never stack on top of each other.
  const drawnPairs = new Set(reconciled.edges.map(edge => `${edge.from}->${edge.to}`));
  const autoEdges = blocks.slice(0, -1).flatMap((block, index) => {
    const from = block.id;
    const to = blocks[index + 1].id;
    if (drawnPairs.has(`${from}->${to}`) || drawnPairs.has(`${to}->${from}`)) return [];
    return [{ id: `auto:${from}:${to}`, from, to }];
  });

  return (
    <div className="plan-flow-map">
      <div className="flow-map-toolbar">
        <button
          type="button"
          className="btn-secondary flow-map-auto"
          onClick={() => onLayoutChange(autoArrangeMindMap(blocks, reconciled), true)}
        >
          {t('flow.map.autoArrange')}
        </button>
        {activeEdge && (
          <span className="flow-map-connect-hint" role="status">
            <Link2 size={14} aria-hidden="true" />
            {t('flow.map.edgeSelected')}
            <button type="button" className="icon-btn" onClick={() => removeEdge(activeEdge.id)}>
              <Trash2 size={14} />
              <span className="sr-only">{edgeLabel(t, blocks, activeEdge)}</span>
            </button>
            <button type="button" className="icon-btn" onClick={() => setSelectedEdgeId(null)}>
              <X size={14} />
              <span className="sr-only">{t('flow.map.closeEditor')}</span>
            </button>
          </span>
        )}
        {connectSource && (
          <span className="flow-map-connect-hint" role="status">
            <Link2 size={14} aria-hidden="true" />
            {t('flow.map.connecting', { title: typeName(connectSource) })}
            <button type="button" className="icon-btn" onClick={() => setConnect(null)}>
              <X size={14} />
              <span className="sr-only">{t('flow.map.cancelConnect')}</span>
            </button>
          </span>
        )}
      </div>

      <div className="flow-map-body">
        <div className="flow-map-scroll">
          <div
            ref={canvasRef}
            className={`flow-map-canvas${connect ? ' flow-map-canvas-connecting' : ''}`}
            role="group"
            aria-label={t('flow.map.canvas')}
            style={{ minWidth: canvasWidth, minHeight: canvasHeight }}
            onDragOver={onCanvasDragOver}
            onDrop={onCanvasDropAt}
          >
            {blocks.length === 0 && <p className="flow-map-empty-note">{t('flow.map.empty')}</p>}
            {/* Size the edge layer in canvas pixels: a percentage height resolves against the
                canvas's height property and would clip every line once the canvas grows past it. */}
            <svg className="flow-map-edges" width={canvasWidth} height={canvasHeight} aria-hidden="true">
              <defs>
                <marker
                  id={edgeMarker}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" className="flow-map-arrowhead" />
                </marker>
                <marker
                  id={autoMarker}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" className="flow-map-arrowhead-auto" />
                </marker>
                <marker
                  id={connectMarker}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" className="flow-map-arrowhead-connect" />
                </marker>
              </defs>
              {autoEdges.map(edge => {
                const { x1, y1, x2, y2 } = edgeGeometry(edge);
                return (
                  <line
                    key={edge.id}
                    className="flow-map-edge-auto"
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    markerEnd={`url(#${autoMarker})`}
                  />
                );
              })}
              {reconciled.edges.map(edge => {
                const { x1, y1, x2, y2 } = edgeGeometry(edge);
                const isActive = edge.id === activeEdgeId;
                return (
                  <g key={edge.id}>
                    <line
                      className={isActive ? 'flow-map-edge-selected' : undefined}
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      markerEnd={`url(#${edgeMarker})`}
                    />
                    {/* A hairline is hard to click, so the drawn edge carries a second, invisible
                        and much wider line whose only job is to be the pointer target. */}
                    <line
                      className="flow-map-edge-hit"
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      onClick={() => setSelectedEdgeId(edge.id)}
                    />
                  </g>
                );
              })}
              {connect && connectStart && connectEnd && (
                <line
                  className="flow-map-connecting-line"
                  x1={connectStart.x + NODE_WIDTH / 2}
                  y1={connectStart.y + NODE_HEIGHT}
                  x2={connectEnd.x}
                  y2={connectEnd.y}
                  markerEnd={`url(#${connectMarker})`}
                />
              )}
            </svg>

            {reconciled.edges.map(edge => {
              const { midX, midY } = edgeGeometry(edge);
              const fromBlock = blocks.find(block => block.id === edge.from);
              const toBlock = blocks.find(block => block.id === edge.to);
              if (!fromBlock || !toBlock) return null;
              return (
                <button
                  key={`${edge.id}-remove`}
                  type="button"
                  className="flow-map-edge-remove"
                  style={{ left: midX, top: midY }}
                  onClick={() => removeEdge(edge.id)}
                  aria-label={t('flow.map.removeEdgeFor', { from: typeName(fromBlock), to: typeName(toBlock) })}
                >
                  <X size={12} />
                </button>
              );
            })}

            {blocks.map(block => {
              const position = positionOf(block.id);
              const Icon = BLOCK_ICONS[block.type];
              const isSelected = block.id === selectedId;
              const isSource = connect?.fromId === block.id;
              const isTarget = connect?.overId === block.id;
              const typeLabel = typeName(block);
              const isMedia = isMediaBlock(block);
              const classes = [
                'flow-map-node',
                isMedia ? 'flow-map-node-media' : '',
                isSelected ? 'flow-map-node-selected' : '',
                isSource ? 'flow-map-node-connecting' : '',
                isTarget ? 'flow-map-node-target' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div
                  key={block.id}
                  data-block-id={block.id}
                  className={classes}
                  style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                  onPointerDown={event => onNodePointerDown(event, block)}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={onNodePointerUp}
                  onPointerCancel={onNodePointerUp}
                >
                  {/* The whole card is the drag/select surface. Its accessible name is fixed to the
                      block type — "Text", "Video", … — so it stays addressable even though the card
                      also shows media, an editor and its own actions. */}
                  <button
                    type="button"
                    className="flow-map-node-card"
                    aria-label={typeLabel}
                    aria-pressed={isSelected}
                    onClick={() => setSelectedId(block.id)}
                  />
                  {/* Media-forward: for a picture or a document the media *is* the card, and the rest
                      sits on top of it. A text or poll block has nothing to show, so it gets no
                      hero at all and the type is read from the small badge icon instead. A media
                      block with nothing on it yet shows the picker, so the chart can fill itself —
                      which is why only the picture is hidden from assistive tech, never the picker. */}
                  {isMedia &&
                    (block.mediaUrl.trim() === '' ? (
                      <div className="flow-map-node-hero">
                        <FlowCardMediaUpload block={block} onChange={onBlockChange} onUploadMedia={onUploadMedia} />
                      </div>
                    ) : (
                      <div className="flow-map-node-hero" aria-hidden="true">
                        <FlowMediaThumb block={block} />
                      </div>
                    ))}
                  <div className="flow-map-node-panel" data-node-control>
                    <div className="flow-map-node-top">
                      <span className="flow-map-node-badge">
                        <Icon size={12} aria-hidden="true" />
                        <span>{typeLabel}</span>
                      </span>
                    </div>
                    <NodeInlineField block={block} onChange={onBlockChange} />
                    <NodeSummary block={block} />
                  </div>
                  <div className="flow-map-node-actions" data-node-control>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={event => {
                        event.stopPropagation();
                        duplicateBlock(block);
                      }}
                      aria-label={t('flow.map.duplicateFor', { title: typeLabel })}
                    >
                      <Copy size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      onClick={event => {
                        event.stopPropagation();
                        removeBlock(block);
                      }}
                      aria-label={t('flow.blocks.action.remove', { type: typeLabel })}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <button
                    type="button"
                    className="flow-map-node-port"
                    aria-label={t('flow.map.connectFor', { title: typeLabel })}
                    onPointerDown={event => onPortPointerDown(event, block)}
                    onPointerMove={onPortPointerMove}
                    onPointerUp={onPortPointerUp}
                    onPointerCancel={() => setConnect(null)}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {selectedBlock && (
          <aside className="flow-map-editor">
            <div className="flow-map-editor-head">
              <h3>{t('flow.map.editSelected', { title: typeName(selectedBlock) })}</h3>
              <div className="flow-map-editor-actions">
                <button
                  type="button"
                  className="icon-btn"
                  disabled={selectedIndex <= 0}
                  onClick={() => reorderBlock(selectedBlock, -1)}
                  aria-label={t('flow.blocks.action.moveUp', { type: typeName(selectedBlock) })}
                >
                  <ChevronUp size={16} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={selectedIndex === -1 || selectedIndex >= blocks.length - 1}
                  onClick={() => reorderBlock(selectedBlock, 1)}
                  aria-label={t('flow.blocks.action.moveDown', { type: typeName(selectedBlock) })}
                >
                  <ChevronDown size={16} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => duplicateBlock(selectedBlock)}
                  aria-label={t('flow.map.duplicateFor', { title: typeName(selectedBlock) })}
                >
                  <Copy size={16} />
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  onClick={() => removeBlock(selectedBlock)}
                  aria-label={t('flow.blocks.action.remove', { type: typeName(selectedBlock) })}
                >
                  <Trash2 size={16} />
                </button>
                <button type="button" className="icon-btn" onClick={() => setSelectedId(null)}>
                  <X size={16} />
                  <span className="sr-only">{t('flow.map.closeEditor')}</span>
                </button>
              </div>
            </div>
            <BlockFields block={selectedBlock} onChange={onBlockChange} onUploadMedia={onUploadMedia} />
          </aside>
        )}
      </div>
    </div>
  );
}
