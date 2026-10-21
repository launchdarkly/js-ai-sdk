# Agent Guide — `@launchdarkly/ai-bedrock-agents`

This Tier 1 package routes `['Bedrock', 'agent']` and uses Strands `Agent` plus `BedrockModel`.

- `src/handler.ts` owns model/agent construction, native tools and history, streaming, and telemetry.
- `src/graph.ts` provides only the generic `bedrockGraph` wrapper. There is no native graph adapter or AgentCore integration.
- `model.region` prefixes `modelId`; factory `region` configures the Bedrock endpoint.
- `modelOptions(config)` is evaluated per invocation. Generated `modelId` remains authoritative.
- Never infer options from `model.custom`.
- An injected client is installed on the Strands runtime model and remains caller-owned.
- Telemetry uses provider-neutral `invoke_agent`, `chat <modelId>`, and `execute_tool <name>` spans.
