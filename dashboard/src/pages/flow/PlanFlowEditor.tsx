import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, ChevronDown, ChevronUp, Loader2, MessagesSquare, Pencil, Trash2 } from 'lucide-react';
import { useUpdatePlanMutation } from '../../hooks/queries';
import { planApi } from '../../services/api';
import {
  autoLayoutPosition,
  createExampleFlow,
  createFlowBlock,
  duplicateFlowBlock,
  emptyMindMap,
  isFlowBlockComplete,
  moveFlowBlock,
  moveMindMapNode,
  removeFlowBlock,
  replaceFlowBlock,
} from '../../utils/plans';
import { BlockFields } from './FlowBlockFields';
import { BLOCK_DRAG_MIME, BLOCK_ICONS, BLOCK_TYPES, BLOCK_TYPE_KEYS } from './flowBlockMeta';
import { PlanMindMap } from './PlanMindMap';
import { WhatsAppPreview } from './WhatsAppPreview';
import type {
  FlowBlock,
  FlowBlockType,
  MindMapPosition,
  Plan,
  PlanMindMap as PlanMindMapType,
} from '../../types/plans';

/** Long enough to coalesce a burst of typing, short enough that a tab switch feels instant. */
const AUTOSAVE_DELAY_MS = 600;

/** How far a duplicated node is offset from the block it was copied from. */
const DUPLICATE_OFFSET = 36;

type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';

/** The explicit-override shape an immediate edit passes to `flush`, holding the not-yet-rendered value. */
interface PendingEdit {
  flow?: readonly FlowBlock[];
  mindmap?: PlanMindMapType;
}

type View = 'conversation' | 'chart';

/**
 * The plan's message flow.
 *
 * The conversation view is the primary authoring surface: the blocks read top-to-bottom as the
 * WhatsApp messages they will become, and selecting one opens it in the inspector on the right,
 * alongside the palette that adds new blocks. The flow chart is a secondary tab over the same
 * blocks for arranging and connecting them.
 *
 * There is no save button because the plan is persisted as you work, but the two kinds of edit are
 * not treated alike. Structural edits — adding, removing, reordering a block, moving or connecting
 * a node — are what the rest of the app reads and are written through immediately. Content edits are
 * debounced, so a sentence costs one request instead of one per keystroke. Block order is the send
 * order, which is why moving a block is a first-class action rather than a drag handle that only a
 * mouse can reach.
 *
 * Flow and layout are independent columns on the server, so each autosave sends only the field that
 * changed: typing must not push a stale layout over a newer one, and dragging must not rewrite the
 * flow.
 */
export function PlanFlowEditor({ sessionId, plan }: { sessionId: string; plan: Plan }) {
  const { t } = useTranslation();
  const updatePlan = useUpdatePlanMutation();

  const [view, setView] = useState<View>('conversation');

  // Seeded once: the mutation rewrites the cached plan (new updatedAt) on every save, and re-seeding
  // from that response would overwrite whatever the operator typed during the round trip. The refs
  // hold the same values for the timer and the unmount flush, which run outside render and would
  // otherwise capture stale state. Only the `apply*` helpers write them.
  const [blocks, setBlocks] = useState<FlowBlock[]>(() => plan.flow);
  const [mindmap, setMindmap] = useState<PlanMindMapType>(() => plan.mindmap ?? emptyMindMap());
  const flowRef = useRef<FlowBlock[]>(plan.flow);
  const mindmapRef = useRef<PlanMindMapType>(plan.mindmap ?? emptyMindMap());
  const [status, setStatus] = useState<SaveStatus>('saved');
  // The message whose fields the inspector is showing. Defaults to the first block so the inspector
  // is never empty while there is something to edit.
  const [selectedId, setSelectedId] = useState<string | null>(() => plan.flow[0]?.id ?? null);

  const savedFlowRef = useRef(JSON.stringify(plan.flow));
  const savedMindMapRef = useRef(JSON.stringify(plan.mindmap ?? emptyMindMap()));
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const failedRef = useRef(false);
  const mountedRef = useRef(true);
  // The block type currently being dragged out of a palette. Kept in a ref, not dataTransfer alone,
  // so the drop target never depends on the browser handing a payload back.
  const dragTypeRef = useRef<FlowBlockType | null>(null);

  const flushRef = useRef<(explicit?: PendingEdit) => void>(() => {});
  const scheduleRef = useRef<() => void>(() => {});

  // Only the state write needs the mounted check, and it is the one thing that must not happen after
  // the page has gone: the request itself has to finish either way, or the last edit is lost.
  const showStatus = useCallback((next: SaveStatus) => {
    if (mountedRef.current) setStatus(next);
  }, []);

  /**
   * Write whichever of flow / mindmap differs from what the server last accepted.
   *
   * `explicit` is how an immediate structural edit is sent inside the same tick it was made:
   * `setBlocks`/`setMindmap` have not rendered yet, so the refs still hold the previous value.
   *
   * `mutateAsync` rather than `mutate` for the bookkeeping. Per-call `mutate` callbacks are delivered
   * through the mounted observer, so navigating away mid-save silently drops them — which would
   * strand `inFlightRef` at true and swallow every later edit. The returned promise always settles.
   */
  const flush = useCallback(
    (explicit?: PendingEdit) => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // A request is still open. Whatever changed in the meantime is picked up when it settles,
      // which also keeps two writes from racing and landing out of order server-side.
      if (inFlightRef.current) return;

      const flow = (explicit?.flow ?? flowRef.current) as FlowBlock[];
      const layout = explicit?.mindmap ?? mindmapRef.current;
      const serializedFlow = JSON.stringify(flow);
      const serializedMap = JSON.stringify(layout);
      const flowChanged = serializedFlow !== savedFlowRef.current;
      const mapChanged = serializedMap !== savedMindMapRef.current;
      if (!flowChanged && !mapChanged) return;

      const data: { flow?: FlowBlock[]; mindmap?: PlanMindMapType } = {};
      if (flowChanged) data.flow = flow;
      if (mapChanged) data.mindmap = layout;

      inFlightRef.current = true;
      showStatus('saving');
      void updatePlan
        .mutateAsync({ sessionId, id: plan.id, data })
        .then(() => {
          if (flowChanged) savedFlowRef.current = serializedFlow;
          if (mapChanged) savedMindMapRef.current = serializedMap;
        })
        .catch(() => {
          failedRef.current = true;
          showStatus('error');
        })
        .finally(() => {
          inFlightRef.current = false;
          // Never auto-retry a failed write: that turns one rejected request into a retry loop
          // against a server that is already saying no. The next edit starts a fresh attempt.
          if (failedRef.current) return;
          const pending =
            JSON.stringify(flowRef.current) !== savedFlowRef.current ||
            JSON.stringify(mindmapRef.current) !== savedMindMapRef.current;
          if (pending) {
            showStatus('saving');
            flushRef.current();
          } else {
            showStatus('saved');
          }
        });
    },
    [sessionId, plan.id, updatePlan, showStatus],
  );

  const schedule = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      flushRef.current();
    }, AUTOSAVE_DELAY_MS);
  }, []);

  const applyFlowChange = useCallback(
    (next: FlowBlock[], immediate: boolean) => {
      flowRef.current = next;
      setBlocks(next);
      failedRef.current = false;
      if (immediate) {
        flushRef.current({ flow: next });
      } else {
        // The debounce window is real unsaved time, so say so rather than leaving the last save's
        // "saved" up while the screen and the server disagree.
        showStatus('unsaved');
        scheduleRef.current();
      }
    },
    [showStatus],
  );

  const applyMindMapChange = useCallback(
    (next: PlanMindMapType, immediate: boolean) => {
      mindmapRef.current = next;
      setMindmap(next);
      failedRef.current = false;
      if (immediate) {
        flushRef.current({ mindmap: next });
      } else {
        showStatus('unsaved');
        scheduleRef.current();
      }
    },
    [showStatus],
  );

  // Dropping a new block onto the map changes both columns at once: the block joins the flow, and its
  // position joins the layout. Writing them together keeps the node from existing for a moment with
  // no place on the canvas.
  const applyBlocksAndLayout = useCallback((nextFlow: FlowBlock[], nextLayout: PlanMindMapType) => {
    flowRef.current = nextFlow;
    setBlocks(nextFlow);
    mindmapRef.current = nextLayout;
    setMindmap(nextLayout);
    failedRef.current = false;
    flushRef.current({ flow: nextFlow, mindmap: nextLayout });
  }, []);

  // Kept fresh after every commit so the timer and the unmount cleanup call the current closures.
  // Written in an effect rather than during render, which would be a render-time side effect.
  useEffect(() => {
    flushRef.current = flush;
    scheduleRef.current = schedule;
  });

  // Losing the page should not lose the last few keystrokes: the pending timer is cancelled and its
  // edit written out directly. An edit made while a request was open is picked up by that request's
  // own `finally`, which runs after this component is gone.
  useEffect(
    () => () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
        flushRef.current();
      }
    },
    [],
  );

  // Keep the inspector pointed at a block that still exists: after a removal its id is gone, and a
  // dangling selection would leave the inspector blank with blocks still on screen.
  useEffect(() => {
    if (selectedId !== null && blocks.some(block => block.id === selectedId)) return;
    setSelectedId(blocks[0]?.id ?? null);
  }, [blocks, selectedId]);

  const addBlock = (type: FlowBlockType) => {
    const block = createFlowBlock(type, { yes: t('flow.blocks.defaultYes'), no: t('flow.blocks.defaultNo') });
    setSelectedId(block.id);
    applyFlowChange([...flowRef.current, block], true);
  };

  // A worked example for an empty plan: the same write path as typing, so it is persisted and
  // immediately editable like anything else. Only offered when empty, so it can never clobber work.
  const loadExample = () => {
    applyFlowChange(
      createExampleFlow({
        greeting: t('flow.example.text1'),
        question: t('flow.example.pollQuestion'),
        option1: t('flow.example.pollOption1'),
        option2: t('flow.example.pollOption2'),
        confirm: t('flow.example.yesnoQuestion'),
        yes: t('flow.example.yesLabel'),
        no: t('flow.example.noLabel'),
        closing: t('flow.example.text2'),
      }),
      true,
    );
  };

  const editBlock = (next: FlowBlock) => applyFlowChange(replaceFlowBlock(flowRef.current, next), false);

  /** Reorder or delete a block from the chart: structural, so it is written through at once. */
  const changeBlocks = useCallback((next: FlowBlock[]) => applyFlowChange(next, true), [applyFlowChange]);

  // Uploading replaces the URL a block points at. The block is untouched until the upload lands, so a
  // failed upload leaves the previous media in place.
  const onUploadMedia = useCallback(
    async (file: File) => {
      const uploaded = await planApi.uploadMedia(sessionId, plan.id, file);
      return { url: uploaded.url, filename: uploaded.filename };
    },
    [sessionId, plan.id],
  );

  // Drop a palette block onto the canvas: create it and pin its node where it landed.
  const addBlockAt = (type: FlowBlockType, position: MindMapPosition) => {
    const block = createFlowBlock(type, { yes: t('flow.blocks.defaultYes'), no: t('flow.blocks.defaultNo') });
    applyBlocksAndLayout([...flowRef.current, block], moveMindMapNode(mindmapRef.current, block.id, position));
  };

  /**
   * Copy a block from the chart. Both columns move together, as when a block is dropped: a node with
   * no position would be auto-placed into the single column, on top of everything else. The copy is
   * offset from its original so the pair reads as related instead of as one node drawn twice.
   */
  const duplicateBlock = (id: string): string | undefined => {
    const next = duplicateFlowBlock(flowRef.current, id);
    const added = next.find(block => !flowRef.current.some(previous => previous.id === block.id));
    if (!added) return undefined;
    const index = flowRef.current.findIndex(block => block.id === id);
    const origin = mindmapRef.current.positions[id] ?? autoLayoutPosition(index);
    applyBlocksAndLayout(
      next,
      moveMindMapNode(mindmapRef.current, added.id, {
        x: origin.x + DUPLICATE_OFFSET,
        y: origin.y + DUPLICATE_OFFSET,
      }),
    );
    return added.id;
  };

  const handleCanvasDrop = (position: MindMapPosition) => {
    const type = dragTypeRef.current;
    dragTypeRef.current = null;
    if (type) addBlockAt(type, position);
  };

  const startBlockDrag = (event: DragEvent<HTMLButtonElement>, type: FlowBlockType) => {
    dragTypeRef.current = type;
    // Firefox will not start a drag unless a payload is set, even though the drop reads the ref.
    // Some browsers reject custom types, so also set text/plain and never let a payload error abort
    // the drag.
    try {
      event.dataTransfer?.setData(BLOCK_DRAG_MIME, type);
      event.dataTransfer?.setData('text/plain', type);
    } catch {
      // Ignore: the ref still carries the type for the drop.
    }
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    // The canvas is the only drop target, so bring it into view rather than letting a drag from the
    // conversation quietly do nothing.
    if (view !== 'chart') setView('chart');
  };

  const selectedIndex = selectedId ? blocks.findIndex(block => block.id === selectedId) : -1;
  const selectedBlock = selectedIndex >= 0 ? blocks[selectedIndex] : null;

  const renderPalette = () => (
    <aside className="flow-palette" aria-label={t('flow.blocks.add')}>
      <span className="flow-palette-label">{t('flow.blocks.add')}</span>
      <div className="flow-palette-items">
        {BLOCK_TYPES.map(type => {
          const Icon = BLOCK_ICONS[type];
          return (
            <button
              key={type}
              type="button"
              className="flow-palette-item"
              draggable
              onDragStart={event => startBlockDrag(event, type)}
              onDragEnd={() => {
                dragTypeRef.current = null;
              }}
              onClick={() => addBlock(type)}
            >
              <Icon size={16} aria-hidden="true" />
              {t(BLOCK_TYPE_KEYS[type])}
            </button>
          );
        })}
      </div>
    </aside>
  );

  return (
    <section className="plan-flow" aria-labelledby="plan-flow-heading">
      <div className="plan-flow-head">
        <div>
          <h2 id="plan-flow-heading">{t('flow.blocks.heading')}</h2>
          <p className="input-hint">{view === 'chart' ? t('flow.map.description') : t('flow.blocks.description')}</p>
        </div>
        <p className={`flow-save-status flow-save-${status}`} role="status" aria-live="polite">
          {status === 'unsaved' && (
            <>
              <Pencil size={14} aria-hidden="true" />
              {t('flow.blocks.autosave.unsaved')}
            </>
          )}
          {status === 'saving' && (
            <>
              <Loader2 className="animate-spin" size={14} aria-hidden="true" />
              {t('flow.blocks.autosave.saving')}
            </>
          )}
          {status === 'error' && (
            <>
              <AlertCircle size={14} aria-hidden="true" />
              {t('flow.blocks.autosave.error')}
            </>
          )}
          {status === 'saved' && (
            <>
              <Check size={14} aria-hidden="true" />
              {t('flow.blocks.autosave.saved')}
            </>
          )}
        </p>
      </div>

      <div className="flow-view-toggle" role="group" aria-label={t('flow.blocks.heading')}>
        <button
          type="button"
          className="flow-view-btn"
          aria-pressed={view === 'conversation'}
          onClick={() => setView('conversation')}
        >
          {t('flow.view.blocks')}
        </button>
        <button
          type="button"
          className="flow-view-btn"
          aria-pressed={view === 'chart'}
          onClick={() => setView('chart')}
        >
          {t('flow.view.map')}
        </button>
      </div>

      {view === 'chart' ? (
        <div className="flow-chart">
          {renderPalette()}
          <div className="flow-chart-main">
            <PlanMindMap
              blocks={blocks}
              mindmap={mindmap}
              onLayoutChange={applyMindMapChange}
              onBlockChange={editBlock}
              onFlowChange={changeBlocks}
              onDuplicateBlock={duplicateBlock}
              onUploadMedia={onUploadMedia}
              onCanvasDrop={handleCanvasDrop}
            />
          </div>
        </div>
      ) : (
        <div className="flow-studio">
          <div className="flow-conversation">
            {blocks.length === 0 ? (
              <div className="plan-flow-empty">
                <MessagesSquare size={40} strokeWidth={1} aria-hidden="true" />
                <p>{t('flow.blocks.empty.title')}</p>
                <button type="button" className="btn-secondary flow-example-btn" onClick={loadExample}>
                  {t('flow.example.load')}
                </button>
              </div>
            ) : (
              <ol className="flow-conversation-list">
                {blocks.map(block => {
                  const Icon = BLOCK_ICONS[block.type];
                  const typeName = t(BLOCK_TYPE_KEYS[block.type]);
                  const complete = isFlowBlockComplete(block);
                  const isSelected = block.id === selectedId;
                  return (
                    <li
                      className={`flow-message${isSelected ? ' flow-message-selected' : ''}${
                        complete ? '' : ' flow-message-incomplete'
                      }`}
                      key={block.id}
                    >
                      <span className="flow-message-type">
                        <Icon size={14} aria-hidden="true" />
                        {typeName}
                      </span>
                      <button
                        type="button"
                        className="flow-message-bubble"
                        aria-pressed={isSelected}
                        aria-label={t('flow.blocks.selectFor', { type: typeName })}
                        onClick={() => setSelectedId(block.id)}
                      >
                        <WhatsAppPreview block={block} />
                      </button>
                      {!complete && <p className="flow-message-warning">{t('flow.blocks.incomplete')}</p>}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>

          <aside className="flow-inspector" aria-label={t('flow.inspector.title')}>
            {renderPalette()}

            {selectedBlock && (
              <div className="flow-inspector-panel">
                <div className="flow-inspector-head">
                  <h3>{t('flow.map.editSelected', { title: t(BLOCK_TYPE_KEYS[selectedBlock.type]) })}</h3>
                  <div className="flow-inspector-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={selectedIndex === 0}
                      onClick={() => applyFlowChange(moveFlowBlock(blocks, selectedIndex, -1), true)}
                      aria-label={t('flow.blocks.action.moveUp', { type: t(BLOCK_TYPE_KEYS[selectedBlock.type]) })}
                    >
                      <ChevronUp size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={selectedIndex === blocks.length - 1}
                      onClick={() => applyFlowChange(moveFlowBlock(blocks, selectedIndex, 1), true)}
                      aria-label={t('flow.blocks.action.moveDown', { type: t(BLOCK_TYPE_KEYS[selectedBlock.type]) })}
                    >
                      <ChevronDown size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      onClick={() => applyFlowChange(removeFlowBlock(blocks, selectedBlock.id), true)}
                      aria-label={t('flow.blocks.action.remove', { type: t(BLOCK_TYPE_KEYS[selectedBlock.type]) })}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <div className="flow-inspector-body">
                  <BlockFields block={selectedBlock} onChange={editBlock} onUploadMedia={onUploadMedia} />
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
