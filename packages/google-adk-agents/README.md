# Google ADK agents

`@launchdarkly/ai-google-adk-agents` is a wildcard agent handler for [Google ADK](https://google.github.io/adk-docs/). It serves any `agent` variation that does not have a more specific provider handler registered.

```ts
import { googleAdkAgents } from '@launchdarkly/ai-google-adk-agents';

const response = await googleAdkAgents(key, userInput, context, { toolHandlers });
```

Gemini Developer API is the default (`GOOGLE_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_GENAI_API_KEY`). Vertex is explicit: `createGoogleAdkAgentsHandler({ useVertexai: true, project, location })`. The API key is not sent in Vertex mode.

`@google/adk` 2.1 has no LiteLLM adapter. A non-Gemini provider throws unless you pass `model` (an ADK model, or `(config) => model`).

`toAdkAgents(graph)` compiles a LaunchDarkly agent graph into an ADK `Workflow`. `googleAdkGraph(key, options)` pre-wires this handler for `graph()`.
