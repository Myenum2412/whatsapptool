/**
 * MyWhatsapp JavaScript/TypeScript SDK.
 *
 * Official client library for the MyWhatsapp WhatsApp API Gateway.
 *
 * @example
 * ```typescript
 * import { MyWhatsappClient, MyWhatsappApiError } from '@mywhatsapp/sdk';
 *
 * const client = new MyWhatsappClient({
 *   baseUrl: 'http://localhost:2785',
 *   apiKey: 'owa_k1_…',
 * });
 *
 * await client.sessions.start('my-session');
 * const result = await client.messages.sendText('my-session', {
 *   chatId: '628123456789@c.us',
 *   text: 'Hello from the MyWhatsapp SDK!',
 * });
 * console.log(result.messageId);
 * ```
 *
 * @packageDocumentation
 */

export { MyWhatsappClient } from './client.js';
export { default } from './client.js';
export type { MyWhatsappClientOptions } from './client.js';
export * from './errors.js';
export type * from './types.js';
export type { BinaryResponse, ClientConfig, FetchLike, HttpMethod, RequestOptions } from './http.js';
export { buildUrl, warnIfInsecureHttpUrl } from './http.js';
