// ESM twin of entrypoints.cjs — same package roots, resolved through the `import` condition.
import * as aiNode from '@launchdarkly/ai-node';
import * as langchainMessages from '@launchdarkly/ai-langchain-messages';
import * as openaiMessages from '@launchdarkly/ai-openai-messages';
import * as aiServer from '@launchdarkly/ai-server';

await import('@launchdarkly/ai-otel');

process.stdout.write(
  JSON.stringify({
    aiNodeConfig: typeof aiNode.config,
    aiNodeInitClient: typeof aiNode.initClient,
    aiServerConfig: typeof aiServer.config,
    openaiMessages: typeof openaiMessages.openaiMessages,
    langchainMessages: typeof langchainMessages.langchainMessages,
  }),
);
