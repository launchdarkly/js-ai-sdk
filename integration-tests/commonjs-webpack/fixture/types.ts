// Type-checked by the integration test under each `moduleResolution` a consumer may use,
// including `node` (node10), which ignores `exports` and needs `typesVersions` for a subpath.
import { config, initClient, setSkillStore as setNodeSkillStore } from '@launchdarkly/ai-node';
import * as nodeExperimental from '@launchdarkly/ai-node/experimental';
import * as server from '@launchdarkly/ai-server';
import { InMemorySkillStore, type SkillStore, setSkillStore } from '@launchdarkly/ai-server';
import { initEvaluations } from '@launchdarkly/ai-server/experimental';

const store: SkillStore = new InMemorySkillStore();
setSkillStore(store);
setNodeSkillStore(store);

// @ts-expect-error Agent Skills is not exported from the experimental subpath.
export const experimentalGetSkill = nodeExperimental.getSkill;

export const used = [config, initClient, server.config, initEvaluations, nodeExperimental.initEvaluations];
