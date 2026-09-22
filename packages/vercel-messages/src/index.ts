import { registerAiSdkPackage } from '@launchdarkly/ai-server';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

export {
  type VercelEvaluateOptions,
  type VercelEvaluateResult,
  vercelEvaluate,
} from './evaluate.js';
export {
  createVercelMessagesHandler,
  type VercelMessagesOptions,
  type VercelModelSource,
  vercelMessages,
} from './handler.js';
