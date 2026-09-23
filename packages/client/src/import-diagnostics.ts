const LD_BUNDLER_RECIPE_URL =
  'https://github.com/launchdarkly/js-ai-sdk/blob/main/packages/ai-node/README.md#commonjs-aws-lambda-and-webpack';

const ESM_INTEROP_ERROR_CODES = new Set(['ERR_REQUIRE_ESM', 'ERR_PACKAGE_PATH_NOT_EXPORTED']);

const ESM_INTEROP_MESSAGE_PATTERNS = [
  /ERR_REQUIRE_ESM/,
  /ERR_PACKAGE_PATH_NOT_EXPORTED/,
  /require\(\) of ES Module/i,
  /Must use import to load ES ?Module/i,
  /No "exports" main defined/i,
  /is not defined by "exports"/i,
];

const MODULE_NOT_FOUND_ERROR_CODES = new Set(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']);

let esmExternalizationWarned = false;

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Recognizes the Node module-interoperability failures produced when a bundler
 * downlevels an `await import()` of an ESM-only package into `require()`.
 */
export function isEsmInteropError(error: unknown): boolean {
  const code = errorCode(error);
  if (code && ESM_INTEROP_ERROR_CODES.has(code)) return true;
  const message = errorMessage(error);
  return ESM_INTEROP_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

export function isModuleNotFoundError(error: unknown): boolean {
  const code = errorCode(error);
  if (code && MODULE_NOT_FOUND_ERROR_CODES.has(code)) return true;
  return /Cannot find (?:module|package)/i.test(errorMessage(error));
}

export function moduleNameFromError(error: unknown, fallback: string): string {
  const message = errorMessage(error);
  const specifier = message.match(/Cannot find (?:module|package) '([^']+)'/);
  if (specifier) return specifier[1];
  const fromPath = [...message.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)]
    .map((match) => match[1])
    .filter((name) => name !== '.pnpm');
  return fromPath.at(-1) ?? fallback;
}

export function esmExternalizationDiagnostic(moduleName: string): string {
  return (
    `[LaunchDarkly] Could not load "${moduleName}" during initialization because an ` +
    'ESM package was externalized into CommonJS output, so the bundled require() cannot ' +
    'resolve it. Allowlist the LaunchDarkly AI packages so the bundler inlines them:\n' +
    '  externals: [nodeExternals({ allowlist: [/^@launchdarkly\\/ai-/] })]\n' +
    `  AWS Lambda + Webpack recipe: ${LD_BUNDLER_RECIPE_URL}`
  );
}

/**
 * Classifies a failed optional dynamic import. ESM-externalization and genuinely
 * missing dependencies get actionable guidance; anything else is passed through
 * unchanged so unrelated failures are not mislabeled.
 */
export function describeImportFailure(moduleName: string, error: unknown, missingDependencyMessage: string): Error {
  if (isEsmInteropError(error)) {
    return new Error(esmExternalizationDiagnostic(moduleName), { cause: error });
  }
  if (isModuleNotFoundError(error)) {
    return new Error(missingDependencyMessage, { cause: error });
  }
  return error instanceof Error ? error : new Error(errorMessage(error));
}

export function warnEsmExternalizationOnce(moduleName: string, error: unknown): void {
  if (esmExternalizationWarned) return;
  esmExternalizationWarned = true;
  // biome-ignore lint/suspicious/noConsole: intentional warning for a bundler misconfiguration
  console.warn(`${esmExternalizationDiagnostic(moduleName)}\n  Original error: ${errorMessage(error)}`);
}

export function resetEsmExternalizationWarning(): void {
  esmExternalizationWarned = false;
}
