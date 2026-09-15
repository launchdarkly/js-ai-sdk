# `@launchdarkly/ai-bedrock-agents`

Amazon Bedrock agent handler for `@launchdarkly/ai-server`, powered by the Strands Agents SDK. It routes `['Bedrock', 'agent']` and includes `bedrockGraph`.

## Install

```bash
yarn add @launchdarkly/ai-server @launchdarkly/ai-bedrock-agents
```

```ts
import { config } from '@launchdarkly/ai-server';
import { createBedrockAgentsHandler } from '@launchdarkly/ai-bedrock-agents';

const result = await config({
  key: 'bedrock-agent-config',
  handler: createBedrockAgentsHandler({ region: 'us-east-1' }),
}).invoke('Research this topic', { kind: 'user', key: 'user-123' });
```

Use IAM, `AWS_BEARER_TOKEN_BEDROCK`, an explicit `apiKey`, or a caller-owned `BedrockRuntimeClient`. `modelOptions(config)` exposes documented Strands model configuration. `model.custom` is never forwarded.
