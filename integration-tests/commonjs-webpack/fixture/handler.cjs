'use strict';

// Lambda-shaped CommonJS entry point. It only reports what resolved — no LaunchDarkly
// SDK key, no provider call, no model spend.
exports.handler = async () => {
  const aiNode = await import('@launchdarkly/ai-node');
  const openaiMessages = await import('@launchdarkly/ai-openai-messages');
  await import('@launchdarkly/ai-otel');
  const otelTraceNode = await import('@opentelemetry/sdk-trace-node');

  return {
    config: typeof aiNode.config,
    initClient: typeof aiNode.initClient,
    openaiMessages: typeof openaiMessages.openaiMessages,
    otelTracerProvider: typeof otelTraceNode.NodeTracerProvider,
  };
};
