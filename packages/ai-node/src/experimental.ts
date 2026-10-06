/**
 * Experimental features of the LaunchDarkly AI SDK for Node.js.
 *
 * @launchdarkly/ai-node/experimental
 *
 * Re-exports `@launchdarkly/ai-server/experimental`, so a Node.js application
 * that installs only this package can reach experimental features without a
 * direct dependency on `@launchdarkly/ai-server` (required under strict
 * package managers such as pnpm and Yarn PnP). Every name here may change in a
 * minor release, and none is exported from the package root.
 */
import { registerAiSdkPackage } from '@launchdarkly/ai-server';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

export * from '@launchdarkly/ai-server/experimental';
