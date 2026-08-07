/**
 * LaunchDarkly AI SDK OpenTelemetry integration.
 *
 * @launchdarkly/ai-otel
 *
 * OpenTelemetry dependency bundle for @launchdarkly/ai-server.
 *
 * This package carries all seven OpenTelemetry packages that
 * @launchdarkly/ai-server needs for automatic trace export as hard
 * dependencies. Installing this package alongside @launchdarkly/ai-node
 * (or @launchdarkly/ai-server) is all that is needed to enable tracing —
 * no individual OTel package installs required.
 *
 *   npm install @launchdarkly/ai-node @launchdarkly/ai-otel
 *
 * initClient() detects the OTel packages at runtime via dynamic import and
 * configures the tracer provider automatically. If this package is absent, a
 * single console.warn is emitted and all AI calls continue normally with
 * no-op spans.
 *
 * This barrel exports nothing — it exists solely to place the OTel packages
 * in node_modules. Import the LaunchDarkly AI SDK from @launchdarkly/ai-node
 * or @launchdarkly/ai-server as usual.
 */
