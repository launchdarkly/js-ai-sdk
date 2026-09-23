import { beforeAll, describe, expect, it } from 'vitest';
import { bundle, createConsumer, invoke } from './harness.js';

const SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const CASE_TIMEOUT_MS = 5 * 60 * 1000;

describe('CommonJS consumer bundled with Webpack + webpack-node-externals', () => {
  beforeAll(() => {
    createConsumer();
  }, SETUP_TIMEOUT_MS);

  it(
    'reproduces AIC-3370 when the LaunchDarkly AI packages stay external',
    () => {
      expect(bundle('externalized').status).toBe(0);

      const result = invoke('externalized');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');
      expect(result.stderr).toContain('No "exports" main defined');
      expect(result.stderr).toContain('@launchdarkly/ai-node/package.json');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'loads when /^@launchdarkly\\/ai-/ is allowlisted so the bundler inlines the packages',
    () => {
      expect(bundle('allowlisted').status).toBe(0);

      const result = invoke('allowlisted');

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        config: 'function',
        initClient: 'function',
        openaiMessages: 'function',
        otelTracerProvider: 'function',
      });
    },
    CASE_TIMEOUT_MS,
  );
});
