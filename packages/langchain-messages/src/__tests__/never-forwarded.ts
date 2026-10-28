import { createNeverForwarded } from '../../../client/src/__tests__/never-forwarded-keys.js';

export { NEVER_FORWARDED } from '../../../client/src/__tests__/never-forwarded-keys.js';

// `reasoning` switches `ChatOpenAI` to the Responses API, which the LangChain handlers do not read.
const PACKAGE_NEVER_FORWARDED_KEYS = ['reasoning'];

/**
 * This package's never-forward bag: the shared key list from
 * every never-forward category, plus the keys only the LangChain list leaves out.
 */
const bag = createNeverForwarded(PACKAGE_NEVER_FORWARDED_KEYS);

/** Keys that must never reach a provider, framework or host-process option from `model.parameters`. */
export const NEVER_FORWARDED_KEYS = bag.keys;

/** A `model.parameters` bag that sets every key in `NEVER_FORWARDED_KEYS` to `NEVER_FORWARDED`. */
export const NEVER_FORWARDED_PARAMETERS = bag.parameters;

export const expectNoNeverForwardedValue = bag.expectNoNeverForwardedValue;
