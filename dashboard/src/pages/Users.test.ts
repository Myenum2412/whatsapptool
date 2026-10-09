// Render test for the Users page under the bare `node --test` runner, on the Templates.test.ts
// harness. The account endpoints live under `/auth/users` and are orgmenu-only at the backend, but
// the page itself renders regardless of role; what matters here is the list/create/toggle/delete
// contract with those endpoints.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

interface Row {
  id: string;
  email: string;
  name: string | null;
  role: 'orgmenu' | 'users';
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

let rows: Row[] = [];
const created: Array<Record<string, unknown>> = [];
const updated: Array<{ id: string; data: Record<string, unknown> }> = [];
const deleted: string[] = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';

    if (path === '/api/auth/users' && method === 'GET') {
      return Promise.resolve(jsonResponse(rows));
    }
    if (path === '/api/auth/users' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      created.push(body);
      const record: Row = {
        id: `u-${rows.length + 1}`,
        email: String(body.email),
        name: typeof body.name === 'string' && body.name.length ? body.name : null,
        role: body.role === 'orgmenu' ? 'orgmenu' : 'users',
        isActive: true,
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
      };
      rows = [...rows, record];
      return Promise.resolve(jsonResponse(record, 201));
    }
    const rowMatch = /^\/api\/auth\/users\/([^/]+)$/.exec(path);
    if (rowMatch) {
      const id = rowMatch[1];
      if (method === 'DELETE') {
        deleted.push(id);
        rows = rows.filter(r => r.id !== id);
        return Promise.resolve(jsonResponse({ success: true }));
      }
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        updated.push({ id, data: body });
        rows = rows.map(r => {
          if (r.id !== id) return r;
          const merged = { ...r, ...body } as Row;
          if ('name' in body) merged.name = body.name === null ? null : String(body.name);
          return merged;
        });
        return Promise.resolve(jsonResponse(rows.find(r => r.id === id) as Row));
      }
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Users: (typeof import('./Users.tsx'))['Users'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  window.localStorage.setItem('mywhatsapp_user_role', 'orgmenu');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Users } = await import('./Users.tsx'));
});

afterEach(() => {
  rows = [];
  created.length = 0;
  updated.length = 0;
  deleted.length = 0;
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

function renderUsers(): void {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Users))),
    ),
  );
}

test('an empty list renders the empty state, not a broken table', async () => {
  const { screen } = rtl;
  renderUsers();
  assert.ok(await screen.findByText('No users yet'));
  assert.ok(screen.getByText('Create a login account for a team member.'));
  assert.equal(screen.queryByText('ops@example.com'), null);
});

test('creating a user validates first, then sends the expected POST and renders the new row', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;

  renderUsers();
  fireEvent.click(await screen.findByRole('button', { name: 'Add user' }));
  const dialog = await screen.findByRole('dialog');

  fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'not-an-email' } });
  fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'short' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add user' }));

  assert.ok(await within(dialog).findByText('Enter a valid email address.'));
  assert.equal(created.length, 0, 'an invalid email must not reach the API');

  fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'jane@example.com' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add user' }));

  assert.ok(await within(dialog).findByText('The password must be at least 8 characters.'));
  assert.equal(created.length, 0, 'a short password must not reach the API');

  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Jane' } });
  fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'supersecret' } });
  fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'users' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add user' }));

  await waitFor(() => assert.equal(created.length, 1, 'the create request never reached the API'));
  assert.deepEqual(created[0], { email: 'jane@example.com', password: 'supersecret', role: 'users', name: 'Jane' });

  const row = (await screen.findByText('jane@example.com')).closest('tr') as HTMLElement;
  assert.ok(within(row).getByText('Jane'));
  assert.ok(within(row).getByText('Users'));
  assert.ok(within(row).getByText('Active'));
  assert.ok(screen.getByText('User created.'));
});

test('renders the role and status badges for both account tiers', async () => {
  const { screen, within } = rtl;
  rows = [
    {
      id: 'u-1',
      email: 'boss@example.com',
      name: 'Boss',
      role: 'orgmenu',
      isActive: true,
      createdAt: '2026-01-15T00:00:00.000Z',
      updatedAt: '2026-01-15T00:00:00.000Z',
    },
    {
      id: 'u-2',
      email: 'ops@example.com',
      name: null,
      role: 'users',
      isActive: false,
      createdAt: '2026-01-20T00:00:00.000Z',
      updatedAt: '2026-01-20T00:00:00.000Z',
    },
  ];

  renderUsers();

  const boss = (await screen.findByText('boss@example.com')).closest('tr') as HTMLElement;
  assert.ok(within(boss).getByText('Org Menu'));
  assert.ok(within(boss).getByText('Active'));

  const ops = screen.getByText('ops@example.com').closest('tr') as HTMLElement;
  assert.ok(within(ops).getByText('Users'));
  assert.ok(within(ops).getByText('Disabled'));
  assert.ok(within(ops).getByText('—'));
});

test('toggling a user sends the isActive PATCH and the badge flips', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  rows = [
    {
      id: 'u-1',
      email: 'ops@example.com',
      name: null,
      role: 'users',
      isActive: true,
      createdAt: '2026-01-15T00:00:00.000Z',
      updatedAt: '2026-01-15T00:00:00.000Z',
    },
  ];

  renderUsers();
  const row = (await screen.findByText('ops@example.com')).closest('tr') as HTMLElement;

  fireEvent.click(within(row).getByRole('button', { name: 'Disable' }));
  await waitFor(() => assert.deepEqual(updated[0], { id: 'u-1', data: { isActive: false } }));
  await waitFor(() => assert.ok(within(row).getByText('Disabled')));
  assert.ok(screen.getByText('User disabled.'));
});

test('editing a user sends the expected PATCH and keeps an untouched password out of the body', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  rows = [
    {
      id: 'u-1',
      email: 'ops@example.com',
      name: 'Ops O.',
      role: 'users',
      isActive: true,
      createdAt: '2026-01-15T00:00:00.000Z',
      updatedAt: '2026-01-15T00:00:00.000Z',
    },
  ];

  renderUsers();
  const row = (await screen.findByText('ops@example.com')).closest('tr') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));

  const dialog = await screen.findByRole('dialog');
  assert.ok(within(dialog).getByText('ops@example.com'));
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Ops Manager' } });
  fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'orgmenu' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() =>
    assert.deepEqual(updated[0], { id: 'u-1', data: { name: 'Ops Manager', role: 'orgmenu', isActive: true } }),
  );
  assert.ok(screen.getByText('User updated.'));
});

test('deleting a user is confirmed, hits DELETE, and the empty state returns', async () => {
  const { screen, fireEvent, within, waitFor } = rtl;
  rows = [
    {
      id: 'u-1',
      email: 'ops@example.com',
      name: null,
      role: 'users',
      isActive: true,
      createdAt: '2026-01-15T00:00:00.000Z',
      updatedAt: '2026-01-15T00:00:00.000Z',
    },
  ];

  renderUsers();
  const row = (await screen.findByText('ops@example.com')).closest('tr') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));

  const dialog = await screen.findByRole('dialog');
  assert.ok(within(dialog).getByText(/Permanently delete this account/));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

  await waitFor(() => assert.deepEqual(deleted, ['u-1'], 'the delete never reached the API'));
  assert.ok(await screen.findByText('No users yet'));
  assert.ok(screen.getByText('User deleted.'));
});
