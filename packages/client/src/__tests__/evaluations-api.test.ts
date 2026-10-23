import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvaluationsError, LDApiClient, LDApiError } from '../evaluations-api.js';
import { FakeApi } from './evaluations-fakes.js';

function client(api: FakeApi, options: { maxRetries?: number; random?: () => number } = {}) {
  const sleep = vi.fn(async (_seconds: number) => {});
  const ld = new LDApiClient({ apiKey: 'api-token', transport: api.transport, sleep, ...options });
  return { ld, sleep };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('management API client: request shape', () => {
  it('builds <host>/api/v2/<path> and omits undefined query parameters', async () => {
    const api = new FakeApi().on('GET', 'projects/p/thing', { body: {} });
    const { ld } = client(api);
    await ld.get('projects/p/thing', { mode: 'all', limit: 200, offset: undefined, q: 'a b&c' });
    const [call] = api.calls;
    expect(call.url.startsWith('https://app.launchdarkly.com/api/v2/projects/p/thing?')).toBe(true);
    expect(call.query.get('mode')).toBe('all');
    expect(call.query.get('q')).toBe('a b&c');
    expect(call.query.has('offset')).toBe(false);
    expect(call.url).not.toContain('undefined');
  });

  it('sends the raw token, Accept, LD-API-Version and a user agent, and Content-Type only with a body', async () => {
    const api = new FakeApi().on('GET', 'a', { body: {} }).on('POST', 'b', { body: {} });
    const { ld } = client(api);
    await ld.get('a');
    await ld.post('b', { x: 1 });
    const [get, post] = api.calls;
    for (const call of [get, post]) {
      expect(call.headers.Authorization).toBe('api-token');
      expect(call.headers.Accept).toBe('application/json');
      expect(call.headers['LD-API-Version']).toMatch(/^(\d{8}|beta)$/);
      expect(call.headers['User-Agent']).toMatch(/evaluations.*javascript/);
    }
    expect(get.headers['Content-Type']).toBeUndefined();
    expect(post.headers['Content-Type']).toBe('application/json');
    expect(post.body).toEqual({ x: 1 });
  });

  it('defaults to app.launchdarkly.com', async () => {
    const api = new FakeApi().on('GET', 'a', { body: {} });
    await client(api).ld.get('a');
    expect(api.calls[0].url).toBe('https://app.launchdarkly.com/api/v2/a');
  });

  it('targets the host it is given, without a trailing slash', async () => {
    const api = new FakeApi().on('GET', 'a', { body: {} });
    await new LDApiClient({ apiKey: 't', baseUri: 'http://localhost:8080/', transport: api.transport }).get('a');
    expect(api.calls[0].url).toBe('http://localhost:8080/api/v2/a');
  });
});

describe('management API client: responses', () => {
  it('parses a 2xx JSON body', async () => {
    const api = new FakeApi().on('GET', 'a', { body: { ok: true } });
    await expect(client(api).ld.get('a')).resolves.toEqual({ ok: true });
  });

  it('returns null for a 2xx with an empty body', async () => {
    const api = new FakeApi().on('POST', 'a', { status: 204 });
    await expect(client(api).ld.post('a')).resolves.toBeNull();
  });

  it('throws on a 2xx with invalid JSON', async () => {
    const api = new FakeApi().on('GET', 'a', { body: '{not json' });
    await expect(client(api).ld.get('a')).rejects.toThrow(/invalid JSON/);
  });

  it('throws an API error carrying status, method, path and body on a non-2xx', async () => {
    const api = new FakeApi().on('GET', 'a/b', { status: 404, body: 'gone' });
    const err = await client(api)
      .ld.get('a/b')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LDApiError);
    expect(err).toBeInstanceOf(EvaluationsError);
    expect(err).toMatchObject({ status: 404, method: 'GET', path: 'a/b', body: 'gone' });
    for (const part of ['404', 'GET', 'a/b', 'gone']) expect((err as Error).message).toContain(part);
  });
});

describe('management API client: retries', () => {
  it('retries a 429 for a POST', async () => {
    const api = new FakeApi().on('POST', 'a', { status: 429 }, { status: 201, body: { id: 'x' } });
    await expect(client(api).ld.post('a', {})).resolves.toEqual({ id: 'x' });
    expect(api.calls).toHaveLength(2);
  });

  it('retries a 5xx for a GET', async () => {
    const api = new FakeApi().on('GET', 'a', { status: 503 }, { body: { ok: 1 } });
    await expect(client(api).ld.get('a')).resolves.toEqual({ ok: 1 });
    expect(api.calls).toHaveLength(2);
  });

  it('does not retry a 5xx for a POST: the record may already exist', async () => {
    const api = new FakeApi().on('POST', 'a', { status: 503 }, { status: 201, body: {} });
    await expect(client(api).ld.post('a', {})).rejects.toBeInstanceOf(LDApiError);
    expect(api.calls).toHaveLength(1);
  });

  it('does not retry a transport failure for a POST', async () => {
    const api = new FakeApi().on('POST', 'a', new Error('timeout'), { body: {} });
    await expect(client(api).ld.post('a', {})).rejects.toThrow(/timeout/);
    expect(api.calls).toHaveLength(1);
  });

  it('retries a transport failure for a GET', async () => {
    const api = new FakeApi().on('GET', 'a', new Error('reset'), { body: { ok: 1 } });
    await expect(client(api).ld.get('a')).resolves.toEqual({ ok: 1 });
    expect(api.calls).toHaveLength(2);
  });

  it('retries an idempotent POST on a 5xx and on a transport failure', async () => {
    const fiveHundred = new FakeApi().on('POST', 'a', { status: 503 }, { body: { ok: 1 } });
    await expect(client(fiveHundred).ld.post('a', {}, { idempotent: true })).resolves.toEqual({ ok: 1 });
    expect(fiveHundred.calls).toHaveLength(2);

    const timeout = new FakeApi().on('POST', 'a', new Error('timeout'), { body: { ok: 2 } });
    await expect(client(timeout).ld.post('a', {}, { idempotent: true })).resolves.toEqual({ ok: 2 });
    expect(timeout.calls).toHaveLength(2);
  });

  it('never retries another 4xx', async () => {
    const api = new FakeApi().on('GET', 'a', { status: 403 }, { body: {} });
    await expect(client(api).ld.get('a')).rejects.toMatchObject({ status: 403 });
    expect(api.calls).toHaveLength(1);
  });

  it('bounds retries by the maximum', async () => {
    const api = new FakeApi().on('GET', 'a', { status: 503 });
    await expect(client(api, { maxRetries: 2 }).ld.get('a')).rejects.toMatchObject({ status: 503 });
    expect(api.calls).toHaveLength(3);
  });

  it('honors a numeric Retry-After', async () => {
    const api = new FakeApi().on('GET', 'a', { status: 429, headers: { 'retry-after': '7' } }, { body: {} });
    const { ld, sleep } = client(api);
    await ld.get('a');
    expect(sleep).toHaveBeenCalledWith(7);
  });

  it('converts an HTTP-date Retry-After to a delay', async () => {
    const when = new Date(Date.now() + 10_000).toUTCString();
    const api = new FakeApi().on('GET', 'a', { status: 503, headers: { 'retry-after': when } }, { body: {} });
    const { ld, sleep } = client(api);
    await ld.get('a');
    const delay = sleep.mock.calls[0][0];
    expect(delay).toBeGreaterThan(8);
    expect(delay).toBeLessThanOrEqual(10);
  });

  it('otherwise backs off exponentially with jitter', async () => {
    const api = new FakeApi().on('GET', 'a', { status: 503 }, { status: 503 }, { status: 503 }, { body: {} });
    const { ld, sleep } = client(api, { random: () => 0.5 });
    await ld.get('a');
    // 0.5 * 2^attempt, plus random * min(1, that).
    expect(sleep.mock.calls.map(([seconds]) => seconds)).toEqual([0.75, 1.5, 2.5]);
  });
});
