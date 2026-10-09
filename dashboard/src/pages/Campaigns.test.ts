// Render test for the Campaigns (mail merge) page under the bare `node --test` runner, on the
// Templates.test.ts harness. Pins the three things an operator relies on: the wizard refuses a
// message whose {{placeholder}} matches no spreadsheet column before anything is uploaded for real,
// a paused campaign says WHY it paused, and sending only starts after an explicit confirm.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Call = { method: string; path: string; form?: Record<string, string> };
const calls: Call[] = [];

const campaign = {
  id: 'cmp-1',
  sessionId: 'sess-1',
  name: 'Oct renewals',
  status: 'paused',
  pauseReason: 'PACING_LIMITED',
  templateId: null,
  header: null,
  body: 'Hi {{Name}}',
  footer: null,
  columns: [
    { header: 'Name', key: 'Name' },
    { header: 'Phone', key: 'Phone' },
  ],
  phoneColumn: 'Phone',
  mediaColumn: null,
  mediaType: 'auto',
  delayMs: 5000,
  randomizeDelay: true,
  progress: { total: 3, pending: 1, sent: 1, failed: 0, skipped: 1 },
  sourceFilename: 'list.xlsx',
  createdAt: '2026-09-24T00:00:00.000Z',
  updatedAt: '2026-09-24T00:00:00.000Z',
  startedAt: '2026-09-24T00:00:00.000Z',
  completedAt: null,
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    const form =
      init?.body instanceof FormData
        ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '<file>']))
        : undefined;
    calls.push({ method, path, form });

    if (path === '/api/sessions') {
      return Promise.resolve(
        jsonResponse([
          {
            id: 'sess-1',
            name: 'billing-bot',
            status: 'ready',
            createdAt: campaign.createdAt,
            updatedAt: campaign.updatedAt,
          },
        ]),
      );
    }
    if (path === '/api/sessions/sess-1/templates') return Promise.resolve(jsonResponse([]));
    if (path === '/api/sessions/sess-1/campaigns' && method === 'GET') {
      return Promise.resolve(
        jsonResponse([campaign, { ...campaign, id: 'cmp-3', name: 'Poll campaign', status: 'completed' }]),
      );
    }
    if (path === '/api/sessions/sess-1/campaigns/inspect') {
      return Promise.resolve(
        jsonResponse({
          columns: [
            { header: 'Name', key: 'Name' },
            { header: 'Mobile No', key: 'Mobile_No' },
            { header: 'Invoice', key: 'Invoice' },
          ],
          rowCount: 2,
          sampleRows: [
            { Name: 'Asha', Mobile_No: '9876543210', Invoice: 'INV-1.pdf' },
            { Name: 'Ravi', Mobile_No: '9123456780', Invoice: 'INV-2.pdf' },
          ],
          suggestedPhoneColumn: 'Mobile No',
        }),
      );
    }
    if (path === '/api/sessions/sess-1/campaigns' && method === 'POST') {
      return Promise.resolve(
        jsonResponse(
          {
            ...campaign,
            id: 'cmp-2',
            status: 'draft',
            skippedByReason: {},
            preview: [],
            attachments: [],
            missingAttachments: [],
          },
          201,
        ),
      );
    }
    if (path === '/api/sessions/sess-1/campaigns/cmp-2/attachments') {
      return Promise.resolve(jsonResponse({ attachment: {}, rowsMatched: 1 }, 201));
    }
    if (path === '/api/sessions/sess-1/campaigns/cmp-1') {
      return Promise.resolve(
        jsonResponse({
          ...campaign,
          skippedByReason: { INVALID_PHONE: 1 },
          preview: [{ rowNumber: 4, chatId: '919000000001@c.us', text: 'Hi Ravi', attachments: ['brochure.pdf'] }],
          attachments: [
            {
              id: 'att-1',
              scope: 'all',
              filename: 'brochure.pdf',
              mimetype: 'application/pdf',
              sizeBytes: 2048,
              sendAs: 'document',
              createdAt: campaign.createdAt,
            },
          ],
          missingAttachments: [],
        }),
      );
    }
    if (path.startsWith('/api/sessions/sess-1/campaigns/cmp-3/recipients')) {
      return Promise.resolve(
        jsonResponse({
          items: [
            {
              id: 'r1',
              rowNumber: 2,
              chatId: '919000000001@c.us',
              status: 'sent',
              variables: {},
              errorCode: null,
              errorMessage: null,
              messageId: 'm1',
              sentAt: campaign.createdAt,
              response: ['Interested'],
              responseVia: 'poll',
              respondedAt: campaign.createdAt,
            },
          ],
          total: 1,
          page: 1,
          limit: 50,
        }),
      );
    }
    if (path === '/api/sessions/sess-1/campaigns/cmp-3') {
      return Promise.resolve(
        jsonResponse({
          ...campaign,
          id: 'cmp-3',
          name: 'Poll campaign',
          status: 'completed',
          pauseReason: null,
          responseStyle: 'poll',
          responseQuestion: 'Interested?',
          responseOptions: ['Interested', 'Not interested'],
          responseMultiple: false,
          skippedByReason: {},
          preview: [],
          attachments: [],
          missingAttachments: [],
          responseSummary: {
            options: [
              { option: 'Interested', count: 3 },
              { option: 'Not interested', count: 1 },
            ],
            responded: 4,
            awaiting: 6,
          },
        }),
      );
    }
    if (path.startsWith('/api/sessions/sess-1/campaigns/cmp-1/recipients')) {
      return Promise.resolve(jsonResponse({ items: [], total: 0, page: 1, limit: 50 }));
    }
    if (path === '/api/sessions/sess-1/campaigns/cmp-1/start') {
      return Promise.resolve(jsonResponse({ ...campaign, status: 'running', pauseReason: null }));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Campaigns: (typeof import('./Campaigns.tsx'))['Campaigns'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Campaigns } = await import('./Campaigns.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
  calls.length = 0;
});

function renderCampaigns(role = 'users'): void {
  window.localStorage.setItem('mywhatsapp_user_role', role);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Campaigns))),
    ),
  );
}

test('a paused campaign explains why, previews the next message, and starts only after a confirm', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  renderCampaigns();

  fireEvent.click(await screen.findByText('Oct renewals'));
  await screen.findByText(/send-pacing limit/);
  screen.getByText('Hi Ravi');
  screen.getByText(/Invalid phone: 1/);
  // The file going to everyone is listed, and shown on the preview of what each person gets.
  assert.ok(screen.getAllByText('brochure.pdf').length >= 2);
  // Not a draft any more: files can no longer be added.
  assert.equal(screen.queryByRole('button', { name: 'Add files for everyone' }), null);

  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  const dialog = await screen.findByRole('dialog');
  assert.equal(
    calls.some(c => c.path.endsWith('/start')),
    false,
    'opening the confirm must not start sending',
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start sending' }));
  await waitFor(() =>
    assert.ok(calls.some(c => c.method === 'POST' && c.path === '/api/sessions/sess-1/campaigns/cmp-1/start')),
  );
});

test('the wizard blocks a placeholder with no matching column, then submits the mapped fields', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderCampaigns();

  fireEvent.click(await screen.findByRole('button', { name: 'New campaign' }));
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['Name,Mobile No\nAsha,9876543210\n'], 'list.csv', { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });

  await screen.findByText(/list\.csv — 2 rows, 3 columns/);
  // The suggested phone column is pre-selected by key.
  assert.equal((screen.getByLabelText('Phone number column') as HTMLSelectElement).value, 'Mobile_No');

  const body = screen.getByLabelText('Message') as HTMLTextAreaElement;
  fireEvent.change(body, { target: { value: 'Hi {{Nmae}}' } });
  await screen.findByText(/don't match any column: \{\{Nmae\}\}/);
  const create = screen.getByRole('button', { name: 'Validate & create draft' }) as HTMLButtonElement;
  assert.equal(create.disabled, true, 'a typo placeholder must block creation');

  fireEvent.change(body, { target: { value: 'Hi {{Name}}' } });
  await screen.findByText('Hi Asha');
  await waitFor(() => assert.equal(create.disabled, false));
  fireEvent.click(create);

  await waitFor(() => {
    const post = calls.find(c => c.method === 'POST' && c.path === '/api/sessions/sess-1/campaigns');
    assert.ok(post, 'the create request was never sent');
    assert.equal(post.form?.file, '<file>');
    assert.equal(post.form?.phoneColumn, 'Mobile_No');
    assert.equal(post.form?.body, 'Hi {{Name}}');
    assert.equal(post.form?.delayMs, '5000');
    assert.equal(post.form?.name, 'list');
  });
});

test('an unrecognized cached role cannot start a new campaign', async () => {
  renderCampaigns('superuser');
  const button = (await rtl.screen.findByRole('button', { name: 'New campaign' })) as HTMLButtonElement;
  assert.equal(button.disabled, true);
});

test('files chosen in the wizard are uploaded one by one after the draft is created, each with its scope', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderCampaigns();

  fireEvent.click(await screen.findByRole('button', { name: 'New campaign' }));
  const sheetInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(sheetInput, {
    target: { files: [new File(['x'], 'list.csv', { type: 'text/csv' })] },
  });
  await screen.findByText(/list\.csv — 2 rows, 3 columns/);
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi {{Name}}' } });

  const fileInputs = () => [...document.querySelectorAll('input[type="file"][multiple]')] as HTMLInputElement[];
  fireEvent.change(fileInputs()[0], {
    target: { files: [new File(['%PDF'], 'brochure.pdf', { type: 'application/pdf' })] },
  });
  await screen.findByText('brochure.pdf');

  fireEvent.change(screen.getByLabelText('Column with each person’s file name'), { target: { value: 'Invoice' } });
  await waitFor(() => assert.equal(fileInputs().length, 2));
  fireEvent.change(fileInputs()[1], {
    target: { files: [new File(['%PDF'], 'inv-1.PDF', { type: 'application/pdf' })] },
  });
  // Matching mirrors the server: case-insensitive on the file name.
  await screen.findByText('✓ INV-1.pdf');
  screen.getByText(/✗ INV-2\.pdf — not added yet/);

  fireEvent.click(screen.getByRole('button', { name: 'Validate & create draft' }));
  await waitFor(() => {
    const uploads = calls.filter(c => c.path === '/api/sessions/sess-1/campaigns/cmp-2/attachments');
    assert.deepEqual(
      uploads.map(u => [u.form?.scope, u.form?.file]),
      [
        ['all', '<file>'],
        ['row', '<file>'],
      ],
    );
  });
  const create = calls.find(c => c.method === 'POST' && c.path === '/api/sessions/sess-1/campaigns');
  assert.equal(create?.form?.mediaColumn, 'Invoice');
  // The draft is created before any file is sent, and files never ride on the create request.
  assert.ok(calls.indexOf(create!) < calls.findIndex(c => c.path.endsWith('/attachments')));
});

test('the wizard collects custom response options, blocks invalid ones, and sends them as one JSON field', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderCampaigns();

  fireEvent.click(await screen.findByRole('button', { name: 'New campaign' }));
  const sheetInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(sheetInput, { target: { files: [new File(['x'], 'list.csv', { type: 'text/csv' })] } });
  await screen.findByText(/list\.csv — 2 rows, 3 columns/);
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi {{Name}}' } });

  fireEvent.click(screen.getByLabelText('Ask for a response'));
  // Poll by default, with a stock question and a preview of the poll the first row will get.
  assert.equal((screen.getByLabelText('Poll question') as HTMLInputElement).value, 'Are you interested?');
  await screen.findByLabelText('Poll preview');

  fireEvent.click(screen.getByRole('button', { name: 'Yes / No / Maybe' }));
  fireEvent.change(screen.getByLabelText('Option 3'), { target: { value: 'yes' } });
  await screen.findByText('Two options are the same.');
  const create = screen.getByRole('button', { name: 'Validate & create draft' }) as HTMLButtonElement;
  assert.equal(create.disabled, true);

  fireEvent.change(screen.getByLabelText('Option 3'), { target: { value: 'Call me back' } });
  fireEvent.change(screen.getByLabelText('Poll question'), { target: { value: 'Interested, {{Name}}?' } });
  await screen.findByText('Interested, Asha?');

  // Switching to a numbered list moves the options into the message text.
  fireEvent.click(screen.getByLabelText(/Numbered list/));
  await screen.findByText(/Hi Asha\s+Interested, Asha\?\s+1\. Yes\s+2\. No\s+3\. Call me back/);

  await waitFor(() => assert.equal(create.disabled, false));
  fireEvent.click(create);
  await waitFor(() => {
    const post = calls.find(c => c.method === 'POST' && c.path === '/api/sessions/sess-1/campaigns');
    assert.ok(post);
    assert.equal(post.form?.responseStyle, 'reply');
    assert.equal(post.form?.responseQuestion, 'Interested, {{Name}}?');
    assert.deepEqual(JSON.parse(post.form?.responseOptions ?? '[]'), ['Yes', 'No', 'Call me back']);
    assert.equal(post.form?.responseMultiple, 'false');
  });
});

test('a campaign with responses shows answers per option, and a bar filters the rows to that answer', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  renderCampaigns();

  fireEvent.click(await screen.findByText('Poll campaign'));
  await screen.findByText(/4 of 10 answered \(40%\)/);
  screen.getByText('3 · 30%');
  screen.getByText('6 · 60%');

  fireEvent.click(screen.getByRole('button', { name: /^Interested\s*3 · 30%/ }));
  await waitFor(() =>
    assert.ok(calls.some(c => c.path.includes('/cmp-3/recipients') && c.path.includes('response=Interested'))),
  );
  // The row's answer and how it arrived.
  await screen.findByText(/· poll/);
});
