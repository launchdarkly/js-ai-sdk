# `@launchdarkly/ai-vercel-agents`

Wildcard agent adapter for the Vercel AI SDK. It builds AI SDK 7 `ToolLoopAgent` instances for LaunchDarkly agent configs and native graphs.

## Install

```bash
npm install @launchdarkly/ai-node @launchdarkly/ai-vercel-agents
```

Default routing is AI Gateway: the adapter builds Vercel's `creator/model` id from the config provider and model (`xAI` + `grok-4.5` becomes `spacexai/grok-4.5`), while preserving slash-qualified ids. Set `AI_GATEWAY_API_KEY` or use Vercel OIDC. This package does not dynamically import `@ai-sdk/openai` (or other provider packages) from `config.provider.name`. To call a provider SDK directly, inject a `LanguageModel` or `modelFactory`.

All LaunchDarkly providers are handled explicitly. Anthropic, OpenAI, Azure, Gemini, Cohere, DeepSeek, Meta, Mistral, Perplexity, and Vertex map directly. Bedrock, Cortex, Cursor, Databricks, and Fireworks AI infer the creator from a dotted id or known model family and fail locally if ambiguous. AI21 Labs and IBM Watson fail locally because Vercel's current catalog has no corresponding creator; inject a direct model for those providers.

## Usage

```ts
import { vercelAgents } from '@launchdarkly/ai-vercel-agents';

const result = await vercelAgents('research-agent', 'Research feature flags', {
  kind: 'user',
  key: 'user-123',
}, {
  toolHandlers: {
    search: async ({ query }) => search(query),
  },
});
```

The handler advertises `['*', 'agent']`. Register only one wildcard agent adapter at a time.

## Graphs

`vercelGraph()` pre-wires the handler into the LaunchDarkly graph runner. `toVercelAgents()` converts a resolved graph into one `ToolLoopAgent` per node and follows explicit `transfer_to_<target>` tool selections.

```ts
import { resolveGraph } from '@launchdarkly/ai-node';
import { toVercelAgents } from '@launchdarkly/ai-vercel-agents';

const context = { kind: 'user', key: 'user-123' };
const result = await toVercelAgents(
  resolveGraph('support-graph', { context }),
  { context, toolHandlers },
).invoke('I need billing help');
```

Native graph history is applied only to the root. Usage is accumulated across visited nodes, and graph telemetry is emitted when `context` is supplied.
