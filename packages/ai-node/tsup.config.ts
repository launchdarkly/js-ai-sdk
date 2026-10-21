import { defineConfig } from 'tsup';
import base from '../../tsup.config.base';

// Two entry points, mirroring @launchdarkly/ai-server: the package root and
// `@launchdarkly/ai-node/experimental`. Both re-export from external packages,
// so there is nothing to share between them.
export default defineConfig({
  ...base,
  entry: { index: 'src/index.ts', experimental: 'src/experimental.ts' },
});
