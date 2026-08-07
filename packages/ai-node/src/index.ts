/**
 * LaunchDarkly AI SDK for Node.js.
 *
 * @launchdarkly/ai-node
 *
 * Node.js convenience wrapper for @launchdarkly/ai-server.
 *
 * This package re-exports the full @launchdarkly/ai-server surface and carries
 * @launchdarkly/node-server-sdk as a hard dependency, so installing this single
 * package is all that is needed for a standard Node.js application:
 *
 *   npm install @launchdarkly/ai-node
 *
 * @launchdarkly/node-server-sdk is auto-discovered by initClient() at runtime
 * via dynamic import — no extra configuration required.
 *
 * For edge runtimes (Vercel, Cloudflare, etc.) use @launchdarkly/ai-server
 * directly and pass a pre-initialized client to initClient(client).
 */
export * from '@launchdarkly/ai-server';
