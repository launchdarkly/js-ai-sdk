# `@launchdarkly/ai-bedrock-messages`

Amazon Bedrock Converse handler for `@launchdarkly/ai-server`. It routes `['Bedrock', 'messages']`, supports tools, streaming, structured-output prompt injection, multimodal history, and caller-owned `BedrockRuntimeClient` instances.

## Install

```bash
yarn add @launchdarkly/ai-server @launchdarkly/ai-bedrock-messages
```

Use the normal AWS credential chain, set `AWS_BEARER_TOKEN_BEDROCK`, pass `apiKey`, or inject a configured client:

```ts
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { config } from '@launchdarkly/ai-server';
import { createBedrockMessagesHandler } from '@launchdarkly/ai-bedrock-messages';

const handler = createBedrockMessagesHandler({
  client: new BedrockRuntimeClient({ region: 'us-east-1' }),
  converseOptions: (config) => ({ requestMetadata: { model: config.model.name } }),
});

const result = await config({ key: 'bedrock-config', handler }).invoke(
  'Hello',
  { kind: 'user', key: 'user-123' },
);
```

`model.region` is an inference-profile prefix such as `us` or `global`; factory `region` configures the AWS endpoint. Injected clients are never reconfigured or destroyed.
