/**
 * Experimental features of the LaunchDarkly AI SDK core client.
 *
 * Import from `@launchdarkly/ai-server/experimental`. Every name here is
 * published, but may change in a minor release. None of these names is
 * exported from the package root.
 */

export {
  runShadow,
  type ShadowConfigArgs,
  type ShadowResult,
  type ShadowTask,
  shadowConfig,
} from './shadow-requests.js';
