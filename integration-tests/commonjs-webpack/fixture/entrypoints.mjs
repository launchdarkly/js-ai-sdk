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
    aiNodeExperimentalInitEvaluations: typeof aiNodeExperimental.initEvaluations,
    aiNodeExperimentalGetSkill: typeof aiNodeExperimental.getSkill,
    aiNodeRootGetSkill: typeof aiNode.getSkill,
    aiNodeExperimentalConfigSkills: typeof aiNodeExperimental.configSkills,
    aiNodeRootConfigSkills: typeof aiNode.configSkills,
    aiServerConfig: typeof aiServer.config,
    aiServerExperimentalInitEvaluations: typeof aiServerExperimental.initEvaluations,
    aiServerExperimentalGetSkill: typeof aiServerExperimental.getSkill,
    aiServerRootGetSkill: typeof aiServer.getSkill,
    aiServerExperimentalConfigSkills: typeof aiServerExperimental.configSkills,
    aiServerRootConfigSkills: typeof aiServer.configSkills,
    openaiMessages: typeof openaiMessages.openaiMessages,
    langchainMessages: typeof langchainMessages.langchainMessages,
  }),
);
