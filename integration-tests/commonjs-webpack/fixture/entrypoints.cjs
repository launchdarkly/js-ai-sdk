'use strict';

// Loads every installed package root through `require` and reports what resolved.
const aiNode = require('@launchdarkly/ai-node');
const aiServer = require('@launchdarkly/ai-server');
const openaiMessages = require('@launchdarkly/ai-openai-messages');
const langchainMessages = require('@launchdarkly/ai-langchain-messages');

require('@launchdarkly/ai-otel');

process.stdout.write(
  JSON.stringify({
    aiNodeConfig: typeof aiNode.config,
    aiNodeInitClient: typeof aiNode.initClient,
    aiServerConfig: typeof aiServer.config,
    openaiMessages: typeof openaiMessages.openaiMessages,
    langchainMessages: typeof langchainMessages.langchainMessages,
  }),
);
