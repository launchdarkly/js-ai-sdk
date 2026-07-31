# `@launchdarkly/ai-node`

Node.js convenience wrapper for the LaunchDarkly AI SDK.

This package re-exports the full public API of [`@launchdarkly/ai-server`](../client/README.md) and carries `@launchdarkly/node-server-sdk` as a **hard dependency**. For standard Node.js applications, installing this single package is all that is needed — no peer dependency wiring required.

## When to use this package

| Runtime | Install |
|---|---|
| Node.js (server, Lambda, containers) | `@launchdarkly/ai-node` ← **this package** |
| Edge runtimes (Vercel, Cloudflare, etc.) | `@launchdarkly/ai-server` directly, then call `initClient(preInitializedClient)` |

## Installation

```bash
npm install @launchdarkly/ai-node
```

Add whichever handler package(s) your application uses:

```bash
npm install @launchdarkly/ai-openai-messages
# or
npm install @launchdarkly/ai-claude-agents
# etc.
```

Optionally, install [`@launchdarkly/ai-otel`](../ai-otel/README.md) to enable trace export to the LaunchDarkly Observability dashboard:

```bash
npm install @launchdarkly/ai-otel
```

`initClient()` detects the OTel packages at runtime and configures tracing automatically. If they are absent, a single `console.warn` is emitted and all AI calls continue normally with no-op spans.

## Usage

Import from `@launchdarkly/ai-node` exactly as you would from `@launchdarkly/ai-server` — the API surface is identical.

```ts
import 'dotenv/config';
import { config, shutdown } from '@launchdarkly/ai-node';
import { createOpenAIHandler } from '@launchdarkly/ai-openai-messages';

const caller = config({
  key: 'my-ai-config-flag',
  handler: createOpenAIHandler(),
});

const result = await caller.invoke(
  'What is feature flagging?',
  { kind: 'user', key: 'user-123' },
);

console.log(result.response);
await shutdown();
```

`@launchdarkly/node-server-sdk` is auto-discovered by `initClient()` via dynamic import. The `LD_SDK_KEY` environment variable is read automatically — no explicit `initClient()` call is required unless you need programmatic options or early startup initialization.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `LD_SDK_KEY` | Yes | LaunchDarkly server-side SDK key |
| `LD_BASE_URI` | No | Override the LaunchDarkly polling base URI |
| `LD_STREAM_URI` | No | Override the streaming URI |
| `LD_EVENTS_URI` | No | Override the events URI |
| `LD_SERVICE_NAME` | No | OTel `service.name` resource attribute (default: `nodejs-sdk`) |
| `LD_ENVIRONMENT` | No | `deployment.environment` attribute attached to telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | OTLP endpoint override (default: LaunchDarkly Observability backend) |

## `inspectConfig(key, context)`

Reads an AI Config flag variation **without invoking any AI provider**. Re-exported from `@launchdarkly/ai-server` — see the [full reference there](../client/README.md#inspectconfigkey-context).

```ts
import { inspectConfig } from '@launchdarkly/ai-node';

const result = await inspectConfig('my-ai-config-flag', { kind: 'user', key: 'user-123' });
if (result.enabled) {
  console.log(result.config?.model?.name);
}
```

Never throws. Returns `{ enabled: boolean, config: AiConfigRep | null, meta: VariationMeta | null }`.

## Full API reference

See [`@launchdarkly/ai-server`](../client/README.md) — all exports are re-exported unchanged from this package.
