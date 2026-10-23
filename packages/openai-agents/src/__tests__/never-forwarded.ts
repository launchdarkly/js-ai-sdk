import { createNeverForwarded } from '../../../client/src/__tests__/never-forwarded-keys.js';

export { NEVER_FORWARDED } from '../../../client/src/__tests__/never-forwarded-keys.js';

// `top_logprobs` is not on the OpenAI Agents list (§1.12): the Python Agents SDK adds an output
// item for it that the handler does not read.
const PACKAGE_NEVER_FORWARDED_KEYS = ['top_logprobs', 'topLogprobs'];

/**
 * This package's never-forward bag (ai-sdks-monorepo TESTING.md §1.12): the shared key list from
 * every never-forward category, plus the keys only the OpenAI Agents list leaves out.
 */
const bag = createNeverForwarded(PACKAGE_NEVER_FORWARDED_KEYS);

/** Keys that must never reach a provider, framework or host-process option from `model.parameters`. */
export const NEVER_FORWARDED_KEYS = bag.keys;

/** A `model.parameters` bag that sets every key in `NEVER_FORWARDED_KEYS` to `NEVER_FORWARDED`. */
export const NEVER_FORWARDED_PARAMETERS = bag.parameters;

export const expectNoNeverForwardedValue = bag.expectNoNeverForwardedValue;
