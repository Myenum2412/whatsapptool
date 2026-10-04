// Pure helpers behind the plans table's selection column and the flow editor's block maths. Plan
// records come from the API, so nothing here creates one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMindMapEdge,
  addPollOption,
  autoArrangeMindMap,
  autoLayoutPosition,
  autoLayoutPositions,
  createExampleFlow,
  createFlowBlock,
  duplicateFlowBlock,
  emptyMindMap,
  flowBlockPreview,
  isFlowBlockComplete,
  MIN_POLL_OPTIONS,
  moveFlowBlock,
  moveMindMapNode,
  planToDraft,
  reconcileMindMap,
  removeFlowBlock,
  removeMindMapEdge,
  removePollOption,
  replaceFlowBlock,
  togglePlanId,
  selectAllPlanIds,
  allPlanIdsSelected,
  somePlanIdsSelected,
} from './plans.ts';
import type { FlowBlock, Plan } from '../types/plans.ts';

function plan(id: string, title = id): Plan {
  return {
    id,
    sessionId: 'sess-1',
    title,
    description: '',
    flow: [],
    mindmap: { positions: {}, edges: [] },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('planToDraft returns a copy, so editing cannot mutate the stored plan', () => {
  const stored = plan('p1', 'Onboarding');
  stored.description = 'original';
  const draft = planToDraft(stored);
  draft.title = 'Changed';
  assert.equal(stored.title, 'Onboarding');
});

test('togglePlanId adds then removes, without mutating the input', () => {
  const start: readonly string[] = [];
  const added = togglePlanId(start, 'p1');
  assert.deepEqual(added, ['p1']);
  assert.deepEqual(togglePlanId(added, 'p2'), ['p1', 'p2']);
  assert.deepEqual(togglePlanId(added, 'p1'), []);
  assert.deepEqual(start, []);
});

test('selectAllPlanIds selects everything, then clears when already complete', () => {
  const plans = [plan('p1'), plan('p2')];
  assert.deepEqual(selectAllPlanIds(plans, []), ['p1', 'p2']);
  assert.deepEqual(selectAllPlanIds(plans, ['p1', 'p2']), []);
});

test('select-all is driven by the listed rows, ignoring ids no longer on the page', () => {
  // A plan deleted in another tab must not leave the header box reporting a selection it
  // cannot act on, so the ids come from `plans`, never from the stored selection.
  const plans = [plan('p1'), plan('p2')];
  assert.deepEqual(selectAllPlanIds(plans, ['gone', 'p1']), ['p1', 'p2']);
});

test('all/some distinguish an empty table from a fully selected one', () => {
  const plans = [plan('p1'), plan('p2')];
  assert.equal(allPlanIdsSelected(plans, ['p1']), false);
  assert.equal(allPlanIdsSelected(plans, ['p1', 'p2']), true);
  assert.equal(somePlanIdsSelected(plans, ['p1']), true);
  assert.equal(somePlanIdsSelected(plans, ['gone']), false);
  // Zero rows must not read as "everything is selected".
  assert.equal(allPlanIdsSelected([], []), false);
});

/* ---- Flow blocks ---- */

test('createFlowBlock seeds a shape per type, and yes/no labels come from the caller', () => {
  // The util has no i18n access, so the labels are passed in � a hardcoded "Yes" would render
  // untranslated in every non-English locale.
  const text = createFlowBlock('text');
  assert.equal(text.type, 'text');
  assert.equal(text.type === 'text' && text.text, '');

  const video = createFlowBlock('video');
  assert.equal(video.type === 'video' && video.mediaUrl, '');
  assert.equal(video.type === 'video' && video.caption, '');

  const file = createFlowBlock('file');
  assert.equal(file.type === 'file' && file.mediaUrl, '');
  assert.equal(file.type === 'file' && file.filename, '');
  assert.equal(file.type === 'file' && file.caption, '');

  const poll = createFlowBlock('poll');
  assert.equal(poll.type === 'poll' && poll.options.length, MIN_POLL_OPTIONS);

  const yesno = createFlowBlock('yesno', { yes: 'Ja', no: 'Nein' });
  assert.equal(yesno.type === 'yesno' && yesno.yesLabel, 'Ja');
  assert.equal(yesno.type === 'yesno' && yesno.noLabel, 'Nein');

  const bare = createFlowBlock('yesno');
  assert.equal(bare.type === 'yesno' && bare.yesLabel, '');
});

test('every block type gets a distinct id', () => {
  // React keys and replace/remove all key off this, so two blocks created in the same
  // millisecond must not collide.
  const blocks = Array.from({ length: 25 }, () => createFlowBlock('text'));
  assert.equal(new Set(blocks.map(b => b.id)).size, blocks.length);
});

test('createExampleFlow builds a greet-ask-branch-close sequence with unique ids', () => {
  const flow = createExampleFlow({
    greeting: 'Hi',
    question: 'Pick one',
    option1: 'A',
    option2: 'B',
    confirm: 'Send a summary?',
    yes: 'Yes',
    no: 'No',
    closing: 'Done',
  });
  assert.deepEqual(
    flow.map(block => block.type),
    ['text', 'poll', 'yesno', 'text'],
  );
  assert.equal(flow[0].type === 'text' && flow[0].text, 'Hi');
  assert.equal(flow[1].type === 'poll' && flow[1].question, 'Pick one');
  assert.deepEqual(flow[1].type === 'poll' && flow[1].options, ['A', 'B']);
  assert.equal(flow[2].type === 'yesno' && flow[2].yesLabel, 'Yes');
  assert.equal(flow[3].type === 'text' && flow[3].text, 'Done');
  assert.equal(new Set(flow.map(block => block.id)).size, flow.length);
});

/* Spreading a `FlowBlock` and overriding `type` produces a cross-product of the union, which is
   not assignable back to it. These factories build each variant concretely instead. */
function textBlock(text: string): FlowBlock {
  return { id: 'text', type: 'text', text };
}
function imageBlock(mediaUrl: string, caption = ''): FlowBlock {
  return { id: 'image', type: 'image', mediaUrl, caption };
}
function fileBlock(mediaUrl: string, filename = '', caption = ''): FlowBlock {
  return { id: 'file', type: 'file', mediaUrl, filename, caption };
}
function pollBlock(question: string, options: string[]): FlowBlock {
  return { id: 'poll', type: 'poll', question, options };
}
function yesNoBlock(question: string, noLabel = 'No'): FlowBlock {
  return { id: 'yesno', type: 'yesno', question, yesLabel: 'Yes', noLabel };
}

test('isFlowBlockComplete requires real content, not whitespace', () => {
  assert.equal(isFlowBlockComplete(textBlock('')), false);
  assert.equal(isFlowBlockComplete(textBlock('   ')), false, 'whitespace is not a message');
  assert.equal(isFlowBlockComplete(textBlock('hi')), true);

  // A caption alone is not enough to send an image.
  assert.equal(isFlowBlockComplete(imageBlock('', 'look')), false);
  assert.equal(isFlowBlockComplete(imageBlock('https://x/i.png')), true);

  // A file also needs somewhere to point; the display name alone is not a document.
  assert.equal(isFlowBlockComplete(fileBlock('', 'invoice.pdf')), false);
  assert.equal(isFlowBlockComplete(fileBlock('https://x/i.pdf', 'invoice.pdf')), true);
});

test('a poll is incomplete until it has a question and two real options', () => {
  assert.equal(isFlowBlockComplete(pollBlock('', ['', ''])), false);
  assert.equal(isFlowBlockComplete(pollBlock('Tea or coffee?', ['', ''])), false, 'two blank options count as none');
  assert.equal(
    isFlowBlockComplete(pollBlock('Tea or coffee?', ['Tea', '  '])),
    false,
    'one blank option is not a choice',
  );
  assert.equal(isFlowBlockComplete(pollBlock('Tea or coffee?', ['Tea', 'Coffee'])), true);
});

test('a yes/no block needs a question and both button labels', () => {
  assert.equal(isFlowBlockComplete(yesNoBlock('')), false);
  assert.equal(isFlowBlockComplete(yesNoBlock('Proceed?')), true);
  assert.equal(isFlowBlockComplete(yesNoBlock('Proceed?', '')), false);
});

test('moveFlowBlock reorders, clamps at both ends, and never mutates the input', () => {
  const a = createFlowBlock('text');
  const b = createFlowBlock('image');
  const c = createFlowBlock('poll');
  const blocks = [a, b, c];

  assert.deepEqual(
    moveFlowBlock(blocks, 0, 1).map(x => x.id),
    [b.id, a.id, c.id],
  );
  assert.deepEqual(
    moveFlowBlock(blocks, 2, -1).map(x => x.id),
    [a.id, c.id, b.id],
  );
  assert.deepEqual(
    moveFlowBlock(blocks, 0, -1).map(x => x.id),
    [a.id, b.id, c.id],
  );
  assert.deepEqual(
    moveFlowBlock(blocks, 2, 1).map(x => x.id),
    [a.id, b.id, c.id],
  );
  assert.deepEqual(
    blocks.map(x => x.id),
    [a.id, b.id, c.id],
    'the input array was mutated',
  );
});

test('replaceFlowBlock swaps one block and leaves the rest alone', () => {
  const a = createFlowBlock('text');
  const b = createFlowBlock('text');
  const edited = { ...a, type: 'text' as const, text: 'edited' };
  const next = replaceFlowBlock([a, b], edited);
  assert.equal(next[0].type === 'text' && next[0].text, 'edited');
  assert.equal(next[1], b, 'the untouched block lost its identity');
});

test('removeFlowBlock drops only the named block', () => {
  const a = createFlowBlock('text');
  const b = createFlowBlock('text');
  assert.deepEqual(
    removeFlowBlock([a, b], a.id).map(x => x.id),
    [b.id],
  );
  assert.deepEqual(
    removeFlowBlock([a, b], 'missing').map(x => x.id),
    [a.id, b.id],
  );
});

test('duplicateFlowBlock copies straight after the original, with a fresh id', () => {
  const a = { ...textBlock('Hi'), id: 'block-1' };
  const b = { ...textBlock('Bye'), id: 'block-2' };
  const next = duplicateFlowBlock([a, b], a.id);

  assert.deepEqual(
    next.map(x => x.id),
    ['block-1', next[1].id, 'block-2'],
    'the copy did not land next to its original',
  );
  assert.notEqual(next[1].id, a.id, 'the copy reused the original id, so one node would carry both');
  assert.deepEqual({ ...next[1], id: null }, { ...a, id: null }, 'the copy is not a faithful copy');
  assert.equal(next.length, 3);

  // An unknown id is a no-op rather than a lost block.
  assert.deepEqual(duplicateFlowBlock([a, b], 'missing'), [a, b]);
});

test('autoLayoutPosition gives each row its own line, matching autoLayoutPositions', () => {
  const blocks = [textBlock('a'), textBlock('b'), textBlock('c')];
  const placed = autoLayoutPositions(blocks);

  assert.deepEqual(autoLayoutPosition(0), { x: 48, y: 48 });
  assert.deepEqual(autoLayoutPosition(2), { x: 48, y: 488 });
  assert.deepEqual(
    autoLayoutPosition(2),
    placed[blocks[2].id],
    'a single node was placed differently to a full layout',
  );
});

test('poll options cannot drop below the two needed to choose between', () => {
  const options = ['Tea', 'Coffee'];
  assert.deepEqual(removePollOption(options, 0), ['Tea', 'Coffee'], 'removing was allowed below the floor');
  assert.deepEqual(removePollOption([...options, 'Water'], 2), ['Tea', 'Coffee']);
  assert.deepEqual(removePollOption(options, 0), options);
  assert.deepEqual(addPollOption(options), ['Tea', 'Coffee', '']);
});

test('planToDraft turns a null description into an empty string for the form field', () => {
  // The API returns `description: null` for a plan saved without one, and binding that straight to a
  // controlled textarea's value would render as the string "null".
  assert.equal(planToDraft({ ...plan('p1'), description: null }).description, '');
});

/* ---- Mind-map layout ---- */

test('emptyMindMap hands out a fresh object, so one plan cannot alias another', () => {
  const a = emptyMindMap();
  const b = emptyMindMap();
  a.edges.push({ id: 'e', from: 'x', to: 'y' });
  assert.deepEqual(b, { positions: {}, edges: [] });
  assert.deepEqual(emptyMindMap(), { positions: {}, edges: [] });
});

test('autoLayoutPositions stacks blocks in flow order, each in its own row', () => {
  const a = createFlowBlock('text');
  const b = createFlowBlock('text');
  const positions = autoLayoutPositions([a, b]);
  assert.deepEqual(Object.keys(positions), [a.id, b.id]);
  assert.equal(positions[a.id].x, positions[b.id].x, 'the single column shares one x');
  assert.ok(positions[b.id].y > positions[a.id].y, 'the second block sits below the first');
});

test('reconcileMindMap places unplaced blocks, keeps dragged ones, and drops stale refs', () => {
  const a = createFlowBlock('text');
  const b = createFlowBlock('text');
  const stale = createFlowBlock('text');
  const dragged = { x: 999, y: 42 };
  const mindmap = {
    positions: { [a.id]: dragged, [stale.id]: { x: 1, y: 1 } },
    edges: [
      { id: 'keep', from: a.id, to: b.id },
      { id: 'drop-from', from: stale.id, to: b.id },
      { id: 'drop-to', from: a.id, to: stale.id },
    ],
  };
  const next = reconcileMindMap([a, b], mindmap);

  assert.deepEqual(next.positions[a.id], dragged, 'a drag must survive a reconcile');
  assert.ok(next.positions[b.id], 'the unplaced block got a position');
  assert.equal(stale.id in next.positions, false);
  assert.deepEqual(
    next.edges.map(edge => edge.id),
    ['keep'],
  );
});

test('autoArrangeMindMap relays every node in flow order but keeps drawn edges', () => {
  const a = createFlowBlock('text');
  const b = createFlowBlock('text');
  const edge = { id: 'e1', from: a.id, to: b.id };
  const next = autoArrangeMindMap([a, b], { positions: { [a.id]: { x: 500, y: 500 } }, edges: [edge] });
  assert.deepEqual(next.positions, autoLayoutPositions([a, b]));
  assert.deepEqual(next.edges, [edge]);
});

test('moveMindMapNode sets one position without disturbing the rest', () => {
  const a = createFlowBlock('text');
  const b = createFlowBlock('text');
  const start = { positions: { [a.id]: { x: 1, y: 1 }, [b.id]: { x: 2, y: 2 } }, edges: [] };
  const next = moveMindMapNode(start, a.id, { x: 50, y: 60 });
  assert.deepEqual(next.positions[a.id], { x: 50, y: 60 });
  assert.deepEqual(next.positions[b.id], { x: 2, y: 2 });
  assert.deepEqual(start.positions[a.id], { x: 1, y: 1 }, 'the input layout was mutated');
});

test('addMindMapEdge refuses self-links and duplicates, and mints unique ids', () => {
  const a = createFlowBlock('text');
  const b = createFlowBlock('text');
  const empty = emptyMindMap();

  assert.deepEqual(addMindMapEdge(empty, a.id, a.id), empty, 'a node must not connect to itself');
  const one = addMindMapEdge(empty, a.id, b.id);
  assert.equal(one.edges.length, 1);
  assert.equal(addMindMapEdge(one, a.id, b.id).edges.length, 1, 'the same pair was drawn twice');

  const two = addMindMapEdge(one, b.id, a.id);
  assert.equal(two.edges.length, 2, 'the reverse direction is a distinct connection');
  assert.equal(new Set(two.edges.map(edge => edge.id)).size, 2);
});

test('removeMindMapEdge drops only the named connection', () => {
  const a = createFlowBlock('text');
  const b = createFlowBlock('text');
  const one = addMindMapEdge(emptyMindMap(), a.id, b.id);
  const two = addMindMapEdge(one, b.id, a.id);
  const [first, second] = two.edges;
  assert.deepEqual(removeMindMapEdge(two, first.id).edges, [second]);
  assert.deepEqual(removeMindMapEdge(two, 'missing').edges, two.edges);
});

test('flowBlockPreview shows the content that identifies a block at a glance', () => {
  assert.equal(flowBlockPreview(textBlock('hello')), 'hello');
  assert.equal(flowBlockPreview(imageBlock('https://x/i.png', 'a caption')), 'a caption');
  assert.equal(flowBlockPreview(imageBlock('https://x/i.png')), 'https://x/i.png');
  assert.equal(flowBlockPreview(fileBlock('https://x/i.pdf', 'invoice.pdf')), 'invoice.pdf');
  assert.equal(flowBlockPreview(fileBlock('https://x/i.pdf')), 'https://x/i.pdf');
  assert.equal(flowBlockPreview(pollBlock('Tea or coffee?', ['Tea', 'Coffee'])), 'Tea or coffee?');
  assert.equal(flowBlockPreview(yesNoBlock('Proceed?')), 'Proceed?');
});
