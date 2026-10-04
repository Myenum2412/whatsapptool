/**
 * MyWhatsapp JavaScript/TypeScript SDK — client core.
 *
 * The {@link MyWhatsappClient} is the single entry point. It holds configuration
 * (base URL, API key, timeout, injectable transport) and exposes domain
 * resources as properties:
 *
 * ```typescript
 * import { MyWhatsappClient } from '@mywhatsapp/sdk';
 *
 * const client = new MyWhatsappClient({
 *   baseUrl: 'http://localhost:2785',
 *   apiKey: 'owa_k1_…',
 * });
 *
 * await client.sessions.start('my-session');
 * await client.messages.sendText('my-session', {
 *   chatId: '628123456789@c.us',
 *   text: 'Hello from the MyWhatsapp SDK!',
 * });
 * ```
 *
 * @packageDocumentation
 */

import { request, requestBytes, encodeSegment, warnIfInsecureHttpUrl, type BinaryResponse, type ClientConfig, type FetchLike, type RequestOptions } from './http.js';
import { CallsResource } from './resources/calls.js';
import { MediaResource } from './resources/media.js';
import { CatalogResource } from './resources/catalog.js';
import { ChannelsResource } from './resources/channels.js';
import { ChatsResource } from './resources/chats.js';
import { ContactsResource } from './resources/contacts.js';
import { GroupsResource } from './resources/groups.js';
import { HealthResource } from './resources/health.js';
import { LabelsResource } from './resources/labels.js';
import { MessagesResource } from './resources/messages.js';
import { ProfileResource } from './resources/profile.js';
import { SearchResource } from './resources/search.js';
import { SessionsResource } from './resources/sessions.js';
import { StatusResource } from './resources/status.js';
import { TemplatesResource } from './resources/templates.js';
import { WebhooksResource } from './resources/webhooks.js';
import type { AuthValidateResponse, MessageResponse, SendMediaRequest } from './types.js';

export interface MyWhatsappClientOptions {
  /** Base URL of the MyWhatsapp API, e.g. `http://localhost:2785`. */
  baseUrl: string;
  /** API key sent as `X-API-Key`. */
  apiKey: string;
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Default headers applied to every request. */
  defaultHeaders?: Record<string, string>;
  /** Injectable transport; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

export class MyWhatsappClient {
  private readonly config: Required<Omit<ClientConfig, 'fetch'>> & { fetch: FetchLike };

  constructor(options: MyWhatsappClientOptions) {
    if (!options.baseUrl) throw new Error('MyWhatsappClient: baseUrl is required');
    if (!options.apiKey) throw new Error('MyWhatsappClient: apiKey is required');

    this.config = {
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs ?? 30000,
      defaultHeaders: options.defaultHeaders ?? {},
      fetch: options.fetch ?? globalThis.fetch,
    };

    warnIfInsecureHttpUrl(options.baseUrl);
  }

  // ── Resources ────────────────────────────────────────────────────

  readonly sessions = new SessionsResource(this);
  readonly messages = new MessagesResource(this);
  readonly contacts = new ContactsResource(this);
  readonly groups = new GroupsResource(this);
  readonly webhooks = new WebhooksResource(this);
  readonly chats = new ChatsResource(this);
  readonly status = new StatusResource(this);
  readonly health = new HealthResource(this);
  readonly labels = new LabelsResource(this);
  readonly channels = new ChannelsResource(this);
  readonly catalog = new CatalogResource(this);
  readonly templates = new TemplatesResource(this);
  readonly search = new SearchResource(this);
  readonly profile = new ProfileResource(this);
  readonly calls = new CallsResource(this);
  readonly media = new MediaResource(this);

  // ── Auth ─────────────────────────────────────────────────────────

  /** Validate the configured API key and resolve its role. */
  auth(): Promise<AuthValidateResponse> {
    return this.request<AuthValidateResponse>({ method: 'POST', path: '/api/auth/validate' });
  }

  // ── Internal API ─────────────────────────────────────────────────

  /** Issue a raw request against the API. (Public for advanced use.) */
  request<T>(options: RequestOptions): Promise<T> {
    return request<T>(this.config, options);
  }

  /** Issue a raw request expecting a non-JSON (binary) body. (Public for advanced use.) */
  requestBytes(options: RequestOptions): Promise<BinaryResponse> {
    return requestBytes(this.config, options);
  }

  /**
   * Shared transport helper for image/video/audio/document/sticker sends. Public resource methods
   * expose the narrower per-route request types (including audio-only `ptt`).
   */
  sendMedia(sessionId: string, segment: string, body: SendMediaRequest): Promise<MessageResponse> {
    return this.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/${segment}`,
      body,
    });
  }
}

export default MyWhatsappClient;
