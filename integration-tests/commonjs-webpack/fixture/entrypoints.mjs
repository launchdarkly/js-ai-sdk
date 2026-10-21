// ESM twin of entrypoints.cjs — same package roots, resolved through the `import` condition.
import * as aiNode from '@launchdarkly/ai-node';
import * as aiNodeExperimental from '@launchdarkly/ai-node/experimental';
import * as langchainMessages from '@launchdarkly/ai-langchain-messages';
import * as openaiMessages from '@launchdarkly/ai-openai-messages';
import * as aiServer from '@launchdarkly/ai-server';
import * as aiServerExperimental from '@launchdarkly/ai-server/experimental';

await import('@launchdarkly/ai-otel');

process.stdout.write(
  JSON.stringify({
    aiNodeConfig: typeof aiNode.config,
    aiNodeInitClient: typeof aiNode.initClient,
    aiNodeExperimentalGetSkill: typeof aiNodeExperimental.getSkill,
    aiNodeRootGetSkill: typeof aiNode.getSkill,
    aiServerConfig: typeof aiServer.config,
    aiServerExperimentalGetSkill: typeof aiServerExperimental.getSkill,
    aiServerRootGetSkill: typeof aiServer.getSkill,
    openaiMessages: typeof openaiMessages.openaiMessages,
    langchainMessages: typeof langchainMessages.langchainMessages,
  }),
);
