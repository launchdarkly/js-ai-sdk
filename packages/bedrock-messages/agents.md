# Agent Guide — `@launchdarkly/ai-bedrock-messages`

This Tier 1 package routes `['Bedrock', 'messages']` and uses `ConverseCommand` / `ConverseStreamCommand`.

- `src/handler.ts` owns client construction, prompt/history conversion, the manual tool loop, streaming, usage, and telemetry.
- `src/index.ts` is the public barrel.
- `model.region` prefixes `modelId` once; factory `region` is only an AWS endpoint region.
- `converseOptions(config)` is evaluated each provider turn. Generated `modelId`, messages, system, and tool conversation remain authoritative.
- Never infer options from `model.custom`.
- An injected client is authoritative and caller-owned.
- Telemetry is `invoke_agent` → `chat <modelId>`, with sibling `execute_tool <name>` spans.
