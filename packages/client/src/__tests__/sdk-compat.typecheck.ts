// Compile-only (yarn typecheck): each server SDK's client must satisfy LDClientInterface without a cast.
import type * as akamai from '@launchdarkly/akamai-server-edgekv-sdk';
import type * as cloudflare from '@launchdarkly/cloudflare-server-sdk';
import type * as node from '@launchdarkly/node-server-sdk';
import type * as vercel from '@launchdarkly/vercel-server-sdk';
import type { LDClientInterface } from '../types.js';

// An unresolved client type degrades to `any` and would pass silently, so refuse it.
type Client<F extends (...args: never[]) => unknown> = 0 extends 1 & ReturnType<F>
  ? 'client type resolved to any'
  : ReturnType<F>;
type Satisfies<T extends LDClientInterface> = T;

// One slot per SDK, so one failure cannot hide another.
export type SdkClients = [
  Satisfies<Client<typeof node.init>>,
  Satisfies<Client<typeof vercel.init>>,
  Satisfies<Client<typeof cloudflare.init>>,
  Satisfies<Client<typeof akamai.init>>,
];
