// Signup page under the bare `node --test` runner: posts to /api/auth/register (the public
// self-signup surface), surfaces 409/"taken" and validation errors, and hands the created email
// back to App so it can switch to the login view pre-filled.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

let registerCalls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
let registerStatus = 201;
let registerData: Record<string, unknown> = {};

function installFetchStub(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/auth/register') {
      registerCalls.push({
        url: path,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      });
      return Promise.resolve(jsonResponse(registerData, registerStatus));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
  }) as typeof fetch;
}

let rtl: typeof import('@testing-library/react');
let Signup: (typeof import('./Signup.tsx'))['Signup'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals('http://localhost/');
  (globalThis as Record<string, unknown>).__APP_VERSION__ = '0.0.0-test';
  (globalThis as Record<string, unknown>).__BUILD_TIME__ = 1700000000000;
  // jsdom has no matchMedia; the theme hook reads it for the system preference.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  installFetchStub();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ Signup } = await import('./Signup.tsx'));
});

beforeEach(() => {
  registerCalls = [];
  registerStatus = 201;
  registerData = { id: 'u1', email: 'op@example.com', name: 'Op', role: 'users', isActive: true, lastLoginAt: null };
});
afterEach(() => {
  rtl.cleanup();
});

const input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;

async function submitSignup(email: string, password: string, name = ''): Promise<void> {
  if (name) rtl.fireEvent.change(input('signup-name'), { target: { value: name } });
  rtl.fireEvent.change(input('signup-email'), { target: { value: email } });
  rtl.fireEvent.change(input('signup-password'), { target: { value: password } });
  rtl.fireEvent.click(document.querySelector('button[type="submit"]') as HTMLButtonElement);
}

test('posts to /api/auth/register and hands the created email back on success', async () => {
  let signedUp = '';
  rtl.render(
    createElement(Signup, {
      onSignup: email => {
        signedUp = email;
      },
      onSwitch: () => undefined,
    }),
  );

  await submitSignup(' Op@Example.com ', 'correct-horse', 'Amar N');

  await rtl.waitFor(() => assert.equal(registerCalls.length, 1));
  assert.deepEqual(registerCalls[0].body, {
    email: 'Op@Example.com',
    password: 'correct-horse',
    name: 'Amar N',
  });
  await rtl.waitFor(() => assert.equal(signedUp, 'Op@Example.com'));
});

test('omits the name field when it is blank', async () => {
  rtl.render(createElement(Signup, { onSignup: () => undefined, onSwitch: () => undefined }));

  await submitSignup('op@example.com', 'correct-horse');
  await rtl.waitFor(() => assert.equal(registerCalls.length, 1));
  assert.deepEqual(registerCalls[0].body, { email: 'op@example.com', password: 'correct-horse' });
});

test('shows the taken-email message on 409 and does not sign up', async () => {
  registerStatus = 409;
  registerData = { message: 'An account already exists' };
  let signedUp = '';
  rtl.render(createElement(Signup, { onSignup: email => (signedUp = email), onSwitch: () => undefined }));

  await submitSignup('taken@example.com', 'correct-horse');
  await rtl.waitFor(() => assert.ok(document.querySelector('.error-message')?.textContent?.includes('already exists')));
  assert.equal(signedUp, '');
});

test('rejects a short password client-side without calling the API', async () => {
  rtl.render(createElement(Signup, { onSignup: () => undefined, onSwitch: () => undefined }));

  await submitSignup('op@example.com', 'short');
  await rtl.waitFor(() =>
    assert.ok(document.querySelector('.error-message')?.textContent?.includes('at least 8 characters')),
  );
  assert.equal(registerCalls.length, 0);
});

test('the back-to-login link fires onSwitch', () => {
  let switched = false;
  rtl.render(createElement(Signup, { onSignup: () => undefined, onSwitch: () => (switched = true) }));

  rtl.fireEvent.click(document.querySelector('button.login-switch') as HTMLButtonElement);
  assert.equal(switched, true);
});
