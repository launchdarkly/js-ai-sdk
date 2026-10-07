import { registerAiSdkPackage } from '@launchdarkly/ai-server';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

export { createTypesafeHandler, type TypesafeHandlerOptions } from './handler.js';
export {
  buildTypesafeState,
  type ExtractedQuestion,
  extractTypesafeQuestions,
  reasonFromAnswer,
  scoreFromAnswer,
  TypesafeQuestionError,
  type TypesafeQuestionType,
} from './questions.js';
