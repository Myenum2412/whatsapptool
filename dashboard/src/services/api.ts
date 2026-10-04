// API Service Layer for MyWhatsapp Dashboard
// Centralized API client with TypeScript types

import { warnIfInsecureHttpUrl } from '../utils/urlSecurity';

// Resolve the API base URL. By default this is the same-origin relative path '/api',
// correct when the dashboard and API are served from the same origin (the default
// single-container setup). For a split-origin deployment (dashboard hosted separately
// from the API), set VITE_API_URL at build time to the API ORIGIN — e.g.
// `VITE_API_URL=https://gateway.example.com` — and the '/api' prefix is appended here.
// Previously VITE_API_URL was documented but never read, so the dashboard always called
// same-origin '/api' and a split deployment failed with "Invalid API Key" (#91).
// Exported so direct fetches (e.g. auth/validate in Login.tsx / App.tsx) honor VITE_API_URL
// too — otherwise split-origin deployments break. Empty VITE_API_URL → '/api'.
const API_ORIGIN = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
export const API_BASE_URL = `${API_ORIGIN}/api`;
// Warn (not refuse — would break dev + TLS-terminating-proxy) when the API origin is an
// insecure http:// URL pointing at a non-localhost host (API keys sent in cleartext).
if (API_ORIGIN) warnIfInsecureHttpUrl(API_ORIGIN, 'VITE_API_URL');

// =============================================================================
// Types
// =============================================================================

/**
 * The three tunable keys, as the gateway resolves them — not the raw stored column, which the API
 * never returns. `maxReconnectAttempts` is null when reconnects are unlimited, which is the default
 * and which no number in the accepted 0-20 range can express.
 */
export interface SessionConfig {
  autoRejectCalls: boolean;
  maxReconnectAttempts: number | null;
  reconnectBaseDelay: number;
}

export type SessionProxyType = 'http' | 'https' | 'socks4' | 'socks5';

export interface SessionProxy {
  enabled: boolean;
  proxyType: SessionProxyType | null;
  proxyHost: string | null;
  hasCredentials: boolean;
}

export interface CreateSessionOptions {
  proxyUrl?: string;
  proxyType?: SessionProxyType;
}

export interface Session {
  id: string;
  name: string;
  status:
    | 'created'
    | 'initializing'
    | 'authenticating'
    | 'qr_ready'
    | 'ready'
    | 'disconnected'
    | 'action_required'
    | 'failed';
  /**
   * Whether the gateway holds a live engine for this session right now. The precondition the
   * lifecycle routes enforce, and not derivable from `status`: `disconnected` covers both a session
   * mid automatic-reconnect (engine present, start 400s) and one stopped through stop() (no engine).
   * Optional BY DESIGN, not drift: the wire always carries it, but this client's state model
   * clears it to "unknown" after a websocket status event until the row refreshes, so the action
   * helpers fall back to the historical status set instead of trusting a stale value.
   */
  engineLoaded?: boolean;
  phone?: string | null;
  pushName?: string | null;
  connectedAt?: string | null;
  lastActive?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Human-readable reason carried while the status is 'failed' (terminal failure) or
   * 'action_required' (operator must intervene, e.g. acknowledge an onboarding modal). */
  lastError?: string | null;
  /**
   * A limit WhatsApp itself has placed on the account, or null when there is none. Distinct from
   * `lastError`, which describes a fault on the gateway's side of the link. Optional only because a
   * dashboard can be served by a gateway that predates the field.
   */
  restriction?: AccountRestriction | null;
}

/** One participant's presence within a chat. */
export interface ParticipantPresence {
  id: string;
  /** `composing`/`recording` mean actively typing or recording; `paused` means they stopped. */
  state: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused';
  /** Unix SECONDS. Absent whenever the contact's privacy settings hide last-seen. */
  lastSeen?: number;
}

/** The last presence reported for a chat since it was subscribed. */
export interface ChatPresence {
  chatId: string;
  participants: ParticipantPresence[];
  groupOnlineCount?: number;
  /** When the gateway received the report — NOT a WhatsApp timestamp. */
  observedAt: string;
}

/**
 * A restriction WhatsApp has in force on a session's account.
 *
 * `reachout_timelock` leaves the session connected and existing chats working — only starting new
 * conversations is blocked — which is why it can appear on a perfectly `ready` session. `tos_block`
 * and `proxy_block` refuse the connection itself and so cannot.
 */
export interface AccountRestriction {
  kind: 'reachout_timelock' | 'tos_block' | 'proxy_block';
  /** The engine's own token for the cause, verbatim (`TOS_BLOCK`, `BIZ_QUALITY`, …). */
  code: string;
  /** ISO timestamp when enforcement ends, when WhatsApp states one. */
  expiresAt?: string | null;
}

export interface SessionStats {
  total: number;
  active: number;
  ready: number;
  disconnected: number;
  byStatus: Record<string, number>;
  memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
}

export type WebhookFilterOperator = 'is' | 'isNot' | 'contains' | 'equals';

export interface WebhookFilterCondition {
  field: string;
  operator: WebhookFilterOperator;
  value: string | string[] | boolean;
  caseSensitive?: boolean;
}

export interface WebhookFilters {
  conditions: WebhookFilterCondition[];
}

export interface Webhook {
  id: string;
  sessionId: string;
  url: string;
  events: string[];
  filters?: WebhookFilters | null;
  active: boolean;
  retryCount: number;
  /** Null until the first delivery attempt. */
  lastTriggeredAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageTemplate {
  id: string;
  sessionId: string;
  name: string;
  body: string;
  header?: string | null;
  footer?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TemplatePayload {
  name: string;
  body: string;
  header?: string | null;
  footer?: string | null;
}

// ── Flow plans ────────────────────────────────────────────────────────────────
// The block union mirrors the gateway's `PlanFlowBlock` (src/modules/plan/flow/flow-block-types.ts).
// It is declared here rather than imported so the dashboard keeps building if that module moves;
// `i18n:check` and the plan tests are what keep the two in step.

export type FlowBlockType = 'text' | 'image' | 'video' | 'file' | 'poll' | 'yesno';

interface FlowBlockBase {
  /** Client-minted and stable across a reorder, so an autosave can address a single block. */
  id: string;
}

export interface TextFlowBlock extends FlowBlockBase {
  type: 'text';
  text: string;
}

export interface MediaFlowBlock extends FlowBlockBase {
  type: 'image' | 'video';
  mediaUrl: string;
  caption: string;
}

export interface FileFlowBlock extends FlowBlockBase {
  type: 'file';
  mediaUrl: string;
  filename: string;
  caption: string;
}

export interface PollFlowBlock extends FlowBlockBase {
  type: 'poll';
  question: string;
  options: string[];
}

export interface YesNoFlowBlock extends FlowBlockBase {
  type: 'yesno';
  question: string;
  yesLabel: string;
  noLabel: string;
}

export type FlowBlock = TextFlowBlock | MediaFlowBlock | FileFlowBlock | PollFlowBlock | YesNoFlowBlock;

/** What a plan-media upload hands back, ready to drop into a block. */
export interface PlanMediaUpload {
  url: string;
  filename: string;
  mimetype: string;
  sizeBytes: number;
}

// The mind-map mirrors the gateway's `PlanMindMap` (src/modules/plan/flow/mind-map-types.ts): a
// parallel layout over the same blocks, addressed by block id, carrying no message content.
export interface MindMapPosition {
  x: number;
  y: number;
}

export interface MindMapEdge {
  id: string;
  from: string;
  to: string;
}

export interface PlanMindMap {
  positions: Record<string, MindMapPosition>;
  edges: MindMapEdge[];
}

export interface Plan {
  id: string;
  sessionId: string;
  title: string;
  description: string | null;
  flow: FlowBlock[];
  mindmap: PlanMindMap;
  /** ISO strings, as the API returns them. */
  createdAt: string;
  updatedAt: string;
}

export interface PlanPayload {
  title: string;
  description?: string | null;
  flow?: FlowBlock[];
  mindmap?: PlanMindMap;
}

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  role: 'admin' | 'operator' | 'viewer';
  allowedIps?: string[];
  allowedSessions?: string[];
  allowedChats?: string[];
  isActive: boolean;
  expiresAt?: string;
  lastUsedAt?: string;
  usageCount: number;
  createdAt: string;
}

/** The creation response: every list/detail field plus the plaintext key, shown exactly once. */
export interface CreatedApiKey extends ApiKey {
  apiKey: string;
}

export interface AuditLog {
  id: string;
  action: string;
  severity: 'info' | 'warn' | 'error';
  apiKeyId: string | null;
  apiKeyName: string | null;
  sessionId: string | null;
  sessionName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  /** Null when the action succeeded. */
  errorMessage: string | null;
  /** Free-form context whose shape varies per action. */
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface MessageResponse {
  messageId: string;
  timestamp: number;
}

// Mirrors the backend engine ChatKind (dashboard cannot import wa-id.ts).
export type ChatKind = 'individual' | 'group' | 'channel' | 'status' | 'broadcast' | 'unknown';
// Mirrors CHAT_KINDS in the backend webhook filter registry (src/modules/webhook/filters/filter-types.ts).
export const CHAT_KINDS: readonly ChatKind[] = ['individual', 'group', 'channel', 'status', 'broadcast', 'unknown'];

// Chat summary returned by GET /sessions/:id/chats (mirrors the backend ChatSummary).
export interface Chat {
  id: string;
  name: string;
  isGroup: boolean;
  kind: ChatKind;
  unreadCount: number;
  timestamp: number;
  lastMessage?: string;
  archived: boolean;
  pinned: boolean;
  muted: boolean;
  muteExpiration?: number;
}

// Engine-neutral message types (mirrors the backend's IWhatsAppEngine MessageType). The backend
// normalizes raw engine tokens at the adapter boundary (#265/#270), so persisted rows, the
// message.received/sent payloads, and the websocket all use these values.
export const MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
  'location',
  'contact',
  'poll',
  'call',
  'revoked',
  'order',
  'product',
  'masked',
  'unknown',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Coerce an arbitrary string (e.g. a raw websocket payload field) to a known MessageType. */
export function asMessageType(value: string | undefined): MessageType {
  return (MESSAGE_TYPES as readonly string[]).includes(value ?? '') ? (value as MessageType) : 'unknown';
}

export interface ChatMessage {
  id: string;
  waMessageId?: string;
  chatId: string;
  /** Chat kind of the source conversation (present on live engine/WS payloads). */
  kind?: ChatKind;
  /**
   * Human-readable name of the message's sender. For a group this is the participant who posted
   * (their pushName/contact name); the chat view uses it to label who said what, like WhatsApp. Null
   * on legacy rows or when the engine could not resolve a name.
   */
  chatName?: string;
  /**
   * Stable sender identity for a group message: the participant JID who actually posted (`from` is
   * the group JID). Present on live/engine payloads and on rows persisted after the column was
   * added; absent on 1:1 messages, outgoing echoes, and legacy rows.
   */
  author?: string;
  from: string;
  to: string;
  body: string;
  type: MessageType;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  timestamp?: number;
  createdAt: string;
  metadata?: {
    media?: { mimetype: string; filename?: string; data?: string; omitted?: boolean; sizeBytes?: number };
    quotedMessage?: { id: string; body: string };
    reactions?: Record<string, string>;
    call?: { video: boolean; missed: boolean };
    /** Business prompt choices (Baileys). Present on inbound prompts that offer buttons. */
    buttons?: Array<{ id: string; text: string }>;
  };
}

// Live WhatsApp message from the engine history endpoint (not a persisted DB row): it carries `fromMe`
// instead of `direction`/`status`. Used to backfill a chat thread the gateway never captured live.
export interface EngineHistoryMessage {
  id: string;
  chatId: string;
  from: string;
  to: string;
  body: string;
  type: MessageType;
  /** Unix timestamp in seconds. */
  timestamp: number;
  fromMe: boolean;
  isGroup: boolean;
  isStatusBroadcast?: boolean;
  kind: ChatKind;
  /** Disappearing-messages timer on the chat, in seconds. Absent when the chat has none set. */
  ephemeralDuration?: number;
  /** Sender in a group: `from` is the group JID, so this participant WID is the real poster. */
  author?: string;
  mentionedIds?: string[];
  /** Present on `call` messages only. */
  call?: { video: boolean; missed: boolean };
  isLidSender?: boolean;
  senderPhone?: string | null;
  /**
   * Sender contact info, best-effort from the engine's cache. History carries `name` and `pushName`;
   * the richer fields are added when `WEBHOOK_CONTACT_DETAILS=true`, as on `message.received`.
   */
  contact?: {
    id?: string;
    number?: string;
    name?: string;
    pushName?: string;
    shortName?: string;
    type?: string;
    isMyContact?: boolean;
    isWAContact?: boolean;
    isBusiness?: boolean;
    isEnterprise?: boolean;
    verifiedName?: string;
    verifiedLevel?: number;
    isBlocked?: boolean;
    labels?: string[];
  };
  /** Status/story styling. Declared by the engine payload; this route never sets either. */
  backgroundColor?: string;
  font?: number;
  media?: {
    mimetype: string;
    filename?: string;
    data?: string;
    omitted?: boolean;
    sizeBytes?: number;
  };
  quotedMessage?: { id: string; body: string };
  location?: { latitude: number; longitude: number; description?: string; address?: string; url?: string };
  /** Present on `order` messages only: the placed cart, plus the single-order token for its items. */
  order?: { orderId: string; token?: string };
  /** Present on `product` messages only: the catalog product shared into the chat. */
  product?: { productId: string; title?: string; description?: string; businessOwnerJid?: string };
}

// Mirrors the backend engine Channel / ChannelMessage (GET /sessions/:id/channels[/:id/messages]).
export interface Channel {
  id: string;
  name: string;
  description?: string;
  inviteCode?: string;
  subscriberCount?: number;
  picture?: string;
  verified?: boolean;
  createdAt?: number;
}

export interface ChannelMessage {
  id: string;
  body: string;
  timestamp: number;
  hasMedia: boolean;
  mediaUrl?: string;
}

// Mirrors the backend engine Status / IWhatsAppEngine status methods (GET /sessions/:id/status).
export interface StatusUpdate {
  id: string;
  contact: { id: string; name?: string; pushName?: string };
  type: 'text' | 'image' | 'video' | 'voice';
  caption?: string;
  mediaUrl?: string;
  backgroundColor?: string;
  font?: number;
  timestamp: string;
  expiresAt: string;
}

export interface ContactStatusGroup {
  contact: { id: string; name?: string; pushName?: string };
  items: StatusUpdate[];
  latest: string;
}

// Minimal contact type for the recipient picker; the backend GET /sessions/:id/contacts
// returns a Contact array; fields beyond id are optional.
export interface Contact {
  id: string;
  name?: string;
  pushName?: string;
  /** MSISDN digits without separators — always present in the response. */
  number: string;
  isMyContact: boolean;
  isBlocked: boolean;
  /** Absent when the contact has none or privacy hides it. */
  profilePicUrl?: string;
}

export interface SendMediaPayload {
  base64?: string;
  url?: string;
  mimetype?: string;
  filename?: string;
  caption?: string;
  /** Quote an earlier message, making the media send a reply. Omit for an ordinary send. */
  quotedMessageId?: string;
}

// Payloads below mirror the backend DTOs in src/modules/message/dto (raw bodies, no envelope).
export interface SendLocationPayload {
  chatId: string;
  latitude: number;
  longitude: number;
  description?: string;
  address?: string;
}

export interface SendContactPayload {
  chatId: string;
  contactName: string;
  contactNumber: string;
}

export interface SendPollPayload {
  chatId: string;
  name: string;
  options: string[];
  allowMultipleAnswers?: boolean;
}

export interface ForwardMessagePayload {
  fromChatId: string;
  toChatId: string;
  messageId: string;
}

// Media block of a single bulk message (BulkMediaDto — no caption; caption sits next to it).
export interface BulkMediaPayload {
  url?: string;
  base64?: string;
  mimetype?: string;
  filename?: string;
  ptt?: boolean;
}

export interface BulkMessageItem {
  chatId: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'document';
  content: {
    text?: string;
    image?: BulkMediaPayload;
    video?: BulkMediaPayload;
    audio?: BulkMediaPayload;
    document?: BulkMediaPayload;
    caption?: string;
  };
  variables?: Record<string, string>;
}

export interface SendBulkPayload {
  batchId?: string;
  messages: BulkMessageItem[];
  options?: {
    delayBetweenMessages?: number;
    randomizeDelay?: boolean;
    stopOnError?: boolean;
  };
}

/** 202 response of POST send-bulk — the batch is processing asynchronously; poll getBatchStatus. */
export interface BulkBatchResponse {
  batchId: string;
  status: string;
  totalMessages: number;
  estimatedCompletionTime?: string;
  statusUrl: string;
}

export type BatchStatus = 'pending' | 'processing' | 'completed' | 'cancelled' | 'failed';

export interface BatchProgress {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  cancelled: number;
}

export interface BatchMessageResult {
  chatId: string;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  messageId?: string;
  error?: { code: string; message: string };
  sentAt?: string;
}

/** GET batch/:batchId shape; the cancel endpoint returns the same minus results/timestamps. */
export interface BatchStatusResponse {
  batchId: string;
  status: BatchStatus;
  progress: BatchProgress;
  /** One entry per recipient already attempted — empty until the first send resolves. */
  results: BatchMessageResult[];
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface HealthStatus {
  status: 'ok' | 'error';
  timestamp?: string;
  /** Running backend version (from package.json) — read live so the sidebar never shows a stale build. */
  version?: string;
  details?: {
    database?: { status: string };
    redis?: { status: string };
    queue?: { status: string };
  };
}

/** GET /infra/update-check: the running version against the latest published release. */
export interface UpdateCheck {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
}

export interface InfraStatus {
  // `builtIn` = MyWhatsapp's own bundled container is actually running and backing this service (live),
  // not just the saved intent — falls back to the saved flag when Docker is unavailable. (#488)
  database: { connected: boolean; type: string; host: string; builtIn: boolean };
  redis: { enabled: boolean; connected: boolean; host: string; port: number; builtIn: boolean };
  queue: {
    enabled: boolean;
    webhooks: { pending: number; completed: number; failed: number };
  };
  storage: { type: 'local' | 's3'; path?: string; bucket?: string; builtIn: boolean; s3Available?: boolean };
  engine: {
    type: string;
    headless: boolean;
    // whatsapp-web.js only: the WhatsApp Web build sessions request as their pin (distinct from the
    // library version, and not necessarily the build a page runs) and how it was chosen. (#488)
    webVersion?: string | null;
    webVersionSource?: 'pinned' | 'auto' | 'native';
  };
  /**
   * Editable settings supplied by a layer above `data/.env.generated` (the container environment or a
   * project `.env`), which therefore cannot be changed from this page until that layer is. Reported by
   * the gateway rather than inferred from a running-vs-saved mismatch, because that mismatch is also
   * what an unrestarted save looks like and the two need opposite advice (#1082).
   *
   * Optional only because a dashboard can be served by a gateway that predates the field.
   */
  envPinned?: string[];
}

// Saved infrastructure config (from data/.env.generated) used to hydrate the form.
// Secrets are never returned — `*Set` flags indicate whether a value is stored.
export interface SavedConfig {
  database: {
    type: 'sqlite' | 'postgres';
    builtIn: boolean;
    host: string;
    port: string;
    username: string;
    database: string;
    schema: string;
    poolSize: number;
    sslEnabled: boolean;
    sslRejectUnauthorized: boolean;
    passwordSet: boolean;
  };
  redis: { enabled: boolean; builtIn: boolean; host: string; port: string; passwordSet: boolean };
  queue: { enabled: boolean };
  storage: {
    type: 'local' | 's3';
    builtIn: boolean;
    localPath: string;
    s3Bucket: string;
    s3Region: string;
    s3Endpoint: string;
    s3CredentialsSet: boolean;
  };
  engine: { type: string; headless: boolean; sessionDataPath: string; browserArgs: string };
}

export interface SaveConfigPayload {
  database?: {
    type: 'sqlite' | 'postgres';
    builtIn?: boolean;
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    database?: string;
    schema?: string;
    poolSize?: number;
    sslEnabled?: boolean;
    sslRejectUnauthorized?: boolean;
  };
  redis?: {
    enabled?: boolean;
    builtIn?: boolean;
    host?: string;
    port?: string;
    password?: string;
  };
  queue?: {
    enabled?: boolean;
  };
  storage?: {
    type: 'local' | 's3';
    builtIn?: boolean;
    localPath?: string;
    s3Bucket?: string;
    s3Region?: string;
    s3AccessKey?: string;
    s3SecretKey?: string;
    s3Endpoint?: string;
  };
  engine?: {
    type?: string;
    headless?: boolean;
    sessionDataPath?: string;
    browserArgs?: string;
  };
}

// Global message search (mirrors the backend GET /search contract from #664).
// `timestamp` is epoch-seconds (the messages column is seconds, not ms); `dateFrom`/`dateTo`
// are epoch-ms on the wire — see `dateFrom`/`dateTo` JSDoc below.
export interface SearchParams {
  q: string;
  sessionId?: string;
  chatId?: string;
  direction?: string;
  type?: string;
  from?: string;
  /** Epoch-ms lower bound (inclusive) — the backend binds against messages.timestamp (/1000). */
  dateFrom?: number;
  /** Epoch-ms upper bound (inclusive). */
  dateTo?: number;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  messageId: string;
  waMessageId: string;
  sessionId: string;
  chatId: string;
  body: string;
  /** Provider-generated excerpt with `<mark>` highlight markers — render as text, never as HTML. */
  snippet: string;
  /** Epoch-seconds (mirrors the persisted messages.timestamp column). */
  timestamp: number;
  type: string;
  direction: 'incoming' | 'outgoing';
  from: string;
  score?: number;
}

export interface SearchResults {
  hits: SearchHit[];
  total: number;
  tookMs: number;
  provider: string;
}

// =============================================================================
// API Client
// =============================================================================

// Shared failure handling for every response shape (json/text/blob). On 401 the stored API key is
// invalid/expired/revoked — clear it and return to login so the user isn't stuck on a dashboard that
// 401s every request; the never-settling promise halts this request's chain so callers neither flash
// a generic error toast nor receive an undefined payload while the page navigates away. Otherwise
// throw an Error carrying the HTTP status and, when the gateway supplied one, its machine code.
async function handleErrorResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    sessionStorage.removeItem('mywhatsapp_api_key');
    if (typeof window !== 'undefined') {
      window.location.assign('/');
      return new Promise<T>(() => {});
    }
  }

  // On a non-JSON body (e.g. a reverse-proxy 502/503 HTML page) fall through to `HTTP <status>`
  // rather than statusText: the status code is what the toast connection-lost de-dup matches on,
  // and statusText is empty over HTTP/2 anyway.
  const error = await response.json().catch(() => ({}));
  // Carry the HTTP status on the Error (message unchanged, so the toast de-dup still matches) so
  // callers can tell apart a permission 403 from a real server 5xx instead of guessing from text.
  // Carry the machine `code` too: the gateway's stable codes (SESSION_LOGOUT_INCOMPLETE,
  // SESSION_NAME_TEARDOWN_PENDING, …) drive specific recovery UI, and a reverse-proxy 502 that
  // never reached the gateway carries no code at all — that distinction is exactly what the unlink
  // classifier keys on instead of fragile message heuristics.
  const err = new Error(error.message || `HTTP ${response.status}`) as Error & {
    status?: number;
    code?: string;
  };
  err.status = response.status;
  if (typeof error.code === 'string') err.code = error.code;
  throw err;
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  // Get API key from sessionStorage for authentication
  const apiKey = sessionStorage.getItem('mywhatsapp_api_key');

  // For FormData (file uploads) let the browser set multipart/form-data + boundary itself.
  const isFormData = options.body instanceof FormData;
  const headers: HeadersInit = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    return handleErrorResponse<T>(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

/** Like {@link request} but returns a Blob — e.g. for status media downloads. */
async function requestBlob(endpoint: string): Promise<Blob> {
  const url = `${API_BASE_URL}${endpoint}`;

  // Get API key from sessionStorage for authentication
  const apiKey = sessionStorage.getItem('mywhatsapp_api_key');

  const headers: HeadersInit = {
    ...(apiKey ? { 'X-API-Key': apiKey } : {}),
  };

  const response = await fetch(url, { headers });

  if (!response.ok) {
    return handleErrorResponse<Blob>(response);
  }

  return response.blob();
}

// =============================================================================
// Session API
// =============================================================================

export const sessionApi = {
  list: () => request<Session[]>('/sessions'),
  get: (id: string) => request<Session>(`/sessions/${id}`),
  create: (name: string, options?: CreateSessionOptions) =>
    request<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name,
        ...(options?.proxyUrl ? { proxyUrl: options.proxyUrl } : {}),
      }),
    }),
  delete: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),
  getConfig: (id: string) => request<SessionConfig>(`/sessions/${id}/config`),
  // PATCH merges: only the keys sent are touched. Send null to clear one back to its default.
  updateConfig: (id: string, patch: Partial<Record<keyof SessionConfig, boolean | number | null>>) =>
    request<SessionConfig>(`/sessions/${id}/config`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  getProxy: (id: string) => request<SessionProxy>(`/sessions/${id}/proxy`),
  updateProxy: (id: string, patch: { proxyUrl?: string | null }) =>
    request<SessionProxy>(`/sessions/${id}/proxy`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  start: (id: string) => request<Session>(`/sessions/${id}/start`, { method: 'POST' }),
  stop: (id: string) => request<Session>(`/sessions/${id}/stop`, { method: 'POST' }),
  logout: (id: string) => request<Session>(`/sessions/${id}/logout`, { method: 'POST' }),
  forceKill: (id: string) => request<Session>(`/sessions/${id}/force-kill`, { method: 'POST' }),
  getQR: (id: string) => request<{ qrCode: string; status: string }>(`/sessions/${id}/qr`),
  requestPairingCode: (id: string, phoneNumber: string) =>
    request<{ pairingCode: string; status: string }>(`/sessions/${id}/pairing-code`, {
      method: 'POST',
      body: JSON.stringify({ phoneNumber }),
    }),
  getStats: () => request<SessionStats>('/sessions/stats/overview'),
  getGroups: (id: string) =>
    request<{ id: string; name?: string; linkedParentJID?: string | null }[]>(`/sessions/${id}/groups`),
  getChats: (id: string) => request<Chat[]>(`/sessions/${id}/chats`),
  markChatRead: (id: string, chatId: string) =>
    request<{ success: boolean }>(`/sessions/${id}/chats/read`, {
      method: 'POST',
      body: JSON.stringify({ chatId }),
    }),
  // `offset` progress DB rows already fetched for this chat, never rendered rows: the thread merges
  // these with engine history, so paging by the merged length would skip DB rows. `total` is not
  // read to decide whether an older page exists — a page short of `limit` is; a chat with live
  // traffic keeps growing `total` after the fact, so comparing rows-held against it stops early.
  getChatMessages: (id: string, chatId: string, limit = 100, offset = 0) =>
    request<{ messages: ChatMessage[]; total: number }>(
      `/sessions/${id}/messages?chatId=${encodeURIComponent(chatId)}&limit=${limit}&offset=${offset}`,
    ),
  // Live history straight from WhatsApp (bypasses the DB) — backfills a thread the gateway never
  // captured, e.g. a freshly paired session whose persisted store is still empty.
  // includeMedia downloads the media payload (base64) for history messages so stickers/images/
  // video/voice render instead of collapsing to an empty timestamp-only bubble.
  getChatHistory: (id: string, chatId: string, limit = 100, includeMedia = false) =>
    request<EngineHistoryMessage[]>(
      `/sessions/${id}/messages/${encodeURIComponent(chatId)}/history?limit=${limit}${
        includeMedia ? '&includeMedia=true' : ''
      }`,
    ),
  // A message's stored media, fetched on demand. The message list carries its media inline only up to
  // MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES; past that budget the payload arrives as the
  // `{ omitted: true, sizeBytes }` marker and the bytes are only reachable here. Served as an
  // attachment (Content-Disposition), so callers download it rather than rendering it inline.
  getMessageMediaBlob: (id: string, chatId: string, messageId: string) =>
    requestBlob(`/sessions/${id}/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`),
  getSubscribedChannels: (id: string) => request<Channel[]>(`/sessions/${id}/channels`),
  getChannelMessages: (id: string, channelId: string, limit = 50) =>
    request<ChannelMessage[]>(`/sessions/${id}/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`),
  getContactStatuses: (id: string) => request<{ statuses: StatusUpdate[] }>(`/sessions/${id}/status`),
  getStatusMediaBlob: (id: string, statusId: string) =>
    requestBlob(`/sessions/${id}/status/${encodeURIComponent(statusId)}/media`),
  postTextStatus: (
    id: string,
    text: string,
    recipients?: string[],
    extra?: { backgroundColor?: string; font?: number },
  ) =>
    request(`/sessions/${id}/status/send-text`, {
      method: 'POST',
      body: JSON.stringify({ text, recipients, ...extra }),
    }),
  postImageStatus: (
    id: string,
    image: { url?: string; base64?: string; mimetype?: string },
    recipients?: string[],
    caption?: string,
  ) =>
    request(`/sessions/${id}/status/send-image`, {
      method: 'POST',
      body: JSON.stringify({ image, recipients, caption }),
    }),
};

// =============================================================================
// Webhook API
// =============================================================================

export const webhookApi = {
  listBySession: (sessionId: string) => request<Webhook[]>(`/sessions/${sessionId}/webhooks`),
  listAll: () => request<Webhook[]>('/webhooks'),
  create: (sessionId: string, data: { url: string; events: string[]; filters?: WebhookFilters | null }) =>
    request<Webhook>(`/sessions/${sessionId}/webhooks`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (sessionId: string, id: string, data: Partial<Webhook>) =>
    request<Webhook>(`/sessions/${sessionId}/webhooks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (sessionId: string, id: string) =>
    request<void>(`/sessions/${sessionId}/webhooks/${id}`, { method: 'DELETE' }),
  test: (sessionId: string, id: string) =>
    request<{ success: boolean; statusCode?: number; error?: string }>(`/sessions/${sessionId}/webhooks/${id}/test`, {
      method: 'POST',
    }),
};

// =============================================================================
// Template API
// =============================================================================

export const templateApi = {
  list: (sessionId: string) => request<MessageTemplate[]>(`/sessions/${sessionId}/templates`),
  create: (sessionId: string, data: TemplatePayload) =>
    request<MessageTemplate>(`/sessions/${sessionId}/templates`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (sessionId: string, id: string, data: Partial<TemplatePayload>) =>
    request<MessageTemplate>(`/sessions/${sessionId}/templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (sessionId: string, id: string) =>
    request<void>(`/sessions/${sessionId}/templates/${id}`, { method: 'DELETE' }),
};

// =============================================================================
// Flow Plan API
// =============================================================================

export const planApi = {
  list: (sessionId: string) => request<Plan[]>(`/sessions/${sessionId}/plans`),
  get: (sessionId: string, id: string) => request<Plan>(`/sessions/${sessionId}/plans/${id}`),
  create: (sessionId: string, data: PlanPayload) =>
    request<Plan>(`/sessions/${sessionId}/plans`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  // Partial by contract: the autosaves send `{ flow }` or `{ mindmap }` alone, and the gateway treats
  // an absent key as a no-op rather than a clear.
  update: (sessionId: string, id: string, data: Partial<PlanPayload>) =>
    request<Plan>(`/sessions/${sessionId}/plans/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (sessionId: string, id: string) => request<void>(`/sessions/${sessionId}/plans/${id}`, { method: 'DELETE' }),
  // One file per request; the browser sets the multipart boundary. The response URL is API-relative
  // and stored straight onto the block.
  uploadMedia: (sessionId: string, id: string, file: File) => {
    const body = new FormData();
    body.append('file', file);
    return request<PlanMediaUpload>(`/sessions/${sessionId}/plans/${id}/media`, { method: 'POST', body });
  },
  // `<img src>` cannot carry the `X-API-Key`, so uploaded media is fetched with the key and handed
  // back as a Blob for the component to object-URL. `path` is the stored block URL.
  getMediaBlob: (path: string) => requestBlob(path),
};

// =============================================================================
// Campaign (mail merge) API
// =============================================================================

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';
export type CampaignPauseReason = 'MANUAL' | 'PACING_LIMITED' | 'SESSION_NOT_READY' | 'INTERRUPTED';
export type CampaignRecipientStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
export type CampaignMediaType = 'auto' | 'document';
export type CampaignAttachmentScope = 'all' | 'row';
export type CampaignResponseStyle = 'poll' | 'reply';

export interface CampaignRecipientFilter {
  status?: CampaignRecipientStatus;
  /** Only rows whose answer includes this option. */
  response?: string;
  /** `yes`: answered; `no`: sent but not answered yet. */
  responded?: 'yes' | 'no';
}

export interface SpreadsheetColumn {
  header: string;
  key: string;
}

export interface SpreadsheetInspection {
  columns: SpreadsheetColumn[];
  rowCount: number;
  sampleRows: Record<string, string>[];
  suggestedPhoneColumn?: string;
}

export interface CampaignProgress {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface Campaign {
  id: string;
  sessionId: string;
  name: string;
  status: CampaignStatus;
  pauseReason: CampaignPauseReason | null;
  templateId: string | null;
  header: string | null;
  body: string;
  footer: string | null;
  columns: SpreadsheetColumn[];
  phoneColumn: string;
  mediaColumn: string | null;
  mediaType: CampaignMediaType;
  delayMs: number;
  randomizeDelay: boolean;
  progress: CampaignProgress;
  sourceFilename: string | null;
  responseStyle: CampaignResponseStyle | null;
  responseQuestion: string | null;
  responseOptions: string[] | null;
  responseMultiple: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CampaignAttachment {
  id: string;
  scope: CampaignAttachmentScope;
  filename: string;
  mimetype: string;
  sizeBytes: number;
  sendAs: 'image' | 'video' | 'audio' | 'document';
  createdAt: string;
}

export interface CampaignDetail extends Campaign {
  skippedByReason: Record<string, number>;
  preview: {
    rowNumber: number;
    chatId: string;
    text: string;
    attachments: string[];
    poll?: { question: string; options: string[] };
  }[];
  attachments: CampaignAttachment[];
  missingAttachments: string[];
  responseSummary: {
    options: { option: string; count: number }[];
    responded: number;
    awaiting: number;
  } | null;
}

export interface CampaignRecipient {
  id: string;
  rowNumber: number;
  chatId: string | null;
  status: CampaignRecipientStatus;
  variables: Record<string, string>;
  errorCode: string | null;
  errorMessage: string | null;
  messageId: string | null;
  sentAt: string | null;
  response: string[] | null;
  responseVia: 'poll' | 'reply' | null;
  respondedAt: string | null;
}

export interface CampaignRecipientPage {
  items: CampaignRecipient[];
  total: number;
  page: number;
  limit: number;
}

export interface CreateCampaignPayload {
  name: string;
  templateId?: string;
  body?: string;
  phoneColumn: string;
  mediaColumn?: string;
  mediaType?: CampaignMediaType;
  defaultCountryCode?: string;
  delayMs?: number;
  randomizeDelay?: boolean;
  skipRowsWithMissingValues?: boolean;
  responseStyle?: CampaignResponseStyle;
  responseQuestion?: string;
  responseOptions?: string[];
  responseMultiple?: boolean;
}

export const campaignApi = {
  inspect: (sessionId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<SpreadsheetInspection>(`/sessions/${sessionId}/campaigns/inspect`, { method: 'POST', body: form });
  },
  create: (sessionId: string, file: File, data: CreateCampaignPayload) => {
    const form = new FormData();
    form.append('file', file);
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === '') continue;
      // Arrays (response options) travel as one JSON field; the gateway parses it back.
      form.append(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
    }
    return request<CampaignDetail>(`/sessions/${sessionId}/campaigns`, { method: 'POST', body: form });
  },
  list: (sessionId: string) => request<Campaign[]>(`/sessions/${sessionId}/campaigns`),
  get: (sessionId: string, id: string) => request<CampaignDetail>(`/sessions/${sessionId}/campaigns/${id}`),
  recipients: (sessionId: string, id: string, params: CampaignRecipientFilter & { page?: number; limit?: number }) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.response) query.set('response', params.response);
    if (params.responded) query.set('responded', params.responded);
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return request<CampaignRecipientPage>(`/sessions/${sessionId}/campaigns/${id}/recipients${suffix}`);
  },
  exportResults: (sessionId: string, id: string) => requestBlob(`/sessions/${sessionId}/campaigns/${id}/export`),
  start: (sessionId: string, id: string) =>
    request<Campaign>(`/sessions/${sessionId}/campaigns/${id}/start`, { method: 'POST' }),
  pause: (sessionId: string, id: string) =>
    request<Campaign>(`/sessions/${sessionId}/campaigns/${id}/pause`, { method: 'POST' }),
  cancel: (sessionId: string, id: string) =>
    request<Campaign>(`/sessions/${sessionId}/campaigns/${id}/cancel`, { method: 'POST' }),
  delete: (sessionId: string, id: string) =>
    request<void>(`/sessions/${sessionId}/campaigns/${id}`, { method: 'DELETE' }),
  /** One file per request, so each upload stays inside the gateway's in-flight body budget. */
  uploadAttachment: (sessionId: string, id: string, file: File, scope: CampaignAttachmentScope) => {
    const form = new FormData();
    form.append('scope', scope);
    form.append('file', file);
    return request<{ attachment: CampaignAttachment; rowsMatched: number }>(
      `/sessions/${sessionId}/campaigns/${id}/attachments`,
      { method: 'POST', body: form },
    );
  },
  removeAttachment: (sessionId: string, id: string, attachmentId: string) =>
    request<void>(`/sessions/${sessionId}/campaigns/${id}/attachments/${attachmentId}`, { method: 'DELETE' }),
};

// =============================================================================
// Contact API
// =============================================================================

export interface CheckNumberResponse {
  number: string;
  exists: boolean;
  /** Engine-canonical WhatsApp id for the number (e.g. `…@c.us` or `…@lid`), or null if unregistered. */
  whatsappId: string | null;
}

export interface ProfilePictureResponse {
  /** Signed CDN URL for the contact/group picture, or null when hidden / unavailable. */
  url: string | null;
}

export const contactApi = {
  list: (sessionId: string) => request<Contact[]>(`/sessions/${sessionId}/contacts`),
  checkNumber: (sessionId: string, number: string) =>
    request<CheckNumberResponse>(`/sessions/${sessionId}/contacts/check/${encodeURIComponent(number)}`),
  // Returns the contact/group profile picture URL. Both engines return null when the user hid their
  // picture or has none. The URL is a signed WhatsApp CDN link that expires in a few hours, so the
  // dashboard caches it for an hour (see useProfilePicture) and re-fetches on expiry.
  profilePicture: (sessionId: string, contactId: string) =>
    request<ProfilePictureResponse>(`/sessions/${sessionId}/contacts/${encodeURIComponent(contactId)}/profile-picture`),
  // Best-effort resolution of a contact id (e.g. an @lid privacy id) to its phone number (MSISDN
  // digits), or null when the engine can't map it. Cached a day by useResolvedPhone.
  resolvePhone: (sessionId: string, contactId: string) =>
    request<{ contactId: string; phone: string | null }>(
      `/sessions/${sessionId}/contacts/${encodeURIComponent(contactId)}/phone`,
    ),
  // Batch-resolve profile picture URLs for a whole sidebar in ONE request — the per-chat burst of
  // parallel single fetches exhausts the per-IP throttle (429s). Engine lookups run 3 at a time
  // server-side; ids beyond the backend's 50-id cap are dropped client-side too.
  profilePictures: (sessionId: string, contactIds: string[]) =>
    request<{ pictures: Record<string, string | null> }>(
      `/sessions/${sessionId}/contacts/profile-pictures?ids=${contactIds
        .slice(0, 50)
        .map(encodeURIComponent)
        .join(',')}`,
    ),
};

// =============================================================================
// API Key API
// =============================================================================

export const apiKeyApi = {
  list: () => request<ApiKey[]>('/auth/api-keys'),
  create: (data: {
    name: string;
    role: string;
    allowedIps?: string[];
    allowedSessions?: string[];
    expiresAt?: string;
    allowedChats?: string[];
  }) =>
    request<CreatedApiKey>('/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (
    id: string,
    data: {
      name?: string;
      role?: string;
      allowedIps?: string[];
      allowedSessions?: string[];
      expiresAt?: string;
      allowedChats?: string[];
    },
  ) =>
    request<ApiKey>(`/auth/api-keys/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/auth/api-keys/${id}`, { method: 'DELETE' }),
  revoke: (id: string) => request<ApiKey>(`/auth/api-keys/${id}/revoke`, { method: 'POST' }),
};

// =============================================================================
// Audit/Logs API
// =============================================================================

export const auditApi = {
  list: (params?: { action?: string; severity?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.action) query.set('action', params.action);
    if (params?.severity) query.set('severity', params.severity);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const queryStr = query.toString();
    return request<{ data: AuditLog[]; total: number }>(`/audit${queryStr ? `?${queryStr}` : ''}`);
  },
};

// =============================================================================
// Message API
// =============================================================================

export const messageApi = {
  sendText: (sessionId: string, chatId: string, text: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-text`, {
      method: 'POST',
      body: JSON.stringify({ chatId, text }),
    }),
  sendMedia: (
    sessionId: string,
    chatId: string,
    mediaType: 'image' | 'video' | 'audio' | 'document',
    payload: SendMediaPayload,
  ) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-${mediaType}`, {
      method: 'POST',
      body: JSON.stringify({ chatId, ...payload }),
    }),
  sendLocation: (sessionId: string, data: SendLocationPayload) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-location`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  sendContact: (sessionId: string, data: SendContactPayload) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-contact`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  // Stickers take the same media body as the other send-* endpoints (base64 XOR url + mimetype).
  sendSticker: (sessionId: string, chatId: string, payload: SendMediaPayload) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-sticker`, {
      method: 'POST',
      body: JSON.stringify({ chatId, ...payload }),
    }),
  sendPoll: (sessionId: string, data: SendPollPayload) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-poll`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  forward: (sessionId: string, data: ForwardMessagePayload) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/forward`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  // Async batch: returns 202 immediately; poll getBatchStatus until a terminal status.
  sendBulk: (sessionId: string, data: SendBulkPayload) =>
    request<BulkBatchResponse>(`/sessions/${sessionId}/messages/send-bulk`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getBatchStatus: (sessionId: string, batchId: string) =>
    request<BatchStatusResponse>(`/sessions/${sessionId}/messages/batch/${encodeURIComponent(batchId)}`),
  cancelBatch: (sessionId: string, batchId: string) =>
    request<BatchStatusResponse>(`/sessions/${sessionId}/messages/batch/${encodeURIComponent(batchId)}/cancel`, {
      method: 'POST',
    }),
  reply: (sessionId: string, data: { chatId: string; quotedMessageId: string; text: string }) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/reply`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /**
   * Tap a choice on an inbound business button/list prompt (Baileys only).
   * `messageId` is the prompt's WhatsApp id; `buttonId` is `buttons[].id`.
   */
  clickButton: (sessionId: string, data: { chatId: string; messageId: string; buttonId: string; text?: string }) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/click-button`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  react: (sessionId: string, data: { chatId: string; messageId: string; emoji: string }) =>
    request<void>(`/sessions/${sessionId}/messages/react`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (sessionId: string, data: { chatId: string; messageId: string; forEveryone?: boolean }) =>
    request<void>(`/sessions/${sessionId}/messages/delete`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// =============================================================================
// Search API
// =============================================================================

export const searchApi = {
  search: (params: SearchParams) => {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== '') query.set(key, String(value));
    });
    return request<SearchResults>(`/search?${query.toString()}`);
  },
};

// =============================================================================
// Health & Infrastructure API
// =============================================================================

export const healthApi = {
  check: () => request<HealthStatus>('/health'),
};

/**
 * Per-organization policy settings.
 *
 * Mirrors the server DTOs in `src/modules/tenancy/dto/organization-settings.dto.ts` — the
 * `check-contract-shapes` gate compares this shape against the published OpenAPI schema, so a field
 * renamed on one side and not the other fails that gate rather than silently sending `undefined`.
 *
 * `quietHours` is optional because the server OMITS the key when no window was ever configured, and
 * that absence is not the same as `{ enabled: false }`: the first means no policy exists, the second
 * that an operator paused one. A form that collapses them renders "quiet hours off" for a tenant that
 * simply never set them, and then saves that reading back.
 */
export interface QuietHoursSettings {
  enabled?: boolean;
  start?: string;
  end?: string;
  timezone?: string;
  weekdays?: number[];
  exemptChatIds?: string[];
}

export interface OrganizationSettings {
  organizationId: string;
  quietHours?: QuietHoursSettings;
}

export const organizationsApi = {
  getSettings: () => request<OrganizationSettings>('/organizations/settings'),
  // PATCH, not PUT: the server MERGES, and `quietHours` merges one level deep. A replace would drop the
  // times when only the enabled flag is sent, so toggling quiet hours off and on would cost the
  // operator their window.
  updateSettings: (patch: { quietHours?: QuietHoursSettings }) =>
    request<OrganizationSettings>('/organizations/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};

export const infraApi = {
  getStatus: () => request<InfraStatus>('/infra/status'),
  // Which WhatsApp engine this instance runs, and what the alternatives are. They live here rather
  // than beside the plugin routes because an engine is not a plugin you install.
  getEngines: () => request<Engine[]>('/infra/engines'),
  getCurrentEngine: () => request<{ engineType: string }>('/infra/engines/current'),
  getUpdateCheck: () => request<UpdateCheck>('/infra/update-check'),
  getConfig: () => request<SavedConfig>('/infra/config'),
  saveConfig: (config: SaveConfigPayload) =>
    request<{ message: string; saved: boolean; envPath: string; profiles: string[] }>('/infra/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  restart: (profiles?: string[], profilesToRemove?: string[]) =>
    request<{
      message: string;
      restarting: boolean;
      profiles: string[];
      profilesToRemove: string[];
      estimatedTime: number;
    }>('/infra/restart', {
      method: 'POST',
      body: JSON.stringify({ profiles: profiles || [], profilesToRemove: profilesToRemove || [] }),
    }),
  // Readiness, not the plain /infra/health ping. The restart poll must not be able to latch onto the
  // process it just asked to shut down: /infra/health answers 200 for the whole drain and teardown,
  // while /health/ready reports 503 as soon as draining starts and stays 503 until both databases
  // answer. Public (no API key), like /infra/health.
  healthCheck: () => request<{ status: 'ok' | 'error'; details: Record<string, { status: string }> }>('/health/ready'),
  // Data migration: export all Data-DB tables (call while still on the OLD database, before switching),
  // then import after the switch + restart. Used by the DB-switch migration guard so data isn't lost.
  exportData: () =>
    request<{
      exportedAt: string;
      dataDbType: string;
      tables: Record<string, unknown[]>;
      progress: Record<string, number>;
      // Optional tables absent from an older schema. Always present in the response; a non-empty
      // list means the backup is partial, not that those tables were empty.
      skippedTables: string[];
      // Inline media payloads the export budget refused. Always present; non-zero means the rows are
      // all there but some of their media is not — a state a restored archive cannot express, since
      // the omitted marker is the same one media skipped on the way in gets.
      omittedInlineMedia: { messages: number; messageBatches: number };
    }>('/infra/export-data'),
  // 200 contract includes the orphan-engine reconciliation result (restartRequired / notices /
  // stopped+failed ids). 409 has several causes and the error's `code` distinguishes them:
  // IMPORT_WOULD_ORPHAN_ENGINES (live engines exist for sessions the backup would remove; the
  // message lists them) is the only one the caller retries with stopOrphans=true to stop those
  // engines inside the request. IMPORT_ALREADY_RUNNING (another restore is in flight) and
  // IMPORT_NESTED_TRANSACTION (another transaction holds the connection) leave nothing to retry.
  // force is deliberately NOT exposed: it leaves the engines writing into the restored tables until
  // a restart — the window stopOrphans exists to close.
  importData: (tables: Record<string, unknown[]>, options?: { stopOrphans?: boolean }) =>
    request<{
      imported: boolean;
      progress?: Record<string, number>;
      message?: string;
      warnings?: string[];
      notices?: string[];
      restartRequired?: boolean;
      orphanedEngines?: string[];
      stoppedOrphanEngines?: string[];
      failedOrphanEngines?: string[];
    }>('/infra/import-data', {
      method: 'POST',
      body: JSON.stringify({ tables, ...options }),
    }),
};

export interface Engine {
  id: string;
  name: string;
  enabled: boolean;
  features: string[];
  /** Underlying engine library (e.g. whatsapp-web.js 1.34.7), distinct from the adapter version. */
  library?: { name: string; version: string };
}

// =============================================================================
// Statistics API (mirrors src/modules/stats)
// =============================================================================

export type StatsPeriod = '24h' | '7d' | '30d';

export interface OverviewStats {
  sessions: { active: number; total: number; byStatus: Record<string, number> };
  messages: { sent: number; received: number; failed: number; today: { sent: number; received: number } };
}

export interface MessageTimeSeriesPoint {
  timestamp: string;
  sent: number;
  received: number;
}

export interface MessageStats {
  timeSeries: MessageTimeSeriesPoint[];
  byType: Record<string, number>;
  bySession: Array<{ sessionId: string; name: string; sent: number; received: number }>;
  topChats: Array<{ chatId: string; chatName?: string | null; messageCount: number }>;
}

export const statsApi = {
  getOverview: () => request<OverviewStats>('/stats/overview'),
  getMessages: (period: StatsPeriod) => request<MessageStats>(`/stats/messages?period=${period}`),
};
