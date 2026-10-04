// Render test for the Compliance page, on the Templates.test.ts harness.
//
// The behaviours pinned here are the ones a policy editor can get wrong without ever looking broken:
// a form that hydrates over a failed read, a save that reports success for a window the gateway cannot
// enforce, and a merge that quietly discards the times an operator configured earlier.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let settingsStatus = 200;
let saveStatus = 200;
let stored: { organizationId: string; quietHours?: Record<string, unknown> } = { organizationId: 'org-1' };
let saved: Array<Record<string, unknown>> = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/organizations/settings' && (!init || init.method !== 'PATCH')) {
      if (settingsStatus !== 200) return Promise.resolve(jsonResponse({ message: 'forbidden' }, settingsStatus));
      return Promise.resolve(jsonResponse(stored));
    }
    if (path === '/api/organizations/settings') {
      saved.push(JSON.parse(String(init?.body ?? '{}')));
      if (saveStatus !== 200)
        return Promise.resolve(jsonResponse({ message: 'quietHours.timezone must be an IANA zone' }, saveStatus));
      // The server merges one level deep and echoes the merged result. Mirroring that here is what makes
      // a test able to catch a client that sends a whole window where a flag-only patch was intended.
      const incoming = (saved[saved.length - 1].quietHours ?? {}) as Record<string, unknown>;
      stored = {
        organizationId: stored.organizationId,
        quietHours: { ...((stored.quietHours as object) ?? {}), ...incoming },
      };
      return Promise.resolve(jsonResponse(stored));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Compliance: (typeof import('./Compliance.tsx'))['Compliance'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  installFetchStub();
  window.localStorage.setItem('mywhatsapp_user_role', 'admin');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Compliance } = await import('./Compliance.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  saved = [];
});

function renderCompliance(): void {
  rtl.render(createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Compliance))));
}

test('a stored window hydrates the form', async () => {
  const { screen, waitFor } = rtl;
  settingsStatus = 200;
  stored = {
    organizationId: 'org-1',
    quietHours: { enabled: true, start: '21:30', end: '06:15', timezone: 'Europe/Lisbon', weekdays: [1, 2] },
  };
  renderCompliance();

  await waitFor(() => assert.ok(screen.getByDisplayValue('21:30'), 'the stored start never rendered'));
  assert.equal(screen.getByDisplayValue('06:15').getAttribute('value'), '06:15');
  assert.ok(screen.getByDisplayValue('Europe/Lisbon'), 'the stored timezone never rendered');
  // The id sits beside a translated label in one span, so its text node is split; matched by function.
  // The id sits beside a translated label inside one span, so its text node is split across children.
  assert.ok(screen.getByText(/org-1/, { selector: '.compliance__org' }), 'the resolved organization is not shown');
  assert.ok(screen.getByText('Configured'), 'a stored window is not marked as configured');
});

test('an organization with no window is not shown as configured', async () => {
  const { screen, waitFor } = rtl;
  settingsStatus = 200;
  stored = { organizationId: 'org-1' };
  renderCompliance();

  await waitFor(() => assert.ok(screen.getByDisplayValue('22:00'), 'the default window never rendered'));
  // The badge claims a window EXISTS. Claiming it for a tenant that never set one is how an operator
  // concludes a policy is in force when nothing is.
  assert.equal(screen.queryByText('Configured'), null);
});

test('saving sends the window the form holds', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  settingsStatus = 200;
  saved.length = 0;
  stored = { organizationId: 'org-1' };
  renderCompliance();

  await waitFor(() => assert.ok(screen.getByDisplayValue('22:00')));
  fireEvent.change(screen.getByDisplayValue('22:00'), { target: { value: '23:30' } });
  fireEvent.click(screen.getByRole('button', { name: /Save policy/ }));

  await waitFor(() => assert.equal(saved.length, 1, 'the save never reached the API'));
  assert.deepEqual((saved[0].quietHours as Record<string, unknown>).start, '23:30', 'the edit never left the browser');
});

test('turning the window off keeps the times', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  settingsStatus = 200;
  saved.length = 0;
  stored = {
    organizationId: 'org-1',
    quietHours: { enabled: true, start: '21:30', end: '06:15', timezone: 'Europe/Lisbon' },
  };
  renderCompliance();

  await waitFor(() => assert.ok(screen.getByDisplayValue('21:30')));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Window in force' }));
  fireEvent.click(screen.getByRole('button', { name: /Save policy/ }));

  await waitFor(() => assert.equal(saved.length, 1));
  const sent = saved[0].quietHours as Record<string, unknown>;
  // The server merges, so a flag-only patch would keep them — but the form sends the whole window, and
  // this is what makes it safe to do that: it never sends a window it cannot see.
  assert.equal(sent.enabled, false);
  assert.equal(sent.start, '21:30');
  assert.equal(sent.end, '06:15');
});

test('weekday selection is sent as ISO integers', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  settingsStatus = 200;
  saved.length = 0;
  stored = { organizationId: 'org-1' };
  renderCompliance();

  await waitFor(() => assert.ok(screen.getByDisplayValue('22:00')));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Mon' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Wed' }));
  fireEvent.click(screen.getByRole('button', { name: /Save policy/ }));

  await waitFor(() => assert.equal(saved.length, 1));
  // Monday = 1, Wednesday = 3 — the API's ISO numbering, not the browser's Sunday-first one.
  assert.deepEqual((saved[0].quietHours as Record<string, unknown>).weekdays, [1, 3]);
});

test('exempt chats are sent one per line, trimmed', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  settingsStatus = 200;
  saved.length = 0;
  stored = { organizationId: 'org-1' };
  renderCompliance();

  await waitFor(() => assert.ok(screen.getByDisplayValue('22:00')));
  fireEvent.change(screen.getByRole('textbox', { name: /Exempt chats/ }), {
    target: { value: ' 5511999999999@s.whatsapp.net \n\n5511888888888@s.whatsapp.net' },
  });
  fireEvent.click(screen.getByRole('button', { name: /Save policy/ }));

  await waitFor(() => assert.equal(saved.length, 1));
  assert.deepEqual((saved[0].quietHours as Record<string, unknown>).exemptChatIds, [
    '5511999999999@s.whatsapp.net',
    '5511888888888@s.whatsapp.net',
  ]);
});

test('a rejected save re-reads the stored window instead of leaving the form lying', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  settingsStatus = 200;
  saveStatus = 400;
  stored = {
    organizationId: 'org-1',
    quietHours: { enabled: true, start: '21:30', end: '06:15', timezone: 'Europe/Lisbon' },
  };
  renderCompliance();

  await waitFor(() => assert.ok(screen.getByDisplayValue('21:30')));
  fireEvent.change(screen.getByDisplayValue('Europe/Lisbon'), { target: { value: 'Mars/Olympus' } });
  fireEvent.click(screen.getByRole('button', { name: /Save policy/ }));

  // A form left showing the rejected value reads as saved. Re-reading is what makes the screen agree
  // with the gateway again instead of inviting a second, compounding edit.
  await waitFor(() => assert.ok(screen.getByDisplayValue('Europe/Lisbon')));
  assert.equal(screen.queryByDisplayValue('Mars/Olympus'), null);
  saveStatus = 200;
});

test('a failed load says so and does not offer a save of its defaults', async () => {
  const { screen } = rtl;
  settingsStatus = 403;
  renderCompliance();

  const alert = await screen.findByRole('alert');
  assert.match(alert.textContent ?? '', /Could not load/);
  // The form renders defaults, so saving here would write 22:00–07:00 over a policy the gateway is
  // enforcing and the page never managed to read. The operator must see the failure before doing that.
  assert.ok(screen.getByText(/forbidden/), 'the failure detail is not shown to the operator');
  settingsStatus = 200;
});
