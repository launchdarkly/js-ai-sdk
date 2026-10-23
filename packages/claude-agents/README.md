# `@launchdarkly/ai-claude-agents`

Anthropic Claude handler for `@launchdarkly/ai-server` using the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). Runs an agentic query loop with native MCP tool support.

**`providesFor`:** `['Anthropic', 'agent']` — matches flag variations where `provider.name` is `"Anthropic"` and `meta.mode` is `"agent"`.

## Installation

```bash
yarn add @launchdarkly/ai-server @launchdarkly/ai-claude-agents dotenv
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
| `settingSources` | `[]` (none) | Which Claude Code settings sources to load: `'user'` (`~/.claude/settings.json`), `'project'` (`.claude/settings.json`, and `CLAUDE.md`), `'local'` (`.claude/settings.local.json`). |

These configure the host process, not the model, so only your application can set them. A flag's model parameters can't set or override either one. `claudeAgents()`, `claudeGraph()` and `toClaudeAgents()` take `cwd` and `settingSources` too, with the same defaults.

> **A run loads none of the host's Claude Code settings unless you opt in.** The Claude Agent SDK's own default loads the user, project and local settings of the machine it runs on, including their plugins, skills, hooks, permission rules and `CLAUDE.md`. This handler sends `settingSources: []` instead, so an agent runs from its LaunchDarkly config alone. To load host settings, name the sources:
>
> ```ts
> createClaudeAgentsHandler({ settingSources: ['user', 'project', 'local'] });
> ```
>
> The Agent SDK still reads the managed-settings policy tier (managed settings files and MDM) whatever you pass.

#### Migrating from a version that loaded host settings

Earlier versions left `settingSources` unset, so the Agent SDK loaded every settings source on the host. A run now loads none of them. Anything a deployment configured through those files stops applying, including:

- plugins, skills, hooks, permission rules and `CLAUDE.md`
- the `env` block, for example `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX`, and proxy variables
- `apiKeyHelper` and `model`

A deployment that reaches Bedrock, Vertex or a gateway through `~/.claude/settings.json` fails to authenticate after the upgrade. To fix it, either set those variables in the process environment, or load the source that holds them:

```ts
createClaudeAgentsHandler({ settingSources: ['user'] });
claudeAgents('my-ai-config-flag', input, context, { settingSources: ['user'] });
claudeGraph('support-graph', { settingSources: ['user'] });
toClaudeAgents(resolveGraph('support-graph', { context }), { context, settingSources: ['user'] });
```

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
