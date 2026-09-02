/**
 * The identity this package reports to LaunchDarkly.
 *
 * `LD_AI_PACKAGE_VERSION` is maintained by release-please through the
 * `extra-files` entry for this package in `release-please-config.json`. Do not
 * edit it by hand — the guard test in `__tests__/version.test.ts` fails when it
 * no longer matches `package.json`.
 */
export const LD_AI_PACKAGE_NAME = '@launchdarkly/ai-node';
export const LD_AI_PACKAGE_VERSION = '0.1.1'; // x-release-please-version
