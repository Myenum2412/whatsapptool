// Render test for the /flow plans page under the bare `node --test` runner, on the Templates.test.ts
// harness. Plans are persisted and session-scoped, so the tree under test is
// QueryClientProvider > ToastProvider > MemoryRouter > Flow, over a stubbed fetch standing in for
// /api/sessions and /api/sessions/:id/plans. The behaviour worth pinning is the session scoping, the
// selection column, navigation into the session-scoped detail route, the dialog contract, and the
// split between structural writes (immediate) and typing (debounced).
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

interface TestBlock {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface TestPlan {
  id: string;
  sessionId: string;
  title: string;
  description: string | null;
  flow: TestBlock[];
  mindmap: {
    positions: Record<string, { x: number; y: number }>;
    edges: Array<{ id: string; from: string; to: string }>;
  };
  createdAt: string;
  updatedAt: string;
}

const SESSIONS = [
  {
    id: 'sess-1',
    name: 'billing-bot',
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'sess-2',
    name: 'support-bot',
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

let sessions = SESSIONS;
let plans: TestPlan[] = [];
let listStatus = 200;
let writeStatus = 200;
let nextId = 1;
const deletes: string[] = [];
/** Every `{ planId, data }` body the editor sent, so autosave timing is observable. */
const writes: Array<{ planId: string; data: Record<string, unknown> }> = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function makePlan(sessionId: string, body: Record<string, unknown>): TestPlan {
  const stamp = '2026-01-02T00:00:00.000Z';
  return {
    id: `plan-${nextId++}`,
    sessionId,
    title: String(body.title ?? ''),
    description: body.description === undefined ? null : String(body.description ?? ''),
    flow: (body.flow as TestBlock[] | undefined) ?? [],
    mindmap: (body.mindmap as TestPlan['mindmap'] | undefined) ?? { positions: {}, edges: [] },
    createdAt: stamp,
    updatedAt: stamp,
  };
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
    const method = (init.method ?? 'GET').toUpperCase();

    if (path === '/sessions' && method === 'GET') {
      return Promise.resolve(jsonResponse(sessions));
    }

    const listMatch = /^\/sessions\/([^/]+)\/plans$/.exec(path);
    if (listMatch) {
      if (method === 'GET') {
        if (listStatus !== 200) return Promise.resolve(jsonResponse({ message: 'database offline' }, listStatus));
        return Promise.resolve(jsonResponse(plans.filter(plan => plan.sessionId === listMatch[1])));
      }
      if (method === 'POST') {
        const created = makePlan(listMatch[1], JSON.parse(String(init.body ?? '{}')));
        plans = [...plans, created];
        return Promise.resolve(jsonResponse(created, 201));
      }
    }

    const rowMatch = /^\/sessions\/([^/]+)\/plans\/([^/]+)$/.exec(path);
    if (rowMatch) {
      const [, sessionId, planId] = rowMatch;
      const index = plans.findIndex(plan => plan.id === planId && plan.sessionId === sessionId);
      if (method === 'GET') {
        if (index === -1) return Promise.resolve(jsonResponse({ message: 'Plan not found' }, 404));
        return Promise.resolve(jsonResponse(plans[index]));
      }
      if (method === 'PUT') {
        if (index === -1) return Promise.resolve(jsonResponse({ message: 'Plan not found' }, 404));
        if (writeStatus !== 200) return Promise.resolve(jsonResponse({ message: 'write rejected' }, writeStatus));
        const patch = JSON.parse(String(init.body ?? '{}'));
        writes.push({ planId, data: patch });
        // Partial by contract, exactly like the service: an absent key is left alone.
        const merged = {
          ...plans[index],
          title: patch.title === undefined ? plans[index].title : String(patch.title),
          description:
            patch.description === undefined
              ? plans[index].description
              : patch.description === null
                ? null
                : String(patch.description),
          flow: patch.flow === undefined ? plans[index].flow : (patch.flow as TestBlock[]),
          mindmap: patch.mindmap === undefined ? plans[index].mindmap : (patch.mindmap as TestPlan['mindmap']),
        };
        plans = plans.map((plan, current) => (current === index ? merged : plan));
        return Promise.resolve(jsonResponse(merged));
      }
      if (method === 'DELETE') {
        if (index === -1) return Promise.resolve(jsonResponse({ message: 'Plan not found' }, 404));
        deletes.push(planId);
        plans = plans.filter(plan => plan.id !== planId);
        return Promise.resolve(jsonResponse({ success: true }));
      }
    }

    const uploadMatch = /^\/sessions\/([^/]+)\/plans\/([^/]+)\/media$/.exec(path);
    if (uploadMatch && method === 'POST') {
      return Promise.resolve(
        jsonResponse(
          {
            url: `/sessions/${uploadMatch[1]}/plans/${uploadMatch[2]}/media/uploaded.png`,
            filename: 'photo.png',
            mimetype: 'image/png',
            sizeBytes: 11,
          },
          201,
        ),
      );
    }

    const mediaMatch = /^\/sessions\/([^/]+)\/plans\/([^/]+)\/media\/([^/]+)$/.exec(path);
    if (mediaMatch && method === 'GET') {
      return Promise.resolve(new Response('fake-bytes', { status: 200, headers: { 'Content-Type': 'image/png' } }));
    }

    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Flow: (typeof import('./index.tsx'))['Flow'];
let PlanDetail: (typeof import('./PlanDetail.tsx'))['PlanDetail'];
let ToastProvider: (typeof import('../../components/Toast.tsx'))['ToastProvider'];
let MemoryRouter: (typeof import('react-router-dom'))['MemoryRouter'];
let Routes: (typeof import('react-router-dom'))['Routes'];
let Route: (typeof import('react-router-dom'))['Route'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ToastProvider } = await import('../../components/Toast.tsx'));
  ({ PlanDetail } = await import('./PlanDetail.tsx'));
  ({ Flow } = await import('./index.tsx'));
  ({ MemoryRouter, Routes, Route } = await import('react-router-dom'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

/** Each test starts from one session holding one plan, so ordering between tests cannot matter. */
function resetPlans(): void {
  sessions = SESSIONS;
  listStatus = 200;
  writeStatus = 200;
  nextId = 1;
  deletes.length = 0;
  writes.length = 0;
  plans = [makePlan('sess-1', { title: 'Onboarding', description: 'Welcome new contacts' })];
}

/** Renders both /flow routes under one router so navigation between them is observable. */
function renderFlow(initialEntry = '/flow'): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ToastProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: [initialEntry] },
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/flow', element: createElement(Flow) }),
            createElement(Route, { path: '/flow/:sessionId', element: createElement(Flow) }),
            createElement(Route, { path: '/flow/:sessionId/plans/:planId', element: createElement(PlanDetail) }),
          ),
        ),
      ),
    ),
  );
}

/** Creates a plan through the real form and waits for the list to refetch it. */
async function addPlan(title: string, description = ''): Promise<void> {
  const { screen, fireEvent, within } = rtl;
  fireEvent.click(await screen.findByRole('button', { name: 'New plan' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: title } });
  if (description) {
    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: description } });
  }
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
}

test('the session picker scopes the list, and switching sessions swaps the rows', async () => {
  const { screen, fireEvent } = rtl;
  resetPlans();
  plans = [...plans, makePlan('sess-2', { title: 'Escalations' })];
  renderFlow();

  const picker = (await screen.findByLabelText('Session')) as HTMLSelectElement;
  await screen.findByText('Onboarding');
  assert.equal(screen.queryByText('Escalations'), null, "another session's plans leaked into the list");

  fireEvent.change(picker, { target: { value: 'sess-2' } });

  await screen.findByText('Escalations');
  assert.equal(screen.queryByText('Onboarding'), null, "the previous session's plans survived the switch");
});

test('with no sessions at all the page explains that, instead of offering an empty table', async () => {
  const { screen } = rtl;
  resetPlans();
  sessions = [];
  plans = [];
  renderFlow();

  await screen.findByText('No sessions available');
  assert.equal(screen.queryByRole('table'), null);
  // Nothing to attach a plan to, so the create affordance must not be offered either.
  assert.equal((screen.getByRole('button', { name: 'New plan' }) as HTMLButtonElement).disabled, true);
});

test('a failed read shows the error, not the empty state', async () => {
  const { screen } = rtl;
  resetPlans();
  listStatus = 500;
  renderFlow();

  await screen.findByText('Could not load plans');
  screen.getByText('database offline');
  assert.equal(screen.queryByText('No plans yet'), null);
});

test('a successful empty read still shows the empty state', async () => {
  const { screen } = rtl;
  resetPlans();
  plans = [];
  renderFlow();

  await screen.findByText('No plans yet');
  assert.equal(screen.queryByRole('table'), null);
});

test('the header button opens a form with a title and a description, and nothing else', async () => {
  const { screen, fireEvent, within } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'New plan' }));

  const dialog = await screen.findByRole('dialog');
  within(dialog).getByLabelText('Title');
  within(dialog).getByLabelText('Description');
  assert.equal(within(dialog).queryByRole('table'), null, 'the popup still holds a table');
});

test('a completed form lands in the plans list', async () => {
  const { screen, within } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  await addPlan('Win-back', 'Reach out after a lapse');

  const card = (await screen.findByText('Win-back')).closest('li') as HTMLElement;
  assert.ok(card, 'the saved plan is missing from the plans list');
  within(card).getByText('Reach out after a lapse');
});

test('a blank title is refused instead of saving a nameless plan', async () => {
  const { screen, fireEvent, within } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'New plan' }));
  const dialog = await screen.findByRole('dialog');

  // The error must not appear before the first submit attempt.
  assert.equal(within(dialog).queryByText('A title is required'), null);

  fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

  within(dialog).getByText('A title is required');
  assert.ok(screen.getByRole('dialog'), 'the dialog closed on an invalid submit');
  // Nothing was written, so no nameless card joined the list.
  assert.equal(screen.getAllByRole('listitem').length, 1);
});

test('an empty description renders a dash rather than a blank cell', async () => {
  const { screen } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  await addPlan('No body');

  const card = (await screen.findByText('No body')).closest('li') as HTMLElement;
  assert.equal(card.querySelector('.plans-description-cell')?.textContent?.trim(), '—');
});

test('checking rows drives the bulk bar and Delete selected', async () => {
  const { screen, fireEvent, within } = rtl;
  resetPlans();
  plans = [...plans, makePlan('sess-1', { title: 'Second' }), makePlan('sess-1', { title: 'Third' })];
  renderFlow();

  // The bar is absent until something is selected, so the header has no dead controls.
  assert.equal(screen.queryByRole('region', { name: 'Bulk actions' }), null);

  fireEvent.click(await screen.findByRole('checkbox', { name: 'Select plan Second' }));
  screen.getByText('1 selected');

  fireEvent.click(screen.getByRole('checkbox', { name: 'Select plan Third' }));
  screen.getByText('2 selected');

  // Deleting is confirmed and counted, not immediate.
  fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
  const confirmDialog = await screen.findByRole('dialog');
  within(confirmDialog).getByText(/permanently removes 2 plans/);

  fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Delete' }));

  await rtl.waitFor(() => assert.deepEqual(deletes, ['plan-2', 'plan-3'], 'the deletes never reached the API'), {});
  assert.ok(await screen.findByText('Onboarding'), 'the bulk delete took a row that was never selected');
  assert.equal(screen.queryByText('Second'), null);
  assert.equal(screen.queryByText('Third'), null);
  // The bar must not survive its selection.
  assert.equal(screen.queryByRole('region', { name: 'Bulk actions' }), null);
});

test('the header checkbox selects every row, then clears the selection', async () => {
  const { screen, fireEvent } = rtl;
  resetPlans();
  plans = [...plans, makePlan('sess-1', { title: 'Second' })];
  renderFlow();

  await screen.findByText('Second');
  const selectAll = screen.getByRole('checkbox', { name: 'Select all plans' }) as HTMLInputElement;
  fireEvent.click(selectAll);
  screen.getByText('2 selected');

  // `indeterminate` has no attribute, so it can only be read off the live element.
  assert.equal(selectAll.checked, true);
  assert.equal(selectAll.indeterminate, false);

  fireEvent.click(selectAll);
  assert.equal(screen.queryByRole('region', { name: 'Bulk actions' }), null);
  const cleared = screen.getByRole('checkbox', { name: 'Select plan Onboarding' }) as HTMLInputElement;
  assert.equal(cleared.checked, false);
});

test('a partial selection marks the header checkbox indeterminate', async () => {
  const { screen, fireEvent } = rtl;
  resetPlans();
  plans = [...plans, makePlan('sess-1', { title: 'Second' })];
  renderFlow();

  await screen.findByText('Second');
  const selectAll = screen.getByRole('checkbox', { name: 'Select all plans' }) as HTMLInputElement;
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select plan Onboarding' }));

  screen.getByText('1 selected');
  assert.equal(selectAll.indeterminate, true);
  assert.equal(selectAll.checked, false);
});

test('clearing the selection from the bar unchecks every row', async () => {
  const { screen, fireEvent } = rtl;
  resetPlans();
  plans = [...plans, makePlan('sess-1', { title: 'Second' })];
  renderFlow();

  await screen.findByText('Second');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all plans' }));
  fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));

  assert.equal(screen.queryByRole('region', { name: 'Bulk actions' }), null);
  const rowCheckbox = screen.getByRole('checkbox', { name: 'Select plan Onboarding' }) as HTMLInputElement;
  assert.equal(rowCheckbox.checked, false);
});

test('View opens the session-scoped detail route for that plan', async () => {
  const { screen, fireEvent } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));

  // The list unmounted and the detail route took over, fetched by its own session-scoped key.
  await screen.findByRole('heading', { level: 1, name: 'Onboarding' });
  assert.equal(screen.queryByRole('table'), null);
  screen.getByText('Welcome new contacts');
  screen.getByText('Plan details');
  assert.ok(screen.getByRole('link', { name: 'Back to plans' }));
});

test('the detail page starts with an empty flow offering all six block types', async () => {
  const { screen, fireEvent } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));

  await screen.findByRole('heading', { level: 2, name: 'Flow' });
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));
  screen.getByText('This plan has no blocks yet. Add one from the palette to start building the flow.');
  for (const label of ['Text', 'Image', 'Video', 'File', 'Poll', 'Yes / No']) {
    screen.getByRole('button', { name: label });
  }
});

test('the empty flow can be seeded with a step-by-step example', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('heading', { level: 2, name: 'Flow' });
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));

  fireEvent.click(screen.getByRole('button', { name: 'Load example flow' }));

  await waitFor(() => assert.equal(writes.length, 1, 'the example was not persisted'));
  const flow = writes[0].data.flow as TestBlock[];
  assert.deepEqual(
    flow.map(block => block.type),
    ['text', 'poll', 'yesno', 'text'],
  );

  const items = screen.getAllByRole('listitem');
  assert.equal(items.length, 4);
  // The first block is selected after loading, so its fields are live in the inspector.
  screen.getByDisplayValue("Hi! Thanks for reaching out. I'll help you get started.");
  // Once loaded the flow is no longer empty, so the starter affordance goes away — it is for
  // seeding a plan, not replacing one.
  assert.equal(screen.queryByRole('button', { name: 'Load example flow' }), null);
});

test('adding each block type renders its own fields, and Yes / No is seeded translated', async () => {
  const { screen, fireEvent, within } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));

  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  const block = screen.getByRole('listitem');
  screen.getByLabelText('Message');
  within(block).getByText('This block is missing some details.');

  fireEvent.click(screen.getByRole('button', { name: 'Image' }));
  // Adding a block selects it, so its fields move into the inspector.
  screen.getByLabelText('Media URL');
  // The hint is wired to the field, not floating loose.
  const mediaUrl = screen.getByLabelText('Media URL');
  assert.ok(mediaUrl.getAttribute('aria-describedby'), 'the media hint is not associated with its input');
  screen.getByLabelText('Caption (optional)');

  fireEvent.click(screen.getByRole('button', { name: 'Yes / No' }));
  screen.getByLabelText('Question');
  // Seeded from the catalogue rather than hardcoded English in the util.
  assert.equal((screen.getByLabelText('Yes button') as HTMLInputElement).value, 'Yes');
  assert.equal((screen.getByLabelText('No button') as HTMLInputElement).value, 'No');
});

test('a file block names the document and can be filled by upload', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'File' });
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));

  fireEvent.click(screen.getByRole('button', { name: 'File' }));

  // The added block is selected, so its fields render in the inspector.
  const filename = screen.getByLabelText('File name') as HTMLInputElement;
  screen.getByLabelText('Media URL');
  screen.getByLabelText('Caption (optional)');

  // Uploading fills the URL field through the multipart endpoint; with the name blank the uploaded
  // file's name seeds the label.
  const input = screen.getByLabelText('Upload file') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['hello'], 'photo.png', { type: 'image/png' })] } });

  await waitFor(() => {
    assert.equal(
      (screen.getByLabelText('Media URL') as HTMLInputElement).value,
      '/sessions/sess-1/plans/plan-1/media/uploaded.png',
      'the uploaded URL never reached the field',
    );
  });
  assert.equal(filename.value, 'photo.png');
  // Once a URL is present the control offers replace and remove instead of upload.
  screen.getByText('Replace file');
  screen.getByRole('button', { name: 'Remove file' });

  // Removing clears both the URL and the name.
  fireEvent.click(screen.getByRole('button', { name: 'Remove file' }));
  assert.equal((screen.getByLabelText('Media URL') as HTMLInputElement).value, '');
  assert.equal(filename.value, '');
  screen.getByText('Upload file');
});

test('a poll block starts with two options and refuses to drop below them', async () => {
  const { screen, fireEvent } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Poll' });
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Poll' }));

  // The added block is selected, so its fields render in the inspector.
  screen.getByLabelText('Option 1');
  screen.getByLabelText('Option 2');
  screen.getByLabelText('Question');

  // Both remove buttons are disabled — two options is the floor.
  for (const index of [1, 2]) {
    const remove = screen.getByRole('button', { name: `Remove option ${index}` });
    assert.equal((remove as HTMLButtonElement).disabled, true);
  }

  fireEvent.click(screen.getByRole('button', { name: 'Add option' }));
  screen.getByLabelText('Option 3');
  const removeThird = screen.getByRole('button', { name: 'Remove option 3' }) as HTMLButtonElement;
  assert.equal(removeThird.disabled, false);

  fireEvent.click(removeThird);
  screen.getByLabelText('Option 2');
  assert.equal(screen.queryByLabelText('Option 3'), null);
});

test('typing a block clears its incomplete marker and the list reflects the send order', async () => {
  const { screen, fireEvent, within } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));

  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  fireEvent.click(screen.getByRole('button', { name: 'Image' }));

  const [textBlock, imageBlock] = screen.getAllByRole('listitem') as HTMLElement[];
  assert.ok(within(textBlock).getByText('This block is missing some details.'));
  assert.ok(within(imageBlock).getByText('This block is missing some details.'));

  // Tap the message in the conversation to open it in the inspector, then type.
  fireEvent.click(screen.getByRole('button', { name: 'Edit the Text message' }));
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello there' } });
  assert.equal(within(textBlock).queryByText('This block is missing some details.'), null);
  assert.ok(within(imageBlock).getByText('This block is missing some details.'), 'the sibling lost its own marker');

  // Moving the second block up puts it first — order is the send order, so it must be reachable
  // without a mouse.
  fireEvent.click(screen.getByRole('button', { name: 'Edit the Image message' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move Image block up' }));

  const reordered = screen.getAllByRole('listitem') as HTMLElement[];
  assert.ok(
    within(reordered[0]).getByRole('button', { name: 'Edit the Image message' }),
    'Image did not move to the front',
  );
  assert.ok(
    within(reordered[1]).getByRole('button', { name: 'Edit the Text message' }),
    'Text did not move to the back',
  );
  assert.equal((screen.getByRole('button', { name: 'Move Image block up' }) as HTMLButtonElement).disabled, true);
});

test('a block can be removed, and the flow returns to its empty state', async () => {
  const { screen, fireEvent } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Video' });
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));

  fireEvent.click(screen.getByRole('button', { name: 'Video' }));
  screen.getByRole('listitem');

  fireEvent.click(screen.getByRole('button', { name: 'Remove Video block' }));

  assert.equal(screen.queryByRole('listitem'), null);
  screen.getByText('This plan has no blocks yet. Add one from the palette to start building the flow.');
});

test('a structural edit is written through at once, while typing waits for the debounce', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));

  // Adding a block changes the send order, so it must not wait on a timer.
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  await waitFor(() => assert.equal(writes.length, 1, 'the added block was not persisted immediately'));
  assert.equal((writes[0].data.flow as TestBlock[]).length, 1);

  // Typing inside it is debounced, so a burst of keystrokes must not be one request per character.
  // The new block is selected, so its field is live in the inspector.
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'He' } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello' } });
  assert.equal(writes.length, 1, 'typing was written before the debounce elapsed');
  // The debounce window is unsaved time, and the indicator has to admit that rather than claiming
  // the last save still covers what is on screen.
  screen.getByText('Unsaved changes');

  await waitFor(() => assert.equal(writes.length, 2, 'the debounced typing never reached the API'), {
    timeout: 3_000,
  });
  assert.equal((writes[1].data.flow as TestBlock[])[0].text, 'Hello');
  // Only the flow is sent: a partial update must not clear the title or description alongside it.
  assert.deepEqual(Object.keys(writes[1].data), ['flow']);
  await waitFor(() => screen.getByText('All changes saved'), { timeout: 3_000 });
});

test('a failed autosave says so and keeps the text on screen', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));

  await waitFor(() => assert.equal(writes.length, 1));
  // The next structural write fails: a rejected save must be visible, not silently swallowed.
  writeStatus = 500;
  fireEvent.click(screen.getByRole('button', { name: 'Remove Text block' }));

  await waitFor(() => screen.getByText("Couldn't save changes"));
  // The block is still editable so the work is not lost.
  assert.equal(screen.queryByRole('listitem'), null, 'the UI pretended the rejected save applied');
  writeStatus = 200;
});

test('the built flow is persisted, so it survives leaving the page and coming back', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  fireEvent.change(screen.getByLabelText('Message'), {
    target: { value: 'Welcome aboard' },
  });

  // Leaving mid-debounce must not drop the edit.
  fireEvent.click(screen.getByRole('link', { name: 'Back to plans' }));
  await waitFor(() => assert.equal(plans[0].flow[0]?.text, 'Welcome aboard', 'the pending edit was lost'));

  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  // The conversation is the default, and the first block is selected, so the persisted text is
  // already in the inspector.
  await screen.findByRole('button', { name: 'Conversation' });
  await waitFor(() => screen.getByDisplayValue('Welcome aboard'));
});

test('a direct URL for an unknown plan shows the not-found panel, not a blank page', async () => {
  const { screen } = rtl;
  resetPlans();
  renderFlow('/flow/sess-1/plans/plan-does-not-exist');

  assert.equal(screen.queryByRole('table'), null);
  await screen.findByRole('heading', { level: 3, name: 'Plan not found' });
  assert.ok(screen.getByRole('link', { name: 'Back to plans' }));
});

test('reopening the form for an edit seeds it from the stored plan, and cancel discards it', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'Edit plan Onboarding' }));
  const dialog = await screen.findByRole('dialog');
  // Read the DOM property, not the content attribute: React writes the property, and the attribute
  // keeps the value the field was mounted with.
  const seededTitle = within(dialog).getByLabelText('Title') as HTMLInputElement;
  const seededDescription = within(dialog).getByLabelText('Description') as HTMLTextAreaElement;
  assert.equal(seededTitle.value, 'Onboarding');
  assert.equal(seededDescription.value, 'Welcome new contacts');

  fireEvent.change(seededTitle, { target: { value: 'Renamed' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(screen.queryByText('Renamed'), null, 'a cancelled edit still reached the table');
  await waitFor(() => assert.equal(plans[0].title, 'Onboarding', 'a cancelled edit reached the API'));
  screen.getByText('Onboarding');
});

test('a saved edit updates the plan on the server', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'Edit plan Onboarding' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Renamed' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.equal(plans[0].title, 'Renamed'));
  await screen.findByText('Renamed');
  // The description was absent from the payload, so the partial update must have left it alone.
  assert.equal(plans[0].description, 'Welcome new contacts');
});

/* ---- Mind map view ---- */

/** Adds one Text and one Image block, and returns once both writes have landed. */
async function twoBlocksOnTheMap(): Promise<HTMLElement> {
  const { screen, fireEvent, waitFor } = rtl;
  fireEvent.click(screen.getByRole('button', { name: 'Text' }));
  fireEvent.click(screen.getByRole('button', { name: 'Image' }));
  await waitFor(() => assert.equal(writes.length, 2, 'the two blocks were not persisted'));
  fireEvent.click(screen.getByRole('button', { name: 'Flow chart' }));
  return screen.findByRole('group', { name: 'Flow chart canvas' });
}

test('the mind map view explains itself when there is nothing to map', async () => {
  const { screen, fireEvent } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('heading', { level: 2, name: 'Flow' });

  // The conversation is the default surface; the chart is a tab the operator opens.
  const toggle = screen.getByRole('button', { name: 'Flow chart' });
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  fireEvent.click(toggle);
  assert.equal(screen.getByRole('button', { name: 'Flow chart' }).getAttribute('aria-pressed'), 'true');

  await screen.findByText('Drag a block from the palette onto the canvas to start.');
  assert.equal(screen.queryByRole('listitem'), null, 'the block list is still on screen behind the chart');
});

test('auto arrange lays the nodes out and persists only the layout', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  const canvas = await twoBlocksOnTheMap();

  // The same two blocks, now as nodes.
  within(canvas).getByRole('button', { name: 'Text' });
  within(canvas).getByRole('button', { name: 'Image' });

  fireEvent.click(screen.getByRole('button', { name: 'Auto arrange' }));

  await waitFor(() => assert.equal(writes.length, 3, 'auto arrange was not persisted'));
  // Layout is its own column: arranging must not resend the flow and risk clobbering it.
  assert.deepEqual(Object.keys(writes[2].data), ['mindmap']);
  const { positions } = writes[2].data.mindmap as TestPlan['mindmap'];
  assert.equal(Object.keys(positions).length, 2, 'a node was left unplaced');
});

test('connecting two nodes draws an edge and persists only the layout', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  const canvas = await twoBlocksOnTheMap();

  const port = within(canvas).getByRole('button', { name: 'Connect Text to another block' });
  // Press the dot on the bottom edge of the source node.
  fireEvent(port, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 168, clientY: 198 }));
  screen.getByText('Select another block to connect Text.');
  // jsdom has no PointerEvent, so dispatch a MouseEvent of the right type; React keys off the type.
  fireEvent(port, new MouseEvent('pointermove', { bubbles: true, clientX: 168, clientY: 320 }));
  // Releasing over another node is what commits the edge.
  fireEvent(port, new MouseEvent('pointerup', { bubbles: true, clientX: 168, clientY: 320 }));

  await waitFor(() => assert.equal(writes.length, 3, 'the connection was not persisted'));
  assert.deepEqual(Object.keys(writes[2].data), ['mindmap']);
  assert.equal((writes[2].data.mindmap as TestPlan['mindmap']).edges.length, 1);
  // The edge is removable from the canvas, not only via the editor.
  await screen.findByRole('button', { name: 'Remove the connection from Text to Image' });
});

test('a node can be edited in the map, and the edit is written as flow', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  const canvas = await twoBlocksOnTheMap();

  fireEvent.click(within(canvas).getByRole('button', { name: 'Text' }));
  const editor = (await screen.findByRole('heading', { level: 3, name: 'Editing Text' })).closest(
    '.flow-map-editor',
  ) as HTMLElement;
  fireEvent.change(within(editor).getByLabelText('Message'), { target: { value: 'Mapped hello' } });

  await waitFor(() => assert.equal(writes.length, 3, 'the map edit never reached the API'), { timeout: 3_000 });
  // Content belongs to the flow column; the map must not smuggle a layout write alongside it.
  assert.deepEqual(Object.keys(writes[2].data), ['flow']);
  assert.equal((writes[2].data.flow as TestBlock[])[0].text, 'Mapped hello');
});

test('a palette block dragged onto the canvas is placed where it was dropped', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  const textButton = await screen.findByRole('button', { name: 'Text' });

  // Dragging pulls the map into view, since it is the only drop target.
  fireEvent.dragStart(textButton);
  const canvas = await screen.findByRole('group', { name: 'Flow chart canvas' });
  assert.equal(screen.getByRole('button', { name: 'Flow chart' }).getAttribute('aria-pressed'), 'true');

  // jsdom has no DragEvent, so dispatch a MouseEvent carrying the drop point; React keys off the
  // event type rather than the constructor.
  fireEvent(canvas, new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 400, clientY: 260 }));

  await waitFor(() => assert.equal(writes.length, 1, 'the dropped block was not persisted'));
  // A drop changes both columns at once: the block joins the flow and its node joins the layout.
  assert.deepEqual(Object.keys(writes[0].data).sort(), ['flow', 'mindmap']);
  assert.equal((writes[0].data.flow as TestBlock[]).length, 1);
  const positions = (writes[0].data.mindmap as TestPlan['mindmap']).positions;
  // Centered on the drop point: (400 - 280/2, 260 - 160/2) over a zero-origin canvas.
  assert.deepEqual(Object.values(positions)[0], { x: 260, y: 180 });
  // And the new node is editable on the canvas like any other. Re-query it: the empty-state surface
  // is replaced by the populated canvas once the block lands.
  const populated = await screen.findByRole('group', { name: 'Flow chart canvas' });
  within(populated).getByRole('button', { name: 'Text' });
});

test('a line follows the cursor while a connection is being made', async () => {
  const { screen, fireEvent, within } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  const canvas = await twoBlocksOnTheMap();

  assert.equal(canvas.querySelector('.flow-map-connecting-line'), null, 'a line is drawn before a link is started');

  const port = within(canvas).getByRole('button', { name: 'Connect Text to another block' });
  fireEvent(port, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 168, clientY: 198 }));
  // Over empty canvas the line tracks the cursor, starting from the source node's bottom edge.
  fireEvent(port, new MouseEvent('pointermove', { bubbles: true, clientX: 420, clientY: 60 }));

  const preview = canvas.querySelector('.flow-map-connecting-line');
  assert.ok(preview, 'no line followed the cursor while connecting');
  // From the source node's bottom edge: (48 + 280/2, 48 + 160).
  assert.equal(preview.getAttribute('x1'), '188');
  assert.equal(preview.getAttribute('y1'), '208');
  assert.equal(preview.getAttribute('x2'), '420');
  assert.equal(preview.getAttribute('y2'), '60');

  // Over a target it snaps to that node's top edge to show where it will land.
  fireEvent(port, new MouseEvent('pointermove', { bubbles: true, clientX: 188, clientY: 320 }));
  const snapped = canvas.querySelector('.flow-map-connecting-line');
  assert.equal(snapped?.getAttribute('x2'), '188');
  assert.equal(snapped?.getAttribute('y2'), '268');

  // Releasing over empty space abandons the connection instead of inventing an edge.
  fireEvent(port, new MouseEvent('pointerup', { bubbles: true, clientX: 420, clientY: 60 }));
  assert.equal(canvas.querySelector('.flow-map-connecting-line'), null, 'the preview outlived the drag');
  assert.equal(writes.length, 2, 'an abandoned connection was persisted');
});

/* ---- Chart editing, deleting and copying ---- */

/** The node box around a card, so a test can address one node's controls among several. */
function nodeOf(canvas: HTMLElement, typeName: string): HTMLElement {
  return rtl.within(canvas).getByRole('button', { name: typeName }).closest('.flow-map-node') as HTMLElement;
}

test('a card shows media only when the block has media, and the type is a small badge icon', async () => {
  const { screen, fireEvent } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  const canvas = await twoBlocksOnTheMap();

  // A text block has nothing to show, so it gets no media plate: the type is read from the badge.
  const textCard = nodeOf(canvas, 'Text');
  assert.equal(textCard.querySelector('.flow-map-node-hero'), null, 'a text block was given an icon plate');
  assert.ok(
    textCard.querySelector('.flow-map-node-badge svg'),
    'the type badge carries no icon, so the card has no type marker at all',
  );

  const imageCard = nodeOf(canvas, 'Image');
  assert.ok(imageCard.querySelector('.flow-map-node-hero'), 'an image block lost its picture');
});

test('a media card with nothing on it yet takes the file from the card itself', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  const canvas = await twoBlocksOnTheMap();

  // An empty document block offers the picker on its card, so the chart can be filled without
  // hunting for the side panel.
  fireEvent.click(screen.getByRole('button', { name: 'File' }));
  const card = nodeOf(canvas, 'File');
  const picker = within(card).getByLabelText('Upload file') as HTMLInputElement;
  fireEvent.change(picker, { target: { files: [new File(['hello'], 'notes.pdf', { type: 'application/pdf' })] } });

  // The uploaded URL lands on the block and the file's name seeds the label.
  await waitFor(() => assert.equal(writes.length, 4, 'the upload never reached the API'), { timeout: 3_000 });
  assert.deepEqual(Object.keys(writes[3].data), ['flow']);
  const uploaded = (writes[3].data.flow as TestBlock[]).find(block => block.type === 'file');
  assert.ok(uploaded, 'the uploaded document is missing from the write');
  assert.equal(
    uploaded.mediaUrl,
    '/sessions/sess-1/plans/plan-1/media/uploaded.png',
    'the uploaded URL was not stored on the block',
  );
  assert.equal(uploaded.filename, 'photo.png');

  // With media on it the card shows the document instead of the picker, and offers replacement in
  // the panel rather than a second control on the card.
  assert.equal(within(card).queryByLabelText('Upload file'), null, 'the card still offers an empty-state picker');
  assert.ok(card.querySelector('.flow-map-node-hero .flow-media-file'), 'the document name is not shown on the card');
});

/** Drags the connect handle from the Text node onto the Image node, leaving one drawn edge. */
function connectTextToImage(canvas: HTMLElement): void {
  const { fireEvent, within } = rtl;
  const port = within(canvas).getByRole('button', { name: 'Connect Text to another block' });
  fireEvent(port, new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 188, clientY: 208 }));
  fireEvent(port, new MouseEvent('pointermove', { bubbles: true, clientX: 188, clientY: 340 }));
  fireEvent(port, new MouseEvent('pointerup', { bubbles: true, clientX: 188, clientY: 340 }));
}

test('a card edits its own field on the canvas, and the edit is written as flow', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  const canvas = await twoBlocksOnTheMap();

  // The chart is an editor, not only a view: the message is typed where it is drawn.
  fireEvent.change(within(nodeOf(canvas, 'Text')).getByLabelText('Message'), {
    target: { value: 'Typed on the card' },
  });

  await waitFor(() => assert.equal(writes.length, 3, 'the card edit never reached the API'), { timeout: 3_000 });
  assert.deepEqual(Object.keys(writes[2].data), ['flow']);
  assert.equal((writes[2].data.flow as TestBlock[])[0].text, 'Typed on the card');
});

test('a node can be deleted from the card, without leaving the chart', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  const canvas = await twoBlocksOnTheMap();

  fireEvent.click(within(nodeOf(canvas, 'Image')).getByRole('button', { name: 'Remove Image block' }));

  await waitFor(() => assert.equal(writes.length, 3, 'the removal was not persisted'));
  // Deleting is structural, so it is written through rather than waiting on the debounce.
  assert.deepEqual(Object.keys(writes[2].data), ['flow']);
  assert.equal((writes[2].data.flow as TestBlock[]).length, 1);
  await waitFor(() => assert.equal(within(canvas).queryByRole('button', { name: 'Image' }), null));
});

test('duplicating a node copies the block and gives the copy a place on the canvas', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  const canvas = await twoBlocksOnTheMap();

  fireEvent.click(within(nodeOf(canvas, 'Text')).getByRole('button', { name: 'Duplicate Text block' }));

  await waitFor(() => assert.equal(writes.length, 3, 'the copy was not persisted'));
  // A copy is a block *and* a node, so both columns are written in one go.
  assert.deepEqual(Object.keys(writes[2].data).sort(), ['flow', 'mindmap']);
  const flow = writes[2].data.flow as TestBlock[];
  assert.equal(flow.length, 3);
  assert.notEqual(flow[1].id, flow[0].id, 'the copy reused the original id, so one node would carry both');
  const positions = (writes[2].data.mindmap as TestPlan['mindmap']).positions;
  assert.ok(positions[flow[1].id], 'the copy was left without a place on the canvas');
  // The copy lands beside its original rather than exactly on top of it.
  const [originalBox, copyBox] = Array.from(canvas.querySelectorAll<HTMLElement>('.flow-map-node'));
  const [offsetX, offsetY] = [
    parseInt(copyBox.style.left, 10) - parseInt(originalBox.style.left, 10),
    parseInt(copyBox.style.top, 10) - parseInt(originalBox.style.top, 10),
  ];
  assert.ok(offsetX > 0 && offsetY > 0, 'the copy landed exactly on top of its original');
});

test('the chart reorders a block from the side panel, so the list view is not the only way', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  const canvas = await twoBlocksOnTheMap();

  fireEvent.click(within(canvas).getByRole('button', { name: 'Image' }));
  const editor = (await screen.findByRole('heading', { level: 3, name: 'Editing Image' })).closest(
    '.flow-map-editor',
  ) as HTMLElement;
  fireEvent.click(within(editor).getByRole('button', { name: 'Move Image block up' }));

  await waitFor(() => assert.equal(writes.length, 3, 'the reorder was not persisted'));
  const flow = writes[2].data.flow as TestBlock[];
  assert.deepEqual(
    flow.map(block => block.type),
    ['image', 'text'],
    'the block order that decides the send order did not change',
  );
});

test('a drawn edge can be selected and deleted with the Delete key', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  const canvas = await twoBlocksOnTheMap();

  connectTextToImage(canvas);
  await waitFor(() => assert.equal(writes.length, 3, 'the connection was not persisted'));

  // The drawn edge is a hairline, so it is painted twice: once to look at, once wide to click.
  const hit = canvas.querySelector('.flow-map-edge-hit') as SVGLineElement;
  assert.ok(hit, 'the edge has no pointer target');
  fireEvent.click(hit);
  await screen.findByText('Connection selected');

  fireEvent.keyDown(window, { key: 'Delete' });

  await waitFor(() => assert.equal(writes.length, 4, 'the edge deletion was not persisted'));
  assert.equal((writes[3].data.mindmap as TestPlan['mindmap']).edges.length, 0);
});

test('the Delete key is ignored while a card field has focus, so editing is not destructive', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));
  await screen.findByRole('button', { name: 'Text' });
  const canvas = await twoBlocksOnTheMap();

  connectTextToImage(canvas);
  await waitFor(() => assert.equal(writes.length, 3, 'the connection was not persisted'));
  fireEvent.click(canvas.querySelector('.flow-map-edge-hit') as SVGLineElement);
  await screen.findByText('Connection selected');

  // Focus a card field and press Delete there: that is a keystroke in a textarea, not a request to
  // drop the selected connection.
  const field = within(nodeOf(canvas, 'Text')).getByLabelText('Message');
  fireEvent.focus(field);
  fireEvent.keyDown(field, { key: 'Delete' });

  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(writes.length, 3, 'a keystroke inside a card field deleted the selected connection');
  await screen.findByText('Connection selected');
});

test('the plan itself can be renamed and deleted from the page it is edited on', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  resetPlans();
  renderFlow();

  await screen.findByText('Onboarding');
  fireEvent.click(screen.getByRole('button', { name: 'View plan Onboarding' }));

  fireEvent.click(await screen.findByRole('button', { name: 'Edit plan Onboarding' }));
  const rename = await screen.findByRole('dialog');
  fireEvent.change(within(rename).getByLabelText('Title'), { target: { value: 'Onboarding v2' } });
  fireEvent.click(within(rename).getByRole('button', { name: 'Save' }));

  await waitFor(() => assert.equal(plans[0].title, 'Onboarding v2'));
  await screen.findByRole('heading', { level: 1, name: 'Onboarding v2' });

  // Deleting asks first, and returns to the list without the plan on it.
  fireEvent.click(screen.getByRole('button', { name: 'Delete plan Onboarding v2' }));
  const confirm = await screen.findByRole('dialog');
  fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));

  await waitFor(() => assert.deepEqual(deletes, ['plan-1']));
  await screen.findByText('No plans yet');
});
