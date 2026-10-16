# `@launchdarkly/ai-claude-agents`

Anthropic Claude handler for `@launchdarkly/ai-server` using the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). Runs an agentic query loop with native MCP tool support.

**`providesFor`:** `['Anthropic', 'agent']` — matches flag variations where `provider.name` is `"Anthropic"` and `meta.mode` is `"agent"`.

## Installation

```bash
yarn add @launchdarkly/ai-server @launchdarkly/ai-claude-agents
```

Set `ANTHROPIC_API_KEY` in your environment (the Anthropic SDK reads it automatically).

## Usage

### With `config()`

```ts
import 'dotenv/config';
import { config, shutdown } from '@launchdarkly/ai-server';
import { createClaudeAgentsHandler } from '@launchdarkly/ai-claude-agents';

// Single handler
const result = await config({
  key: 'my-ai-config-flag',
  handler: createClaudeAgentsHandler(),
  toolHandlers: {
    search: async ({ query }) => { /* ... */ },
  },
}).invoke('What is feature flagging?', { kind: 'user', key: 'user-123' });

console.log(result.response);
await shutdown();
```

### Handler options

`createClaudeAgentsHandler(options?)` accepts:

| Option | Default | Description |
|---|---|---|
| `captureContent` | `false` | Put prompts, model output, and tool arguments and results on the emitted spans. |
| `cwd` | `process.cwd()` | Working directory for the Claude Code process the Agent SDK starts. |
| `settingSources` | every source | Which Claude Code settings sources to load: `'user'` (`~/.claude/settings.json`), `'project'` (`.claude/settings.json`, and `CLAUDE.md`), `'local'` (`.claude/settings.local.json`). `[]` loads none. |

These configure the host process, not the model, so only your application can set them. A flag's model parameters can't set or override either one.

> **By default a run loads the host's own Claude Code settings.** With `settingSources` unset, the Claude Code process loads the user, project and local settings of the machine it runs on, including their plugins, skills, hooks and permission rules. To run an agent from its LaunchDarkly config alone, isolate it:
>
> ```ts
> createClaudeAgentsHandler({ settingSources: [] });
> ```

### Built-in tools

A run has no Claude Code built-in tools (`Read`, `Bash`, and the rest) unless its config attaches them. Attach one by mapping a tool key to its exported sentinel, such as `ClaudeRead` or `ClaudeBash`, in `toolHandlers`. Tools you define in the flag config are always available to the model through the handler's MCP server, whatever built-ins are attached.

### Convenience wrapper

```ts
import { claudeAgents } from '@launchdarkly/ai-claude-agents';

const result = await claudeAgents(
  'What is feature flagging?',
  { kind: 'user', key: 'user-123' },
  { key: 'my-ai-config-flag', variables: { topic: 'feature flagging' } },
);
```

### Agent graphs — `claudeGraph()`

Runs a LaunchDarkly agent graph with the Claude agent handler pre-bound. Equivalent to calling the base `graph()` with `handlers: [createClaudeAgentsHandler()]`. See the [core client docs](../client/README.md#graphkey-options) for the full `graph()` API.

```ts
import { claudeGraph } from '@launchdarkly/ai-claude-agents';

const result = await claudeGraph('support-graph', {}).invoke(
  'I was double charged',
  { kind: 'user', key: 'user-123' },
);
```

## How It Works

- Uses the system prompt and conversation history defined in your LaunchDarkly flag config.
- Template placeholders (`{{variable}}`) in the prompt are substituted using `variables` before the call.
- If tools are defined in the flag config, the Claude Agent SDK handles all tool dispatch and the agentic loop automatically — no extra wiring needed.
- Emits an OTel span and LaunchDarkly telemetry for every call.

## Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (read automatically by the Anthropic SDK) |
| `LD_SDK_KEY` | LaunchDarkly server-side SDK key |
| `LD_SERVICE_NAME` | OTel `service.name` resource attribute (default: `nodejs-sdk`) |
| `LD_ENVIRONMENT` | `deployment.environment` attribute attached to telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint override (default: LaunchDarkly Observability backend) |
