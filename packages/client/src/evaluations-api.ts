/**
 * Evaluations from Code — a minimal retrying client for the LaunchDarkly
 * management API, plus the wire helpers the harness shares.
 *
 * Every request goes through an injectable {@link Transport}, so tests replace
 * the network with a recording fake.
 */

/** The default management API host. Override with `apiBaseUri` on `initEvaluations` or `LD_API_BASE_URI`. */
export const DEFAULT_BASE_URI = 'https://app.launchdarkly.com';

/** The default UI host for run links. Override with `uiBaseUri` or `LD_UI_BASE_URI`. */
export const DEFAULT_UI_BASE_URI = 'https://app.launchdarkly.com';

const API_VERSION = '20240415';
const USER_AGENT = 'launchdarkly-ai-evaluations-javascript';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;

// Only these methods are replayed after a 5xx or a transport failure: a POST
// that timed out may still have created a record server-side.
const RETRY_SAFE_METHODS = new Set(['GET', 'HEAD']);

/** Base error for the evaluations harness. */
export class EvaluationsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EvaluationsError';
  }
}

/** A non-2xx response from the LaunchDarkly management API. */
export class LDApiError extends EvaluationsError {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`LaunchDarkly API ${method} ${path} failed with ${status}: ${body}`);
    this.name = 'LDApiError';
  }
}

/** One request the management API client sends through its {@link Transport}. */
export type TransportRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
};

/** The response a {@link Transport} returns. Header names are lowercase. */
export type TransportResponse = {
  status: number;
  body: string;
  headers: Record<string, string>;
};

/** The seam every management API request goes through. Replaced in tests. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** The default {@link Transport}, built on `fetch`. */
export const fetchTransport: Transport = async ({ method, url, headers, body, timeoutMs }) => {
  const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name.toLowerCase()] = value;
  });
  return { status: response.status, body: await response.text(), headers: responseHeaders };
};

export type LDApiClientOptions = {
  apiKey: string;
  /** Management API host. Default {@link DEFAULT_BASE_URI}. */
  baseUri?: string;
  transport?: Transport;
  timeoutMs?: number;
  /** Retries after the first attempt. */
  maxRetries?: number;
  /** Waits between attempts. Injected by tests to assert delays without waiting. */
  sleep?: (seconds: number) => Promise<void>;
  /** Jitter source in `[0, 1)`. Injected by tests. */
  random?: () => number;
};

export type RequestOptions = {
  body?: unknown;
  params?: Record<string, string | number | undefined>;
  /** A POST the server applies at most once per payload, so it may be replayed like a GET. */
  idempotent?: boolean;
};

export const sleepSeconds = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/** Minimal retrying client for the LaunchDarkly public management API. */
export class LDApiClient {
  private readonly apiKey: string;
  private readonly baseUri: string;
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (seconds: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: LDApiClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUri = (options.baseUri ?? DEFAULT_BASE_URI).replace(/\/+$/, '');
    this.transport = options.transport ?? fetchTransport;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.sleep = options.sleep ?? sleepSeconds;
    this.random = options.random ?? Math.random;
  }

  urlFor(path: string, params?: Record<string, string | number | undefined>): string {
    const url = `${this.baseUri}/api/v2/${path.replace(/^\/+/, '')}`;
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params ?? {})) {
      if (value !== undefined) query.append(name, String(value));
    }
    const encoded = query.toString();
    return encoded ? `${url}?${encoded}` : url;
  }

  retryDelay(attempt: number, response?: TransportResponse): number {
    const retryAfter = response?.headers['retry-after']?.trim();
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.max(0, seconds);
      const when = Date.parse(retryAfter);
      if (!Number.isNaN(when)) return Math.max(0, (when - Date.now()) / 1000);
    }
    const exponential = Math.min(30, 0.5 * 2 ** attempt);
    return exponential + this.random() * Math.min(1, exponential);
  }

  /** Send one request, retrying where a replay cannot duplicate work. */
  async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const retrySafe = options.idempotent === true || RETRY_SAFE_METHODS.has(method.toUpperCase());
    const headers: Record<string, string> = {
      Authorization: this.apiKey,
      Accept: 'application/json',
      'LD-API-Version': API_VERSION,
      'User-Agent': USER_AGENT,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const url = this.urlFor(path, options.params);

    let response: TransportResponse | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        response = await this.transport({ method, url, headers, body, timeoutMs: this.timeoutMs });
      } catch (err) {
        if (!retrySafe || attempt >= this.maxRetries) {
          throw new EvaluationsError(`LaunchDarkly API ${method} ${path} failed: ${errorMessage(err)}`, {
            cause: err,
          });
        }
        await this.sleep(this.retryDelay(attempt));
        continue;
      }
      // A 429 is rejected before the server acts on it, so it is safe to
      // replay for any method.
      const retryable = response.status === 429 || (response.status >= 500 && retrySafe);
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(this.retryDelay(attempt, response));
        continue;
      }
      break;
    }

    if (!response) throw new EvaluationsError(`LaunchDarkly API ${method} ${path} returned no response`);
    if (response.status < 200 || response.status >= 300) {
      throw new LDApiError(response.status, method, path, response.body);
    }
    if (!response.body) return null;
    try {
      return JSON.parse(response.body);
    } catch (err) {
      throw new EvaluationsError(`LaunchDarkly API ${method} ${path} returned invalid JSON`, { cause: err });
    }
  }

  get(path: string, params?: Record<string, string | number | undefined>): Promise<unknown> {
    return this.request('GET', path, { params });
  }

  post(path: string, body?: unknown, options: { idempotent?: boolean } = {}): Promise<unknown> {
    return this.request('POST', path, { body, idempotent: options.idempotent });
  }
}

/** Percent-encode one path segment. */
export const segment = (value: string): string => encodeURIComponent(value);

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Return `value` as an object. Throws {@link EvaluationsError}. */
export function requireObject(value: unknown, description: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new EvaluationsError(`LaunchDarkly returned an invalid ${description} response`);
  return value;
}

/** Return the non-empty string at `key`. Throws {@link EvaluationsError}. */
export function requireString(data: Record<string, unknown>, key: string, description: string): string {
  const value = data[key];
  if (typeof value !== 'string' || !value) {
    throw new EvaluationsError(`LaunchDarkly ${description} response is missing string field '${key}'`);
  }
  return value;
}

/**
 * Throw unless `value` is strict JSON: plain objects, arrays, strings, finite
 * numbers, booleans and `null`, recursively. `JSON.stringify` alone is not
 * enough: it writes `null` for `NaN` and `±Infinity`, turns a `Date` into a
 * string, and writes a `Map` or `Set` as `{}`, each a silent rewrite of the
 * caller's value. The message names the offending path.
 */
export function assertStrictJson(value: unknown, path = '$', seen: Set<object> = new Set()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} is ${value}, which is not valid JSON`);
    return;
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    if (seen.has(value)) throw new TypeError(`${path} is a circular reference`);
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        assertStrictJson(item, `${path}[${index}]`, seen);
      });
    } else {
      for (const [key, item] of Object.entries(value)) assertStrictJson(item, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return;
  }
  const kind = typeof value === 'object' ? (value.constructor?.name ?? 'object') : typeof value;
  throw new TypeError(`${path} is a ${kind}, which is not a JSON value`);
}
