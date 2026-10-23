import { defineConfig } from 'tsup';
import base from '../../tsup.config.base';

// Two entry points: the package root and `@launchdarkly/ai-claude-agents/experimental`. Each is
// bundled on its own, so the experimental entry carries its own copy of the handler; the handler
// keeps no module state, so the copies cannot disagree.
export default defineConfig({
  ...base,
  entry: { index: 'src/index.ts', experimental: 'src/experimental.ts' },
});
