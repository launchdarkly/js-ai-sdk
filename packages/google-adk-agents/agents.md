# Agent Guide — `@launchdarkly/ai-google-adk-agents`

Wildcard agent handler (`providesFor = ['*', 'agent']`) for Google ADK. An exact provider handler still wins when both are registered.

Gemini Developer API is the default. Vertex is opt-in (`useVertexai: true`) and requires project and location at factory time. Do not send `apiKey` in Vertex mode.

`@google/adk` 2.1 has no LiteLLM adapter. Non-Gemini providers throw unless `model` is injected. Python is the runtime that maps `provider/model` through ADK's own `LiteLlm`.

## File map

| File | Responsibility |
|---|---|
| `handler.ts` | Factory, session seeding, telemetry plugin, run and stream |
| `spans.ts` | `invoke_agent` / `chat {model}` / `execute_tool {name}` |
| `graph.ts` | `googleAdkGraph()` |
| `native-graph.ts` | `toAdkAgents()` |

`gen_ai.system` is `google_adk`. `gen_ai.provider.name` is the serving provider; Google, Gemini, and Vertex normalize to `gcp.gemini`. The handler imports only the span helpers the unit-test mock exports (`startRootSpan`, `startModelSpan`, `startToolSpan`, `finishModelSpan`, `finishRootSpan`, `failSpan`). Usage on the returned value is read from the event, not from that mock.
