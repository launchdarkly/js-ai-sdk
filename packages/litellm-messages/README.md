# `@launchdarkly/ai-litellm-messages`

LiteLLM messages integration for `@launchdarkly/ai-server`. It uses the OpenAI
chat-completions client while requiring a user-owned OpenAI-compatible LiteLLM
proxy. Evaluated LaunchDarkly model names are passed through unchanged.

## Installation

```bash
npm install @launchdarkly/ai-node @launchdarkly/ai-litellm-messages
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
import { config } from '@launchdarkly/ai-server';
import { createLiteLLMMessagesHandler } from '@launchdarkly/ai-litellm-messages';

const result = await config({
  key: 'ai-config',
  handler: createLiteLLMMessagesHandler(),
}).invoke('Hello', { kind: 'user', key: 'user-123' });
```

The handler advertises `['*', 'messages']`, supports tools, structured output,
multimodal history, streaming, and optional `captureContent`. `baseURL` (or
`LITELLM_BASE_URL`) is mandatory unless `client` or `clientFactory` is supplied.
It reads the optional proxy credential from `LITELLM_API_KEY`; an unauthenticated
proxy needs no key. Internally, unauthenticated proxies receive a non-secret
placeholder rather than an unrelated provider credential. Explicit `baseURL`
and `apiKey` options override the environment.

Because this is a wildcard messages handler, do not register it together with
another `['*', 'messages']` handler such as LangChain in the same registry.
