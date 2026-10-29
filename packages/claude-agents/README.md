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
| `captureContent` | unset (follows `configure()`, which defaults to `true`) | Put prompts, model output, and tool arguments and results on the emitted spans. Pass `false` to keep this handler to metadata only. |
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

### Output limit and thinking

- `max_tokens` in the config's model parameters sets the output-token limit for each model request. The Agent SDK has no option for it, so the handler sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS` in the environment of the Claude Code process. Without `max_tokens`, Claude Code uses its own default. A `CLAUDE_CODE_MAX_OUTPUT_TOKENS` in the `env` of a Claude Code settings file, including `~/.claude.json`, wins over `max_tokens`.
- Thinking is off unless the config sets `thinking` or `max_thinking_tokens`. Models that reject disabled thinking, such as `claude-fable-5`, still use their own default. Claude Code lowers a thinking budget to one less than `max_tokens`, so when a config sets both, keep `max_tokens` above the budget.

#### Migrating from a version that used Claude Code's thinking default

Earlier versions passed no thinking setting when the config had none, so Claude Code chose one: adaptive thinking on models that support it, and a 31,999-token budget on others such as `claude-haiku-4-5`. A run now thinks only when its config asks. To keep thinking, set it in the config's model parameters, for example `{"thinking": {"type": "adaptive"}}`.

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

## Agent Skills

`createClaudeAgentsHandler` doesn't give the model a variation's skills. `createClaudeAgentsSkillsHandler` does. It takes the same options, plus `skillsTempDir`.

```ts
import { config, LaunchDarklySkillStore, setSkillStore } from '@launchdarkly/ai-server';
import { createClaudeAgentsSkillsHandler } from '@launchdarkly/ai-claude-agents';

const store = new LaunchDarklySkillStore(process.env.LD_SDK_KEY!).start();
await store.waitForSkills({ timeoutSeconds: 10 });
setSkillStore(store);

const triage = config({
  key: 'triage-agent',
  handler: createClaudeAgentsSkillsHandler({ settingSources: [] }),
});
```

On every invoke and stream it:

1. Writes the variation's `skills` into a new directory under `skillsTempDir` (default: the OS temp directory), through the store you configured with `setSkillStore`. Pinned versions are honored.
2. Hands that directory to the Claude Agent SDK as a local plugin named `launchdarkly`, enables only those skills (`launchdarkly:<key>`), and turns on the `Skill` tool.
3. Removes the directory when the run ends, whether it succeeded, failed, or a stream was abandoned.

Each run has its own directory, so concurrent runs and different variations never share files, and nothing needs to watch for changes. Detaching a skill from a variation takes effect on the next run.

**A run whose skills can't be written doesn't start.** The handler throws before the model is called if no store is configured, the store hasn't received its first payload, a skill fails integrity verification, or a pinned version isn't in the store. The error names each skill. A variation with no skills runs exactly as it would with `createClaudeAgentsHandler`, and needs no store.

A `Skill` call shows up in traces as an `execute_tool Skill` span.

**Not covered yet:** `claudeAgents()`, `claudeGraph()` and `toClaudeAgents()` use the core handler, so a variation run through them doesn't get its skills.

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
