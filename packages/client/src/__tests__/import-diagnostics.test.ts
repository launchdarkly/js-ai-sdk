import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeImportFailure,
  esmExternalizationDiagnostic,
  isEsmInteropError,
  isModuleNotFoundError,
  moduleNameFromError,
  resetEsmExternalizationWarning,
  warnEsmExternalizationOnce,
} from '../import-diagnostics.js';

const MISSING_NODE_SDK =
  '[LaunchDarkly] @launchdarkly/node-server-sdk is not installed. ' +
  'Either install it (npm install @launchdarkly/node-server-sdk) or pass a ' +
  'pre-initialized LD client to initClient().';

function errorWithCode(message: string, code?: string): Error {
  const error = new Error(message);
  if (code) Object.assign(error, { code });
  return error;
}

describe('import diagnostics', () => {
  beforeEach(() => {
    resetEsmExternalizationWarning();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isEsmInteropError', () => {
    it.each([
      ['ERR_REQUIRE_ESM by code', errorWithCode('boom', 'ERR_REQUIRE_ESM')],
      ['ERR_PACKAGE_PATH_NOT_EXPORTED by code', errorWithCode('boom', 'ERR_PACKAGE_PATH_NOT_EXPORTED')],
      [
        'require() of ES Module message',
        new Error('require() of ES Module /app/node_modules/@launchdarkly/ai-server/dist/index.js is not supported'),
      ],
      ['import-only message', new Error('Must use import to load ES Module: /app/node_modules/foo/index.js')],
      ['missing exports main', new Error('No "exports" main defined in /app/node_modules/foo/package.json')],
      ['subpath not exported', new Error(`Package subpath './dist' is not defined by "exports"`)],
    ])('recognizes %s', (_label, error) => {
      expect(isEsmInteropError(error)).toBe(true);
    });

    it.each([
      ['a genuinely missing module', errorWithCode("Cannot find module 'foo'", 'MODULE_NOT_FOUND')],
      ['an unrelated failure', new TypeError('Reading config of undefined')],
      ['a non-error throw', 'something went wrong'],
    ])('does not recognize %s', (_label, error) => {
      expect(isEsmInteropError(error)).toBe(false);
    });
  });

  describe('isModuleNotFoundError', () => {
    it.each(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'])('recognizes %s', (code) => {
      expect(isModuleNotFoundError(errorWithCode('nope', code))).toBe(true);
    });

    it('recognizes the message form when no code is attached', () => {
      expect(isModuleNotFoundError(new Error("Cannot find package '@launchdarkly/node-server-sdk'"))).toBe(true);
    });

    it('does not recognize an interoperability failure', () => {
      expect(isModuleNotFoundError(errorWithCode('boom', 'ERR_REQUIRE_ESM'))).toBe(false);
    });
  });

  describe('moduleNameFromError', () => {
    it('reads the specifier from a missing-module message', () => {
      expect(moduleNameFromError(new Error("Cannot find module '@opentelemetry/core'"), 'fallback')).toBe(
        '@opentelemetry/core',
      );
    });

    it('reads the package name from a node_modules path', () => {
      const error = new Error('require() of ES Module /app/node_modules/@opentelemetry/sdk-trace-node/build/index.js');
      expect(moduleNameFromError(error, 'fallback')).toBe('@opentelemetry/sdk-trace-node');
    });

    it('falls back when the message names no package', () => {
      expect(moduleNameFromError(new Error('boom'), 'an OpenTelemetry SDK package')).toBe(
        'an OpenTelemetry SDK package',
      );
    });
  });

  describe('esmExternalizationDiagnostic', () => {
    it('names the module and carries the remediation and recipe link', () => {
      const message = esmExternalizationDiagnostic('@launchdarkly/node-server-sdk');
      expect(message).toContain('@launchdarkly/node-server-sdk');
      expect(message).toContain('ESM package was externalized into CommonJS output');
      expect(message).toContain('/^@launchdarkly\\/ai-/');
      expect(message).toContain(
        'https://github.com/launchdarkly/js-ai-sdk/blob/main/packages/ai-node/README.md#commonjs-aws-lambda-and-webpack',
      );
    });
  });

  describe('describeImportFailure', () => {
    it('returns the externalization diagnostic with the original error as cause', () => {
      const original = errorWithCode('require() of ES Module', 'ERR_REQUIRE_ESM');
      const described = describeImportFailure('@launchdarkly/node-server-sdk', original, MISSING_NODE_SDK);

      expect(described.message).toBe(esmExternalizationDiagnostic('@launchdarkly/node-server-sdk'));
      expect(described.cause).toBe(original);
    });

    it('keeps the missing-dependency guidance for a genuine MODULE_NOT_FOUND', () => {
      const original = errorWithCode("Cannot find module '@launchdarkly/node-server-sdk'", 'MODULE_NOT_FOUND');
      const described = describeImportFailure('@launchdarkly/node-server-sdk', original, MISSING_NODE_SDK);

      expect(described.message).toBe(MISSING_NODE_SDK);
      expect(described.message).not.toContain('externalized');
      expect(described.cause).toBe(original);
    });

    it('passes an unrelated failure through unchanged', () => {
      const original = new TypeError('Reading config of undefined');
      expect(describeImportFailure('@launchdarkly/node-server-sdk', original, MISSING_NODE_SDK)).toBe(original);
    });

    it('wraps a non-error throw without labeling it', () => {
      const described = describeImportFailure('@launchdarkly/node-server-sdk', 'kaboom', MISSING_NODE_SDK);
      expect(described.message).toBe('kaboom');
    });
  });

  describe('warnEsmExternalizationOnce', () => {
    it('warns with the diagnostic and the original error message', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      warnEsmExternalizationOnce('@opentelemetry/sdk-trace-node', new Error('require() of ES Module'));

      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain('@opentelemetry/sdk-trace-node');
      expect(message).toContain('ESM package was externalized into CommonJS output');
      expect(message).toContain('Original error: require() of ES Module');
    });

    it('warns only once until the warning state is reset', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = new Error('require() of ES Module');

      warnEsmExternalizationOnce('@opentelemetry/core', error);
      warnEsmExternalizationOnce('@opentelemetry/core', error);
      expect(warn).toHaveBeenCalledTimes(1);

      resetEsmExternalizationWarning();
      warnEsmExternalizationOnce('@opentelemetry/core', error);
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});
