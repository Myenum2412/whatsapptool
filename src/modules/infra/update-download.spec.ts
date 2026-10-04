import { withSafeFetch } from '../../common/security/ssrf-guard';
import { fetchSafeBuffer } from './update-download';

jest.mock('../../common/security/ssrf-guard', () => ({ withSafeFetch: jest.fn() }));

/**
 * `fetchSafeBuffer` is the only server-side download left in the gateway (the update check pulls its
 * release manifest through it), so its byte cap is a memory-exhaustion guard rather than a nicety.
 * The SSRF guard is exercised in its own suite; here `withSafeFetch` is stubbed and only the body
 * reader - status check, declared-length rejection, streaming cap, empty-body refusal - is asserted.
 */
describe('fetchSafeBuffer', () => {
  const safeFetch = withSafeFetch as jest.MockedFunction<typeof withSafeFetch>;

  const bodyOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

  type GuardResponse = Parameters<Parameters<typeof withSafeFetch>[2]>[0];

  const response = (init: { ok?: boolean; status?: number; length?: string; body?: unknown }): GuardResponse =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      headers: new Headers(init.length === undefined ? {} : { 'content-length': init.length }),
      body: init.body,
    }) as unknown as GuardResponse;

  /** Run the `use` callback the caller handed `withSafeFetch` against a canned response. */
  const runAgainst = async (res: GuardResponse, opts?: { maxBytes?: number; timeoutMs?: number }) => {
    safeFetch.mockImplementation((_url, _init, use) => Promise.resolve(use(res)));
    return fetchSafeBuffer('https://example.test/manifest.json', opts);
  };

  beforeEach(() => safeFetch.mockReset());

  it('always downloads behind the SSRF guard, following redirects (release hosts 302 to a CDN)', async () => {
    safeFetch.mockImplementation((_url, _init, use) =>
      Promise.resolve(use(response({ body: bodyOf(Buffer.from('ok')) }))),
    );

    await fetchSafeBuffer('https://example.test/manifest.json');

    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][3]).toEqual({ followRedirects: true });
  });

  it('bounds the fetch with a timeout signal', async () => {
    safeFetch.mockImplementation((_url, _init, use) =>
      Promise.resolve(use(response({ body: bodyOf(Buffer.from('ok')) }))),
    );

    await fetchSafeBuffer('https://example.test/manifest.json', { timeoutMs: 1234 });

    const init = safeFetch.mock.calls[0][1] as RequestInit & { signal?: AbortSignal };
    expect(init.signal).toBeDefined();
  });

  it('returns the concatenated body', async () => {
    const buf = await runAgainst(response({ body: bodyOf(Buffer.from('{"tag":"v1"}')) }));
    expect(buf.toString()).toBe('{"tag":"v1"}');
  });

  it('rejects a non-2xx response instead of buffering the error page', async () => {
    await expect(runAgainst(response({ ok: false, status: 404, body: bodyOf(Buffer.from('nope')) }))).rejects.toThrow(
      /download failed with status 404/,
    );
  });

  it('rejects on a declared content-length over the cap without reading the body', async () => {
    await expect(
      runAgainst(response({ length: '2048', body: bodyOf(Buffer.alloc(2048)) }), { maxBytes: 1024 }),
    ).rejects.toThrow(/exceeds the 1024-byte limit/);
  });

  it('rejects a body that grows past the cap while streaming (Content-Length absent or wrong)', async () => {
    const chunks = [Buffer.alloc(600), Buffer.alloc(600)];
    await expect(runAgainst(response({ body: bodyOf(...chunks) }), { maxBytes: 1024 })).rejects.toThrow(
      /exceeds the 1024-byte limit/,
    );
  });

  it('accepts a body that sits exactly on the cap', async () => {
    const buf = await runAgainst(response({ body: bodyOf(Buffer.alloc(1024)) }), { maxBytes: 1024 });
    expect(buf).toHaveLength(1024);
  });

  it('cancels the reader once the cap trips, so the peer stream is not left draining', async () => {
    const cancel = jest.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(600));
        controller.enqueue(Buffer.alloc(600));
      },
      cancel,
    });

    await expect(runAgainst(response({ body: stream }), { maxBytes: 1024 })).rejects.toThrow(/exceeds/);
    expect(cancel).toHaveBeenCalled();
  });

  it('refuses a response with no readable body', async () => {
    await expect(runAgainst(response({ body: undefined }))).rejects.toThrow(/no body/);
  });

  it('coerces a non-finite or non-positive cap to the 5 MiB default rather than making the guard inert', async () => {
    for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      safeFetch.mockReset();
      // 5 MiB exactly: accepted under the default, so the fallback is in force and not a tiny cap.
      const buf = await runAgainst(response({ body: bodyOf(Buffer.alloc(5 * 1024 * 1024)) }), { maxBytes });
      expect(buf).toHaveLength(5 * 1024 * 1024);
    }
  });
});
