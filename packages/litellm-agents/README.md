# `@launchdarkly/ai-litellm-agents`

LiteLLM integration for `@launchdarkly/ai-server` using the OpenAI Agents SDK.
Every evaluated model is explicitly bound to an OpenAI-compatible client owned
by the caller, so requests cannot fall back to the default OpenAI endpoint.

## Installation

```bash
npm install @launchdarkly/ai-node @launchdarkly/ai-litellm-agents
```

Run a LiteLLM proxy and set its OpenAI-compatible endpoint:

```bash
LITELLM_BASE_URL=http://localhost:4000/v1
# Only required when the proxy has authentication enabled:
LITELLM_API_KEY=your-proxy-key
```

Provider credentials such as `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` belong on
the proxy, not in the Node.js application.

## Usage

```ts
import { createLiteLLMAgentHandler } from '@launchdarkly/ai-litellm-agents';
import { config } from '@launchdarkly/ai-server';

const result = await config({
  key: 'agent-config',
  handler: createLiteLLMAgentHandler(),
}).invoke('Research this', { kind: 'user', key: 'user-123' });
```

The package exports `litellmAgents`, `litellmGraph`, and `toLiteLLMAgents`
convenience adapters. The handler advertises `['*', 'agent']`. `baseURL` (or
`LITELLM_BASE_URL`) is mandatory unless `client` or `clientFactory` is supplied.
It reads the optional proxy credential from `LITELLM_API_KEY`; an unauthenticated
proxy needs no key. Internally, unauthenticated proxies receive a non-secret
placeholder rather than an unrelated provider credential. Explicit `baseURL`
and `apiKey` options override the environment.

Because this is a wildcard agent handler, do not register it together with
another `['*', 'agent']` handler such as LangChain in the same registry.
