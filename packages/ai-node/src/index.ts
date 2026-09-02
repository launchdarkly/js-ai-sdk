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
import { registerAiSdkPackage } from '@launchdarkly/ai-server';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

// Reporting this package to LaunchDarkly is an import-time side effect on purpose.
// A package that reaches the running application reports itself; a package a bundler
// removes reports nothing, which is correct — an application that does not ship the
// package does not use it.
//
// Do not add "sideEffects": false to this package.json. It lets a bundler drop the call
// below and the package stops reporting, with no build or test failure to show it.
registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

export * from '@launchdarkly/ai-server';
