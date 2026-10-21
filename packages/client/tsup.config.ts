import { defineConfig } from 'tsup';
import base from '../../tsup.config.base';

// Two entry points: the package root and `@launchdarkly/ai-server/experimental`.
//
// Each entry is bundled on its own (no code splitting), so modules both reach —
// `types.ts` and `shutdown-hooks.ts` — are copied into each. The Skills modules
// are reached only from the experimental entry. The copies are safe because the
// shared state lives on `globalThis` symbol slots, not in module variables. Splitting is off because tsup's CJS splitting rewrites the dynamic
// `import()` of the optional peers into `require()`, which bundlers then try to
// resolve statically (AIC-3370; asserted by integration-tests/commonjs-webpack).
export default defineConfig({
  ...base,
  entry: { index: 'src/index.ts', experimental: 'src/experimental.ts' },
});
