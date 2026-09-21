'use strict';

// Lambda-shaped CommonJS entry point for the release canary. It only reports which symbols the
// published packages resolved — no LaunchDarkly SDK key, no flag evaluation, no model call.
const versions = require('./versions.json');

exports.handler = async () => {
  const aiNode = await import('@launchdarkly/ai-node');
  const openaiMessages = await import('@launchdarkly/ai-openai-messages');
  const aiOtel = await import('@launchdarkly/ai-otel');

  return {
    ok: true,
    runtime: process.version,
    versions,
    capabilities: {
      config: typeof aiNode.config,
      initClient: typeof aiNode.initClient,
      shutdown: typeof aiNode.shutdown,
      openaiMessages: typeof openaiMessages.openaiMessages,
      aiOtel: typeof aiOtel,
    },
  };
};
