'use strict';

// Loads every installed package root through `require` and reports what resolved.
const aiNode = require('@launchdarkly/ai-node');
const aiNodeExperimental = require('@launchdarkly/ai-node/experimental');
const aiServer = require('@launchdarkly/ai-server');
const aiServerExperimental = require('@launchdarkly/ai-server/experimental');
const openaiMessages = require('@launchdarkly/ai-openai-messages');
const langchainMessages = require('@launchdarkly/ai-langchain-messages');

require('@launchdarkly/ai-otel');

process.stdout.write(
  JSON.stringify({
    aiNodeConfig: typeof aiNode.config,
    aiNodeInitClient: typeof aiNode.initClient,
    aiNodeExperimentalInitEvaluations: typeof aiNodeExperimental.initEvaluations,
    aiNodeRootInitEvaluations: typeof aiNode.initEvaluations,
    aiNodeExperimentalGetSkill: typeof aiNodeExperimental.getSkill,
    aiNodeRootGetSkill: typeof aiNode.getSkill,
    aiNodeExperimentalConfigSkills: typeof aiNodeExperimental.configSkills,
    aiNodeRootConfigSkills: typeof aiNode.configSkills,
    aiServerConfig: typeof aiServer.config,
    aiServerExperimentalInitEvaluations: typeof aiServerExperimental.initEvaluations,
    aiServerRootInitEvaluations: typeof aiServer.initEvaluations,
    aiServerExperimentalGetSkill: typeof aiServerExperimental.getSkill,
    aiServerRootGetSkill: typeof aiServer.getSkill,
    aiServerExperimentalConfigSkills: typeof aiServerExperimental.configSkills,
    aiServerRootConfigSkills: typeof aiServer.configSkills,
    openaiMessages: typeof openaiMessages.openaiMessages,
    langchainMessages: typeof langchainMessages.langchainMessages,
  }),
);
