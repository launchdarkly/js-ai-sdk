import { createNeverForwarded } from '../../../client/src/__tests__/never-forwarded-keys.js';

export { NEVER_FORWARDED } from '../../../client/src/__tests__/never-forwarded-keys.js';

/**
 * This package's never-forward bag (ai-sdks-monorepo TESTING.md §1.12): the shared key list from
 * every never-forward category.
 */
const bag = createNeverForwarded();

/** Keys that must never reach a provider, framework or host-process option from `model.parameters`. */
export const NEVER_FORWARDED_KEYS = bag.keys;

/** A `model.parameters` bag that sets every key in `NEVER_FORWARDED_KEYS` to `NEVER_FORWARDED`. */
export const NEVER_FORWARDED_PARAMETERS = bag.parameters;

export const expectNoNeverForwardedValue = bag.expectNoNeverForwardedValue;
