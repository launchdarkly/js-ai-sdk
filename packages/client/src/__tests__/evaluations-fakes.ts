/**
 * Shared fakes for the Evaluations from Code tests: a recording management API
 * transport, a stub SDK client, and stub handlers. No test performs real
 * network I/O.
 */

import { vi } from 'vitest';
import { EvaluationsModule, type EvaluationsModuleInternals } from '../evaluations.js';
import type { Transport, TransportRequest, TransportResponse } from '../evaluations-api.js';
import type { ProviderHandler } from '../types.js';
import { createHandlerInternal } from '../utils.js';

const API_ROOT = 'https://app.launchdarkly.com/api/v2/';

export type Call = {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
};

/** A canned response, an error the transport throws, or a function of the request. */
export type Reply =
  | { status?: number; body?: unknown; headers?: Record<string, string> }
  | Error
  | ((call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> });

/**
 * A recording transport. Each route answers with its replies in order and
 * repeats the last one. An unrouted request fails the test.
 */
export class FakeApi {
  readonly calls: Call[] = [];
  private readonly routes: Array<{ method: string; path: string; replies: Reply[] }> = [];

  constructor(private readonly log?: string[]) {}

  on(method: string, path: string, ...replies: Reply[]): this {
    this.routes.unshift({ method, path, replies });
    return this;
  }

  /** Paths of the recorded requests, as `METHOD path`. */
  get sequence(): string[] {
    return this.calls.map((call) => `${call.method} ${call.path}`);
  }

  transport: Transport = async (request: TransportRequest): Promise<TransportResponse> => {
    const [pathPart, queryPart = ''] = request.url.replace(API_ROOT, '').split('?');
    const call: Call = {
      method: request.method,
      url: request.url,
      path: pathPart,
      query: new URLSearchParams(queryPart),
      headers: request.headers,
      body: request.body === undefined ? undefined : JSON.parse(request.body),
    };
    this.calls.push(call);
    this.log?.push(`${call.method} ${call.path}`);
    const route = this.routes.find((r) => r.method === call.method && r.path === call.path);
    if (!route) throw new Error(`unrouted request: ${call.method} ${call.path}`);
    const reply = route.replies.length > 1 ? route.replies.shift() : route.replies[0];
    if (reply instanceof Error) throw reply;
    const value = typeof reply === 'function' ? reply(call) : (reply ?? {});
    const body =
      value.body === undefined ? '' : typeof value.body === 'string' ? value.body : JSON.stringify(value.body);
    return { status: value.status ?? 200, body, headers: value.headers ?? {} };
  };
}

/** A transport that fails the test if it is used. */
export const throwingTransport: Transport = async (request) => {
  throw new Error(`no request may be sent: ${request.method} ${request.url}`);
};

export type Tracked = { name: string; context: Record<string, unknown>; data: Record<string, unknown>; metric: number };

export function stubClient(log?: string[]) {
  const tracked: Tracked[] = [];
  return {
    tracked,
    track: vi.fn((name: string, context: Record<string, unknown>, data: Record<string, unknown>, metric: number) => {
      tracked.push({ name, context, data, metric });
      log?.push(`track ${name}`);
    }),
    flush: vi.fn(async () => {
      log?.push('flush');
    }),
    variation: vi.fn(async () => {
      throw new Error('emission must not read a flag');
    }),
    close: vi.fn(async () => {}),
  };
}

export type StubClient = ReturnType<typeof stubClient>;

type HandlerImpl = (...args: Parameters<ProviderHandler>) => Promise<unknown>;

/** A handler stub that declares `providesFor`, as the harness requires. */
export function stubHandler(
  provider = 'OpenAI',
  mode: 'agent' | 'messages' = 'messages',
  impl: HandlerImpl = async (_config, input) => ({
    output: `out:${input}`,
    usage: { input_tokens: 1, output_tokens: 2 },
  }),
) {
  const fn = vi.fn(impl);
  return createHandlerInternal([provider, mode], fn as never) as ProviderHandler & typeof fn;
}

export const PROJECT = 'proj';
export const DATASET = 'ds';
export const EVALUATION_PATH = `projects/${PROJECT}/evaluations`;
export const RUN_PATH = `${EVALUATION_PATH}/ev-1/runs`;
export const SUMMARY_PATH = `${RUN_PATH}/run-1/summary`;

export const datasetRow = (rowIndex: number, extra: Record<string, unknown> = {}) => ({
  rowIndex,
  input: `question ${rowIndex}`,
  expectedOutput: `answer ${rowIndex}`,
  variables: {},
  ...extra,
});

export const terminalSummary = (total: number) => ({
  body: { statusCounts: { total, passed: total, failed: 0, error: 0, pending: 0 } },
});

/** Routes for a hosted run with `rows` on one page. */
export function routeHostedRun(api: FakeApi, rows: unknown[] = [datasetRow(0)]): FakeApi {
  return api
    .on('GET', `projects/${PROJECT}/datasets/${DATASET}`, { body: { id: 'ds-id', key: DATASET } })
    .on('GET', `projects/${PROJECT}/datasets/${DATASET}/rows`, { body: { items: rows, totalCount: rows.length } })
    .on('POST', EVALUATION_PATH, { status: 201, body: { id: 'ev-1', version: 3, name: 'eval-key' } })
    .on('POST', RUN_PATH, { status: 201, body: { id: 'run-1', evaluationId: 'ev-1', state: 'PENDING' } })
    .on('GET', SUMMARY_PATH, terminalSummary(rows.length));
}

/** Routes for an inline run with `rowCount` rows. */
export function routeInlineRun(api: FakeApi, rowCount: number): FakeApi {
  return api
    .on('POST', EVALUATION_PATH, { status: 201, body: { id: 'ev-1', version: 3, name: 'eval-key' } })
    .on('POST', RUN_PATH, { status: 201, body: { id: 'run-1', evaluationId: 'ev-1', state: 'PENDING' } })
    .on('POST', `${RUN_PATH}/run-1/dataset-rows`, { body: {} })
    .on('POST', `${RUN_PATH}/run-1/cancel`, { body: {} })
    .on('GET', SUMMARY_PATH, terminalSummary(rowCount));
}

/** A module wired to `api`, with no waiting between retries or polls. */
export function makeModule(api: FakeApi, internals: Partial<EvaluationsModuleInternals> = {}): EvaluationsModule {
  return new EvaluationsModule({
    projectKey: PROJECT,
    sdkKey: 'sdk-key',
    api: { apiKey: 'api-token', transport: api.transport, sleep: async () => {} },
    sleep: async () => {},
    ...internals,
  });
}

export const completion = (extra: Record<string, unknown> = {}) => ({
  provider: 'OpenAI',
  model: 'gpt-4o',
  mode: 'completion' as const,
  messages: [{ role: 'user' as const, content: '{{input}}' }],
  ...extra,
});
