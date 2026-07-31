# `@launchdarkly/ai-otel`

OpenTelemetry dependency bundle for the LaunchDarkly AI SDK.

This package carries all seven OpenTelemetry packages that [`@launchdarkly/ai-server`](../client/README.md) needs for automatic trace export as **hard dependencies**. Installing it alongside `@launchdarkly/ai-node` replaces the previous seven-package install block with a single line.

## Installation

```bash
npm install @launchdarkly/ai-node @launchdarkly/ai-otel
```

Add whichever handler package(s) your application uses:

```bash
npm install @launchdarkly/ai-openai-messages
# or
npm install @launchdarkly/ai-claude-agents
# etc.
```

That's it. `initClient()` detects the OTel packages at runtime and configures tracing automatically. If `@launchdarkly/ai-otel` is absent, a single `console.warn` is emitted and all AI calls continue normally with no-op spans.

## What this package provides

`@launchdarkly/ai-otel` bundles the following packages as hard dependencies so you don't have to install them individually:

| Package | Version |
|---|---|
| `@opentelemetry/sdk-trace-node` | `^2.8.0` |
| `@opentelemetry/sdk-trace-base` | `^2.8.0` |
| `@opentelemetry/exporter-trace-otlp-http` | `^0.219.0` |
| `@opentelemetry/otlp-exporter-base` | `^0.219.0` |
| `@opentelemetry/resources` | `^2.8.0` |
| `@opentelemetry/context-async-hooks` | `^2.8.0` |
| `@opentelemetry/core` | `^2.8.0` |

## Usage

This package exports nothing — it exists solely to place the OTel packages in `node_modules`. Continue importing the LaunchDarkly AI SDK from `@launchdarkly/ai-node` or `@launchdarkly/ai-server` as usual.

```ts
import 'dotenv/config';
import { config, shutdown } from '@launchdarkly/ai-node';
import { createOpenAIMessagesHandler } from '@launchdarkly/ai-openai-messages';

const result = await config({
  key: 'my-ai-config-flag',
  handler: createOpenAIMessagesHandler(),
}).invoke(
  'What is feature flagging?',
  { kind: 'user', key: 'user-123' },
);

console.log(result.response);
await shutdown();
```

## Edge runtimes

For edge runtimes (Vercel, Cloudflare Workers, Deno Deploy, etc.) the Node.js OTel SDK is not applicable. Use `@launchdarkly/ai-server` directly and pass a pre-initialized client to `initClient(preInitializedClient)`. Skip this package on edge.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `LD_SERVICE_NAME` | No | OTel `service.name` resource attribute (default: `nodejs-sdk`) |
| `LD_ENVIRONMENT` | No | `deployment.environment` attribute attached to telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | OTLP endpoint override (default: LaunchDarkly Observability backend) |
