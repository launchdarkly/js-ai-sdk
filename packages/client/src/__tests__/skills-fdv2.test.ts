/**
 * The FDv2 skill delivery transport.
 *
 * Two layers, deliberately, mirroring the Python suite:
 *
 * - **A real fake endpoint.** `FakeFDv2Endpoint` is an in-process
 *   `node:http` server implementing the wire contract — the `basis` query
 *   parameter, `Authorization`, `If-None-Match`/304, the `{"events": [...]}`
 *   polling envelope, and SSE for streaming. The store under test opens real
 *   sockets against it, so request construction and header handling are
 *   exercised rather than mocked.
 * - **The protocol reader driven directly.** Wire semantics — which objects are
 *   skills, the skill's version in the wire `key` versus the payload's in
 *   `version`, revocation, mixed payloads — are asserted against
 *   `ProtocolReader`, which has no I/O, so those cases read as the contract they
 *   are instead of as a server script.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Socket, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _clearState, _setStore, allSkills, getSkill, getSkillResult, InMemorySkillStore } from '../skills.js';
import { SKILL_OBJECT_KIND } from '../skills-core.js';
import {
  _warnedHashless,
  backoffDelayMs,
  classifyStatus,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_STREAM_READ_TIMEOUT_MS,
  decodePollBody,
  FDV2_KEY_DELIMITER,
  FDV2_OBJECT_KIND,
  FDv2SkillStore,
  FetchRequester,
  isSkillEvent,
  type PollResult,
  ProtocolReader,
  RecoverableTransportError,
  type Requester,
  retryAfterMs,
  SkillObjectSet,
  seamObjectFromPut,
  splitWireKey,
  tombstoneFromDelete,
} from '../skills-fdv2.js';
import { watchSkills } from '../skills-watch.js';
import type { RawSkillObject } from '../types.js';

const SDK_KEY = 'sdk-00000000-0000-4000-8000-000000000000';
const SKILL_BODY = '---\nname: PDF Extraction\n---\nExtract text from PDFs.\n';

const hash = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

// ─── Wire builders — one place that knows the shape ──────────────────────────

type WireEvent = { event: string; data?: unknown };

/**
 * The wire `key` of one skill object: `<key>:<version>`.
 *
 * `null` builds a key with no version at all, which is how the tests spell a
 * malformed object; anything else is spelled after the delimiter verbatim.
 */
function wireKey(key: string, objectVersion: unknown): string {
  if (objectVersion === null) return key;
  return `${key}${FDV2_KEY_DELIMITER}${String(objectVersion)}`;
}

/** One skill `put-object` event's data, in the shape the wire delivers it. */
function putSkill(
  key = 'pdf-extraction',
  {
    objectVersion = 3 as unknown,
    payloadVersion = 42,
    content = SKILL_BODY,
    contentHash = null as string | null,
    omitHash = false,
  } = {},
): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    contentType: 'text/markdown',
    content,
    name: 'PDF Extraction',
    description: 'Extracts text',
  };
  if (!omitHash) envelope.contentHash = contentHash ?? hash(content);
  return {
    key: wireKey(key, objectVersion),
    kind: FDV2_OBJECT_KIND,
    version: payloadVersion,
    object: envelope,
  };
}

function deleteSkill(key = 'pdf-extraction', { objectVersion = 3 as unknown, payloadVersion = 43 } = {}) {
  return {
    key: wireKey(key, objectVersion),
    kind: FDV2_OBJECT_KIND,
    version: payloadVersion,
  };
}

/** A flag `put-object`: the same envelope fields, a different `kind`. */
function putFlag(key = 'my-flag', version = 17) {
  return { key, kind: 'flag', version, object: { key, version, on: true, variations: [true, false] } };
}

function putSegment(key = 'beta-users', version = 4) {
  return { key, kind: 'segment', version, object: { key, version, included: [] } };
}

function serverIntent(code = 'xfer-full', payloadId = 'agent-skill') {
  return { payloads: [{ id: payloadId, target: 1, intentCode: code, reason: 'test' }] };
}

const transferred = (state = 'basis-1', version = 42) => ({ state, version });

const events = (...pairs: Array<[string, unknown]>): WireEvent[] => pairs.map(([event, data]) => ({ event, data }));

function fullPayload(objectEvents: Array<[string, unknown]>, state = 'basis-1'): WireEvent[] {
  return events(['server-intent', serverIntent('xfer-full')], ...objectEvents, [
    'payload-transferred',
    transferred(state),
  ]);
}

// ─── The fake endpoint ───────────────────────────────────────────────────────

type RecordedRequest = {
  path: string;
  query: Record<string, string>;
  authorization?: string;
  ifNoneMatch?: string;
  accept?: string;
};

/**
 * An in-process server implementing the SDK-facing FDv2 contract.
 *
 * Scripted per request: `queuePoll` appends a response for the next `/sdk/poll`,
 * `queueStream` appends a sequence of SSE events for the next `/sdk/stream`.
 * Every request's path, query and headers are recorded in `requests` so the tests
 * can assert on what the store actually sent — which is the only way `basis`
 * round-tripping and `If-None-Match` can be checked at all.
 */
class FakeFDv2Endpoint {
  readonly requests: RecordedRequest[] = [];
  holdStreamOpen = false;
  dropStreams = false;
  private readonly polls: Array<{
    status: number;
    events: WireEvent[];
    etag?: string;
    retryAfter?: string;
  }> = [];
  private readonly streams: WireEvent[][] = [];
  private readonly held = new Set<ServerResponse>();
  private server!: Server;
  private port = 0;

  async listen(): Promise<void> {
    this.server = createServer((req, res) => this.route(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.port = typeof address === 'object' && address !== null ? address.port : 0;
  }

  get baseUri(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  queuePoll(
    payloadEvents: WireEvent[] = [],
    extra: { status?: number; etag?: string; retryAfter?: string } = {},
  ): void {
    this.polls.push({
      status: extra.status ?? 200,
      events: payloadEvents,
      etag: extra.etag,
      retryAfter: extra.retryAfter,
    });
  }

  queueStream(payloadEvents: WireEvent[]): void {
    this.streams.push(payloadEvents);
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', this.baseUri);
    this.requests.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      authorization: req.headers.authorization,
      ifNoneMatch: req.headers['if-none-match'] as string | undefined,
      accept: req.headers.accept,
    });
    if (url.pathname === '/sdk/poll') this.servePoll(res);
    else if (url.pathname === '/sdk/stream') this.serveStream(res);
    else {
      res.writeHead(404);
      res.end();
    }
  }

  private servePoll(res: ServerResponse): void {
    const queued = this.polls.shift() ?? { status: 304, events: [] };
    const headers: Record<string, string> = {};
    if (queued.etag) headers.ETag = queued.etag;
    if (queued.retryAfter) headers['Retry-After'] = queued.retryAfter;
    if (queued.status === 200) {
      const body = JSON.stringify({ events: queued.events });
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(queued.status, headers);
    res.end();
  }

  private serveStream(res: ServerResponse): void {
    const payloadEvents = this.streams.shift() ?? [];
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const body = payloadEvents
      .map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data ?? null)}\n\n`)
      .join('');
    if (this.dropStreams) {
      // Kills the socket once the events have been flushed, rather than ending
      // the chunked response cleanly: how a live stream actually dies, as a
      // reset or a truncated chunk, not as an orderly end of body.
      res.write(body, () => res.socket?.destroy());
      return;
    }
    res.write(body);
    if (this.holdStreamOpen) {
      // Held so a test can assert on the store's state without racing the
      // reconnect path; released on `close`.
      this.held.add(res);
      return;
    }
    res.end();
  }

  async close(): Promise<void> {
    for (const res of this.held) res.end();
    this.held.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let endpoint: FakeFDv2Endpoint;
let openStores: FDv2SkillStore[];
let tempRoots: string[];
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  endpoint = new FakeFDv2Endpoint();
  await endpoint.listen();
  openStores = [];
  tempRoots = [];
  _clearState();
  // The hashless-object error is deduped per process; per test here.
  _warnedHashless.clear();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const store of openStores) await store.close();
  await endpoint.close();
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
  _clearState();
  vi.restoreAllMocks();
});

function pollStore(options: Record<string, unknown> = {}): FDv2SkillStore {
  const store = new FDv2SkillStore(SDK_KEY, {
    baseUri: endpoint.baseUri,
    mode: 'poll',
    pollIntervalMs: 20,
    initialBackoffMs: 5,
    maxBackoffMs: 20,
    ...options,
  });
  openStores.push(store);
  return store;
}

function streamStore(options: Record<string, unknown> = {}): FDv2SkillStore {
  const store = new FDv2SkillStore(SDK_KEY, {
    baseUri: endpoint.baseUri,
    mode: 'stream',
    initialBackoffMs: 5,
    maxBackoffMs: 20,
    ...options,
  });
  openStores.push(store);
  return store;
}

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ld-skills-fdv2-'));
  tempRoots.push(root);
  return root;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

const logged = (spy: ReturnType<typeof vi.spyOn>): string => spy.mock.calls.map((call) => String(call[0])).join('\n');

const consoleErrors = (): string => logged(errorSpy);

// ─── Identifying skill objects, and ignoring everything else ─────────────────

describe('object identification', () => {
  it('identifies a skill by the kind alone', () => {
    expect(isSkillEvent(putSkill())).toBe(true);
  });

  it('spells the kind as the bare category name', () => {
    // Object kinds on the channel are open strings and the agent-skill payload
    // is `generic`, so a skill arrives under the kind its producer registered —
    // `skill` — not under a broader wrapper kind.
    expect(FDV2_OBJECT_KIND).toBe('skill');
  });

  it('does not treat a flag as a skill', () => {
    expect(isSkillEvent(putFlag())).toBe(false);
  });

  it('does not treat a segment as a skill', () => {
    expect(isSkillEvent(putSegment())).toBe(false);
  });

  it('does not treat another generic kind as a skill', () => {
    // A generic payload may carry other registered kinds one day.
    expect(isSkillEvent({ ...putSkill(), kind: 'prompt-template' })).toBe(false);
  });

  it('does not treat a skill-shaped envelope under another kind as a skill', () => {
    expect(isSkillEvent({ ...putSkill(), kind: 'some-future-kind' })).toBe(false);
  });

  it('consults nothing but the kind', () => {
    // No secondary field narrows the kind, and none may be required.
    expect(Object.keys(putSkill()).sort()).toEqual(['key', 'kind', 'object', 'version']);
  });

  it.each([null, undefined, 'skill', 3, []])('does not treat %s as a skill', (value) => {
    expect(isSkillEvent(value)).toBe(false);
  });
});

// ─── The skill's version is in the wire key; `version` is the payload's. ─────

describe('version translation', () => {
  it('spells the wire key as key colon version', () => {
    expect(putSkill('pdf-extraction', { objectVersion: 3 }).key).toBe('pdf-extraction:3');
  });

  it('turns the version after the delimiter into the seam version', () => {
    const raw = seamObjectFromPut(putSkill('pdf-extraction', { objectVersion: 3, payloadVersion: 42 }));
    expect(raw?.version).toBe(3);
    expect(typeof raw?.version).toBe('number');
  });

  it('turns the key before the delimiter into the seam key', () => {
    // A caller asks for `pdf-extraction`, never for `pdf-extraction:3`.
    expect(seamObjectFromPut(putSkill('pdf-extraction', { objectVersion: 3 }))?.key).toBe('pdf-extraction');
  });

  it('never lets the payload version reach the seam', () => {
    // The failure this guards against is silent: a store that read `version`
    // would serve verifiable content under a version number that means nothing,
    // and every pinned reference would resolve to the wrong thing with no error.
    const raw = seamObjectFromPut(putSkill('pdf-extraction', { objectVersion: 3, payloadVersion: 42 }));
    expect(raw?.version).not.toBe(42);
    expect(Object.values(raw ?? {})).not.toContain(42);
  });

  it('distinguishes the two even when the payload version is lower', () => {
    expect(seamObjectFromPut(putSkill('k', { objectVersion: 99, payloadVersion: 1 }))?.version).toBe(99);
  });

  it('holds a key with no delimiter version-less', () => {
    // Not defaulted from the payload version, and not dropped: verification
    // reports `invalid_version` under a key the caller recognises.
    const raw = seamObjectFromPut(putSkill('pdf-extraction', { objectVersion: null }));
    expect(raw).not.toBeNull();
    expect(raw?.key).toBe('pdf-extraction');
    expect('version' in (raw as RawSkillObject)).toBe(false);
  });

  it.each([
    'latest',
    '',
    '3.0',
    '-1',
    '1:2',
    '３',
  ])('carries a version that is not digits (%j) through as invalid', (spelling) => {
    // Carried, not invented: verification reports `invalid_version` for the
    // object rather than the transport reporting it absent.
    const raw = seamObjectFromPut(putSkill('pdf-extraction', { objectVersion: spelling }));
    expect(raw).not.toBeNull();
    expect(raw?.key).toBe('pdf-extraction');
    expect(raw?.version).toBe(spelling);
  });

  it('reads leading zeros as the same version', () => {
    expect(seamObjectFromPut(putSkill('pdf-extraction', { objectVersion: '03' }))?.version).toBe(3);
  });

  it('reads the wire key the same way on a delete', () => {
    const tombstone = tombstoneFromDelete(deleteSkill('pdf-extraction', { objectVersion: 3, payloadVersion: 43 }));
    expect(tombstone?.key).toBe('pdf-extraction');
    expect(tombstone?.objectVersion).toBe(3);
  });

  it.each([null, 'latest', '0'])('reads a delete with no usable version (%j) as revoking every version', (spelling) => {
    const tombstone = tombstoneFromDelete(deleteSkill('pdf-extraction', { objectVersion: spelling }));
    expect(tombstone?.key).toBe('pdf-extraction');
    expect(tombstone?.objectVersion).toBeNull();
  });

  it.each([
    ':3',
    '',
    null,
    3,
  ])('drops a put whose key (%j) carries no skill key, since it has no identity', (badKey) => {
    expect(seamObjectFromPut({ ...putSkill(), key: badKey })).toBeNull();
  });

  it('drops a keyless put, which has no identity to store it under', () => {
    const { key: _dropped, ...keyless } = putSkill();
    expect(seamObjectFromPut(keyless)).toBeNull();
  });

  it('ignores a delete with no skill key', () => {
    expect(tombstoneFromDelete({ ...deleteSkill(), key: ':3' })).toBeNull();
  });

  it('splits both halves in one place', () => {
    expect(splitWireKey('pdf-extraction:3')).toEqual({ key: 'pdf-extraction', hasVersion: true, version: 3 });
    expect(splitWireKey('pdf-extraction')).toEqual({ key: 'pdf-extraction', hasVersion: false });
    expect(splitWireKey('pdf-extraction:latest')).toEqual({
      key: 'pdf-extraction',
      hasVersion: true,
      version: 'latest',
    });
    expect(splitWireKey(':3')).toBeNull();
    expect(splitWireKey('')).toBeNull();
    expect(splitWireKey(3)).toBeNull();
  });

  it('round-trips the stored identity to the wire key', () => {
    // `SkillObjectSet.snapshot` spells its opaque keys the way the wire does, so
    // a held object can be matched back to the event that carried it.
    const held = new SkillObjectSet();
    const wire = putSkill('pdf-extraction', { objectVersion: 3 });
    held.put(seamObjectFromPut(wire) as RawSkillObject);
    expect(Object.keys(held.snapshot())).toEqual([wire.key]);
  });

  it('copies the envelope verbatim', () => {
    const raw = seamObjectFromPut(putSkill());
    expect(raw?.content).toBe(SKILL_BODY);
    expect(raw?.contentHash).toBe(hash(SKILL_BODY));
    expect(raw?.name).toBe('PDF Extraction');
    expect(raw?.contentType).toBe('text/markdown');
  });

  it('leaves an absent envelope field absent rather than defaulting it', () => {
    const wire = putSkill();
    delete (wire.object as Record<string, unknown>).name;
    const raw = seamObjectFromPut(wire);
    expect(raw).not.toBeNull();
    expect('name' in (raw as RawSkillObject)).toBe(false);
  });
});

// ─── The protocol reader ─────────────────────────────────────────────────────

function drive(reader: ProtocolReader, payloadEvents: WireEvent[]) {
  return payloadEvents.map((event) => reader.handle(event.event, event.data));
}

describe('protocol reader', () => {
  it('commits a full transfer at payload-transferred', () => {
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    const outcomes = drive(reader, fullPayload([['put-object', putSkill()]]));
    expect(held.size).toBe(1);
    expect(outcomes.at(-1)?.committed).toBe(true);
    expect(outcomes.at(-1)?.basis).toBe('basis-1');
  });

  it('shows nothing before payload-transferred', () => {
    // A payload version is the unit of consistency; half of one is not a state.
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, events(['server-intent', serverIntent('xfer-full')], ['put-object', putSkill()]));
    expect(held.size).toBe(0);
  });

  it('leaves last known good intact when a full transfer is interrupted', () => {
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, fullPayload([['put-object', putSkill('pdf-extraction', { objectVersion: 1 })]]));
    expect(held.get('pdf-extraction', null)).not.toBeNull();

    drive(
      reader,
      events(
        ['server-intent', serverIntent('xfer-full')],
        ['put-object', putSkill('pdf-extraction', { objectVersion: 2 })],
      ),
    );
    expect(held.get('pdf-extraction', null)?.version).toBe(1);
  });

  it('replaces rather than merges on a full transfer', () => {
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, fullPayload([['put-object', putSkill('first')]]));
    drive(reader, fullPayload([['put-object', putSkill('second')]], 'basis-2'));
    expect(held.get('first', null)).toBeNull();
    expect(held.get('second', null)).not.toBeNull();
  });

  it('applies deltas over what is held on a change transfer', () => {
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, fullPayload([['put-object', putSkill('first')]]));
    drive(
      reader,
      events(
        ['server-intent', serverIntent('xfer-changes')],
        ['put-object', putSkill('second')],
        ['payload-transferred', transferred('basis-2')],
      ),
    );
    expect(held.get('first', null)).not.toBeNull();
    expect(held.get('second', null)).not.toBeNull();
  });

  it('revokes a skill on delete-object', () => {
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, fullPayload([['put-object', putSkill()]]));
    drive(
      reader,
      events(
        ['server-intent', serverIntent('xfer-changes')],
        ['delete-object', deleteSkill()],
        ['payload-transferred', transferred('basis-2')],
      ),
    );
    expect(held.get('pdf-extraction', null)).toBeNull();
    expect(reader.diagnostics.objectsRevoked).toBe(1);
  });

  it('notifies a delete with a tombstone carrying no content', () => {
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, fullPayload([['put-object', putSkill()]]));
    const outcomes = drive(
      reader,
      events(
        ['server-intent', serverIntent('xfer-changes')],
        ['delete-object', deleteSkill()],
        ['payload-transferred', transferred('basis-2')],
      ),
    );
    const changes = outcomes.at(-1)?.changes ?? [];
    expect(changes).toEqual([{ key: 'pdf-extraction', version: 3 }]);
    expect('content' in changes[0]).toBe(false);
  });

  it('leaves the other version held when one version is deleted', () => {
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(
      reader,
      fullPayload([
        ['put-object', putSkill('pdf-extraction', { objectVersion: 2 })],
        ['put-object', putSkill('pdf-extraction', { objectVersion: 3 })],
      ]),
    );
    drive(
      reader,
      events(
        ['server-intent', serverIntent('xfer-changes')],
        ['delete-object', deleteSkill('pdf-extraction', { objectVersion: 3 })],
        ['payload-transferred', transferred('basis-2')],
      ),
    );
    expect(held.get('pdf-extraction', 2)).not.toBeNull();
    expect(held.get('pdf-extraction', null)?.version).toBe(2);
  });

  it('skips flag and segment objects cleanly', () => {
    // The mixed payload is the normal case, not an edge one: an environment's
    // assignment carries the flagging payload alongside the agent-skill payload.
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    const outcomes = drive(
      reader,
      fullPayload([
        ['put-object', putFlag('flag-a')],
        ['put-object', putSkill('pdf-extraction')],
        ['put-object', putSegment('beta-users')],
        ['put-object', putFlag('flag-b')],
        ['delete-object', putFlag('flag-c')],
      ]),
    );
    expect(held.size).toBe(1);
    expect(held.get('pdf-extraction', null)).not.toBeNull();
    expect(reader.diagnostics.objectsIgnored).toBe(4);
    expect(reader.diagnostics.skillObjectsReceived).toBe(1);
    expect(outcomes.every((o) => !o.fatal && !o.disconnect)).toBe(true);
  });

  it('ignores an unknown kind rather than treating it as fatal', () => {
    // Erroring here is the unknown-kind reconnect loop this feature must not
    // reproduce — a flag-delivery outage caused by a skills rollout.
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    const outcomes = drive(
      reader,
      fullPayload([['put-object', { key: 'x', kind: 'quantum-widget', version: 1, object: { a: 1 } }]]),
    );
    expect(held.size).toBe(0);
    expect(outcomes.every((o) => !o.fatal && !o.disconnect)).toBe(true);
  });

  it('ignores an unknown event name', () => {
    const outcome = new ProtocolReader(new SkillObjectSet()).handle('some-future-event', { anything: true });
    expect(outcome.fatal).toBeUndefined();
    expect(outcome.disconnect).toBeUndefined();
  });

  it('does nothing on a heartbeat', () => {
    expect(new ProtocolReader(new SkillObjectSet()).handle('heart-beat', null)).toEqual({});
  });

  it('abandons the in-flight payload on an error event', () => {
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, fullPayload([['put-object', putSkill('pdf-extraction', { objectVersion: 1 })]]));
    const outcomes = drive(
      reader,
      events(
        ['server-intent', serverIntent('xfer-full')],
        ['put-object', putSkill('pdf-extraction', { objectVersion: 2 })],
        ['error', { payloadId: 'agent-skill', reason: 'backend unavailable' }],
      ),
    );
    expect(outcomes.at(-1)?.disconnect).toBeTruthy();
    expect(held.get('pdf-extraction', null)?.version).toBe(1);
  });

  it('asks for a reconnect on goodbye', () => {
    const outcome = new ProtocolReader(new SkillObjectSet()).handle('goodbye', {
      reason: 'rebalancing',
      silent: false,
    });
    expect(outcome.disconnect).toBeTruthy();
    expect(outcome.fatal).toBeFalsy();
  });

  it('treats a catastrophic goodbye as fatal', () => {
    const outcome = new ProtocolReader(new SkillObjectSet()).handle('goodbye', {
      reason: 'no',
      silent: false,
      catastrophe: true,
    });
    expect(outcome.fatal).toBeTruthy();
  });

  it('holds everything and commits on transfer-none', () => {
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, fullPayload([['put-object', putSkill()]]));
    drive(reader, events(['server-intent', serverIntent('none')], ['payload-transferred', transferred('basis-2')]));
    expect(held.size).toBe(1);
  });

  it('treats an object arriving with no intent as a delta', () => {
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, events(['put-object', putSkill()], ['payload-transferred', transferred('basis-1')]));
    expect(held.size).toBe(1);
  });
});

// ─── Which payload a transfer completed ──────────────────────────────────────

const payloadWarnings = (fragment: string): string[] =>
  logged(warnSpy)
    .split('\n')
    .filter((line) => line.includes(fragment));

/** One payload's events, with the payload it belongs to named explicitly. */
function skillPayload(
  objectEvents: Array<[string, unknown]>,
  { payloadId = 'agent-skill', code = 'xfer-full', state = 'basis-1' } = {},
): WireEvent[] {
  return events(['server-intent', serverIntent(code, payloadId)], ...objectEvents, [
    'payload-transferred',
    transferred(state),
  ]);
}

describe('payload identity', () => {
  // Delivery provides one payload per credential and the protocol requires a
  // client to read only the first payload intent, so today the payload read is
  // the payload skills arrive on. These assert the behaviour that survives if
  // the first of those stops holding: another payload's `xfer-full` must not
  // publish an empty skill set, because with pruning on that deletes a
  // customer's materialized files.

  it('reads only the first payload intent', () => {
    // Reading only the first is what the protocol asks for, however many
    // arrive — the point of the rest of this suite is to make that safe.
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(
      reader,
      events(
        [
          'server-intent',
          {
            payloads: [
              { id: 'agent-skill', target: 1, intentCode: 'xfer-full' },
              { id: 'env-flags', target: 2, intentCode: 'none' },
            ],
          },
        ],
        ['put-object', putSkill()],
        ['payload-transferred', transferred()],
      ),
    );
    expect(held.size).toBe(1);
  });

  it('warns once about more than one payload intent', () => {
    const reader = new ProtocolReader(new SkillObjectSet());
    const intent = {
      payloads: [
        { id: 'env-flags', target: 1, intentCode: 'xfer-changes' },
        { id: 'agent-skill', target: 2, intentCode: 'xfer-changes' },
      ],
    };
    reader.handle('server-intent', intent);
    reader.handle('server-intent', intent);
    expect(payloadWarnings('described 2 payloads')).toHaveLength(1);
  });

  it('warns about nothing for one payload intent', () => {
    drive(new ProtocolReader(new SkillObjectSet()), skillPayload([['put-object', putSkill()]]));
    expect(payloadWarnings('payload')).toEqual([]);
  });

  it("does not let another payload's full transfer empty the skills held", () => {
    // The case this guard exists for. A flag payload's `xfer-full` starts an
    // empty pending set; applying it at `payload-transferred` would publish
    // every skill as revoked, which a reconcile with pruning on reads as
    // "delete these files".
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, skillPayload([['put-object', putSkill()]]));
    const outcomes = drive(
      reader,
      skillPayload([['put-object', putFlag()]], { payloadId: 'env-flags', state: 'basis-2' }),
    );
    expect(held.get('pdf-extraction', null)).not.toBeNull();
    expect(reader.diagnostics.payloadsIgnored).toBe(1);
    expect(payloadWarnings('was not applied')).toHaveLength(1);
    // Nothing changed, so no listener is woken to reconcile against it.
    expect(outcomes.at(-1)?.changes).toEqual([]);
  });

  it('warns once about a declined transfer however often it repeats', () => {
    // A polling connection sees the other payload on every poll.
    const reader = new ProtocolReader(new SkillObjectSet());
    drive(reader, skillPayload([['put-object', putSkill()]]));
    const foreign = skillPayload([['put-object', putFlag()]], { payloadId: 'env-flags' });
    drive(reader, foreign);
    drive(reader, foreign);
    expect(payloadWarnings('was not applied')).toHaveLength(1);
    expect(reader.diagnostics.payloadsIgnored).toBe(2);
  });

  it('still empties the skills on a full transfer of the skill payload', () => {
    // Every skill deleted is a real state, and the guard must not mask it.
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, skillPayload([['put-object', putSkill()]]));
    drive(reader, skillPayload([], { state: 'basis-2' }));
    expect(held.size).toBe(0);
    expect(reader.diagnostics.payloadsIgnored).toBe(0);
  });

  it('identifies the payload as the skill payload from a revocation', () => {
    // A payload that only revokes is still a payload skills arrive on.
    const reader = new ProtocolReader(new SkillObjectSet());
    drive(reader, skillPayload([['delete-object', deleteSkill()]], { code: 'xfer-changes' }));
    drive(reader, skillPayload([['put-object', putSkill()]], { payloadId: 'env-flags' }));
    expect(reader.diagnostics.payloadsIgnored).toBe(1);
  });

  it('identifies the payload from the selector when no id is named', () => {
    // `payload-transferred`'s selector is the only other place a completed
    // transfer names its payload.
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    const unnamed = { payloads: [{ target: 1, intentCode: 'xfer-full' }] };
    drive(
      reader,
      events(
        ['server-intent', unnamed],
        ['put-object', putSkill()],
        ['payload-transferred', transferred('(p:agent-skill:53)')],
      ),
    );
    drive(
      reader,
      events(
        ['server-intent', unnamed],
        ['put-object', putFlag()],
        ['payload-transferred', transferred('(p:env-flags:12)')],
      ),
    );
    expect(held.get('pdf-extraction', null)).not.toBeNull();
    expect(reader.diagnostics.payloadsIgnored).toBe(1);
  });

  it('applies an unidentifiable payload rather than withholding it', () => {
    // A transfer naming no payload at all is the store's own, since delivery
    // sends it one payload. Withholding it would break the common case to
    // defend against a hypothetical one.
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, skillPayload([['put-object', putSkill()]]));
    drive(
      reader,
      events(
        ['server-intent', { payloads: [{ intentCode: 'xfer-full' }] }],
        ['put-object', putSkill('pdf-extraction', { objectVersion: 4 })],
        ['payload-transferred', { version: 44 }],
      ),
    );
    expect(held.get('pdf-extraction', null)?.version).toBe(4);
    expect(reader.diagnostics.payloadsIgnored).toBe(0);
  });

  it('leaves the first transfer of a connection as the residual', () => {
    // Before a skill has arrived there is nothing to compare a payload
    // against, so another payload's `xfer-full` arriving first cannot be told
    // apart. The multiple-payload warning is the only signal there is, which
    // is why it exists.
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(
      reader,
      events(
        [
          'server-intent',
          {
            payloads: [
              { id: 'env-flags', intentCode: 'xfer-full' },
              { id: 'agent-skill', intentCode: 'xfer-full' },
            ],
          },
        ],
        ['put-object', putFlag()],
        ['payload-transferred', transferred()],
      ),
    );
    expect(held.size).toBe(0);
    expect(payloadWarnings('described 2 payloads')).toHaveLength(1);
  });
});

// ─── The held object set ─────────────────────────────────────────────────────

describe('the held object set', () => {
  const raws: RawSkillObject[] = [
    { key: 'a', version: 1, content: 'x', contentHash: hash('x') },
    { key: 'a', version: 4, content: 'y', contentHash: hash('y') },
    { key: 'b', version: 2, content: 'z', contentHash: hash('z') },
    { key: 'malformed', version: 'not-a-version', content: 'q' },
  ];

  const filled = (): SkillObjectSet => {
    const set = new SkillObjectSet();
    for (const raw of raws) set.put({ ...raw });
    return set;
  };

  it('resolves a pin to the pinned version, not the newest', () => {
    expect(filled().get('a', 1)?.content).toBe('x');
    expect(filled().get('a', null)?.content).toBe('y');
  });

  it('falls through to the version-less entry for a pin it cannot satisfy well', () => {
    // A malformed object must reach verification and be withheld with a signal,
    // rather than reading as simply absent.
    expect(filled().get('malformed', 7)?.content).toBe('q');
  });

  it('answers null for a key it does not hold', () => {
    expect(filled().get('missing', null)).toBeNull();
    expect(filled().get('a', 99)).toBeNull();
  });

  it('collapses the snapshot to one object per key at its newest version', () => {
    // `<root>/<key>/SKILL.md` is a single path, so a whole-store consumer must
    // see one object per key. See the class docstring for why the collapse lives
    // here in this SDK and in `newest_by_key` in Python.
    const snapshot = filled().snapshot();
    const forA = Object.values(snapshot).filter((raw) => raw.key === 'a');
    expect(forA).toHaveLength(1);
    expect(forA[0].version).toBe(4);
    expect(Object.keys(snapshot)).toHaveLength(3);
  });

  it('keeps a malformed object in the snapshot so verification withholds it', () => {
    expect(Object.values(filled().snapshot()).some((raw) => raw.key === 'malformed')).toBe(true);
  });
});

// ─── The store against the fake endpoint ─────────────────────────────────────

describe('polling against the endpoint', () => {
  it('makes a polled skill retrievable through the accessors', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    const store = pollStore();
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    expect(store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction')?.version).toBe(3);
  });

  it('sends the SDK key and no data model version', async () => {
    // No `mv`: that parameter selects the *flag* data model, the connection
    // rejects any value but the flag default, and the generic agent-skill
    // payload is served regardless of it. Sending `mv=1` — the skill payload's
    // own model version — gets the whole connection refused.
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    expect(endpoint.requests[0].path).toBe('/sdk/poll');
    expect(endpoint.requests[0].authorization).toBe(SDK_KEY);
    expect('mv' in endpoint.requests[0].query).toBe(false);
  });

  it('sends no basis on the first request', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    expect(endpoint.requests[0].query.basis).toBeUndefined();
  });

  it('echoes the basis from payload-transferred on the next request', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]], 'selector-abc'));
    endpoint.queuePoll([], { status: 304 });
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    expect(await waitUntil(() => endpoint.requests.length >= 2)).toBe(true);
    expect(endpoint.requests[1].query.basis).toBe('selector-abc');
  });

  it('advances the basis across successive payloads', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]], 'basis-1'));
    endpoint.queuePoll(
      events(
        ['server-intent', serverIntent('xfer-changes')],
        ['put-object', putSkill('second')],
        ['payload-transferred', transferred('basis-2')],
      ),
    );
    endpoint.queuePoll([], { status: 304 });
    const store = pollStore();
    store.start();
    expect(await waitUntil(() => endpoint.requests.length >= 3)).toBe(true);
    expect(endpoint.requests.slice(0, 3).map((r) => r.query.basis)).toEqual([undefined, 'basis-1', 'basis-2']);
  });

  it('returns an ETag as If-None-Match', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]), { etag: 'W/"v1"' });
    endpoint.queuePoll([], { status: 304 });
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    expect(await waitUntil(() => endpoint.requests.length >= 2)).toBe(true);
    expect(endpoint.requests[1].ifNoneMatch).toBe('W/"v1"');
  });

  it('keeps held content across a 304', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]), { etag: 'W/"v1"' });
    endpoint.queuePoll([], { status: 304 });
    endpoint.queuePoll([], { status: 304 });
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    expect(await waitUntil(() => endpoint.requests.length >= 3)).toBe(true);
    expect(store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction')).not.toBeNull();
    expect(store.diagnostics.payloadsTransferred).toBe(1);
    expect(store.failed).toBeNull();
  });

  it('releases waitForSkills on a 304 before any payload', async () => {
    // A reconnect with a cached basis has nothing to transfer; boot must not
    // block on a payload the server has no reason to send.
    endpoint.queuePoll([], { status: 304 });
    const store = pollStore();
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
  });

  it('yields only the skill from a mixed payload', async () => {
    endpoint.queuePoll(
      fullPayload([
        ['put-object', putFlag('flag-a')],
        ['put-object', putSegment('beta')],
        ['put-object', putSkill('pdf-extraction')],
        ['put-object', putFlag('flag-b')],
      ]),
    );
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    const held = store.allObjects(SKILL_OBJECT_KIND);
    expect(Object.keys(held)).toHaveLength(1);
    expect(Object.values(held)[0].key).toBe('pdf-extraction');
    expect(store.diagnostics.objectsIgnored).toBe(3);
  });

  it('removes a revoked skill', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    endpoint.queuePoll(
      events(
        ['server-intent', serverIntent('xfer-changes')],
        ['delete-object', deleteSkill()],
        ['payload-transferred', transferred('basis-2')],
      ),
    );
    endpoint.queuePoll([], { status: 304 });
    const store = pollStore();
    store.start();
    expect(
      await waitUntil(
        () => store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction') === null && store.diagnostics.objectsRevoked === 1,
      ),
    ).toBe(true);
  });

  it('serves only the kind it holds', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    expect(store.getObject('flag', 'pdf-extraction')).toBeNull();
    expect(store.allObjects('flag')).toEqual({});
  });
});

describe('streaming against the endpoint', () => {
  it('lands a streamed payload', async () => {
    endpoint.holdStreamOpen = true;
    endpoint.queueStream(fullPayload([['put-object', putSkill()]]));
    const store = streamStore();
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    expect(store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction')).not.toBeNull();
  });

  it('advertises text/event-stream', async () => {
    endpoint.holdStreamOpen = true;
    endpoint.queueStream(fullPayload([['put-object', putSkill()]]));
    const store = streamStore();
    store.start();
    await store.waitForSkills(5000);
    expect(endpoint.requests[0].path).toBe('/sdk/stream');
    expect(endpoint.requests[0].accept).toBe('text/event-stream');
  });

  it('applies a streamed revocation without a restart', async () => {
    endpoint.holdStreamOpen = true;
    endpoint.queueStream([
      ...fullPayload([['put-object', putSkill()]]),
      ...events(
        ['server-intent', serverIntent('xfer-changes')],
        ['delete-object', deleteSkill()],
        ['payload-transferred', transferred('basis-2')],
      ),
    ]);
    const store = streamStore();
    store.start();
    expect(
      await waitUntil(
        () => store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction') === null && store.diagnostics.objectsRevoked === 1,
      ),
    ).toBe(true);
  });

  it('reconnects with the basis it reached', async () => {
    endpoint.queueStream(fullPayload([['put-object', putSkill()]], 'basis-1'));
    endpoint.queueStream(events(['heart-beat', null]));
    const store = streamStore();
    store.start();
    expect(await waitUntil(() => endpoint.requests.length >= 2)).toBe(true);
    expect(endpoint.requests[1].query.basis).toBe('basis-1');
  });

  it('keeps content across a reconnect', async () => {
    endpoint.queueStream(fullPayload([['put-object', putSkill()]]));
    endpoint.queueStream(events(['heart-beat', null]));
    const store = streamStore();
    store.start();
    expect(await waitUntil(() => endpoint.requests.length >= 2)).toBe(true);
    expect(store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction')).not.toBeNull();
  });

  it('returns promptly from close while a stream is open', async () => {
    // The delivery task spends its life awaiting a read; aborting the signal is
    // what interrupts it. A flag it never checks would leave a healthy stream
    // running until the process exited.
    endpoint.holdStreamOpen = true;
    endpoint.queueStream(fullPayload([['put-object', putSkill()]]));
    const store = streamStore();
    store.start();
    await store.waitForSkills(5000);
    const started = Date.now();
    await store.close();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not report an interrupted stream as a failure', async () => {
    endpoint.holdStreamOpen = true;
    endpoint.queueStream(fullPayload([['put-object', putSkill()]]));
    const store = streamStore();
    store.start();
    await store.waitForSkills(5000);
    await store.close();
    expect(store.failed).toBeNull();
  });

  it('reconnects when the stream dies mid-body', async () => {
    // A stream fails in its body far more often than at its connect. Treating
    // such a failure as unexpected would stop delivery — including revocation
    // — for the process lifetime the first time a socket died.
    endpoint.dropStreams = true;
    for (let i = 1; i <= 5; i += 1) {
      endpoint.queueStream(fullPayload([['put-object', putSkill()]], `basis-${i}`));
    }
    const store = streamStore({ maxConsecutiveFailures: 3 });
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    expect(await waitUntil(() => endpoint.requests.length >= 5)).toBe(true);
    expect(store.failed).toBeNull();
    expect(store.diagnostics.payloadsTransferred).toBeGreaterThanOrEqual(4);
  });

  it('reconnects when the stream goes quiet past readTimeoutMs', async () => {
    // `readTimeoutMs` exists to bound a stream that has gone quiet so the loop
    // can reconnect; tripping it must do that and not the opposite.
    endpoint.holdStreamOpen = true;
    endpoint.queueStream(fullPayload([['put-object', putSkill()]]));
    endpoint.queueStream(fullPayload([['put-object', putSkill()]], 'basis-2'));
    const store = streamStore({ readTimeoutMs: 100 });
    store.start();
    expect(await waitUntil(() => endpoint.requests.length >= 2)).toBe(true);
    expect(store.failed).toBeNull();
    expect(await waitUntil(() => (store.diagnostics.lastError ?? '').includes('timed out'))).toBe(true);
    expect(store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction')).not.toBeNull();
  });
});

// ─── Failure handling ────────────────────────────────────────────────────────

/**
 * Plays a scripted sequence, so backoff is asserted without real sockets.
 *
 * Each outcome is an `Error` to throw, an array of `[event, data]` pairs to
 * deliver (a stream that then ends, or one poll's events), or a promise to await
 * as-is. Exhausted, it fails recoverably on every call.
 */
class ScriptedRequester implements Requester {
  readonly calls: Array<[string | null, string | null]> = [];

  constructor(private readonly outcomes: unknown[] = []) {}

  private async next(): Promise<Array<[string, unknown]>> {
    const outcome = this.outcomes.length > 0 ? this.outcomes.shift() : new RecoverableTransportError('x');
    if (outcome instanceof Error) throw outcome;
    if (outcome instanceof Promise) return outcome as Promise<Array<[string, unknown]>>;
    return outcome as Array<[string, unknown]>;
  }

  async poll(basis: string | null, etag: string | null): Promise<PollResult> {
    this.calls.push([basis, etag]);
    return { notModified: false, events: await this.next(), etag: null };
  }

  async stream(basis: string | null): Promise<AsyncIterable<[string, unknown]>> {
    this.calls.push([basis, null]);
    const scripted = await this.next();
    return (async function* () {
      yield* scripted;
    })();
  }
}

const asPairs = (wire: WireEvent[]): Array<[string, unknown]> => wire.map((e) => [e.event, e.data]);

/**
 * A healthy server that recycles connections: every `stream` call succeeds,
 * transfers a full payload, and then ends the connection, as LaunchDarkly and
 * any proxy in between do to a long-lived stream.
 */
class RecyclingRequester implements Requester {
  connections = 0;

  poll(): Promise<PollResult> {
    throw new Error('not a polling double');
  }

  async stream(): Promise<AsyncIterable<[string, unknown]>> {
    this.connections += 1;
    const scripted = asPairs(fullPayload([['put-object', putSkill()]], `basis-${this.connections}`));
    return (async function* () {
      yield* scripted;
    })();
  }
}

function scriptedStreamStore(requester: Requester, options: Record<string, unknown> = {}): FDv2SkillStore {
  const store = new FDv2SkillStore(SDK_KEY, {
    mode: 'stream',
    initialBackoffMs: 1,
    maxBackoffMs: 2,
    requester,
    ...options,
  });
  openStores.push(store);
  return store;
}

describe('failure handling', () => {
  it('stops on 403 and explains why', async () => {
    endpoint.queuePoll([], { status: 403 });
    const store = pollStore();
    store.start();
    expect(await waitUntil(() => store.failed !== null)).toBe(true);
    expect(store.failed).toContain('403');
    expect(store.failed).toContain('opt-in');
    expect(consoleErrors()).toContain('opt-in');
  });

  it('stops on 401', async () => {
    endpoint.queuePoll([], { status: 401 });
    const store = pollStore();
    store.start();
    expect(await waitUntil(() => store.failed !== null)).toBe(true);
    expect(store.failed).toContain('401');
  });

  it('releases waitForSkills on a fatal failure rather than hanging', async () => {
    endpoint.queuePoll([], { status: 401 });
    const store = pollStore();
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    expect(store.failed).not.toBeNull();
  });

  it('keeps last known good servable after a fatal failure', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    endpoint.queuePoll([], { status: 403 });
    const store = pollStore();
    store.start();
    expect(await waitUntil(() => store.failed !== null)).toBe(true);
    expect(store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction')).not.toBeNull();
  });

  it('retries a 500', async () => {
    endpoint.queuePoll([], { status: 500 });
    endpoint.queuePoll([], { status: 503 });
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    const store = pollStore();
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    expect(store.failed).toBeNull();
    expect(store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction')).not.toBeNull();
  });

  it('resets the failure count on success', async () => {
    endpoint.queuePoll([], { status: 500 });
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    endpoint.queuePoll([], { status: 304 });
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    expect(await waitUntil(() => store.diagnostics.connectionFailures === 0)).toBe(true);
  });

  it('bounds retries', async () => {
    const store = new FDv2SkillStore(SDK_KEY, {
      mode: 'poll',
      pollIntervalMs: 5,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      maxConsecutiveFailures: 3,
      requester: new ScriptedRequester(),
    });
    openStores.push(store);
    store.start();
    expect(await waitUntil(() => store.failed !== null)).toBe(true);
    // Four, not three: the bound is the number of failures *tolerated*, so the
    // run that exceeds it is the one that gives up.
    expect(store.failed).toContain('gave up after 4 consecutive failures');
  });

  it('does not count recycled stream connections as failures', async () => {
    // A streaming connection only ever ends by being dropped, so a loop that
    // counted every drop as a failure would give up on a healthy server after
    // maxConsecutiveFailures + 1 recycles, and delivery (including revocation)
    // would silently stop for the process lifetime.
    const requester = new RecyclingRequester();
    const store = scriptedStreamStore(requester, { maxConsecutiveFailures: 3 });
    store.start();
    expect(await waitUntil(() => requester.connections >= 8)).toBe(true);
    expect(store.failed).toBeNull();
    expect(store.diagnostics.payloadsTransferred).toBeGreaterThanOrEqual(8);
    // A drop is a failure until the next commit clears it, so the count may
    // read 1 mid-reconnect. What it must never do is climb.
    expect(store.diagnostics.connectionFailures).toBeLessThanOrEqual(1);
    expect(store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction')).not.toBeNull();
  });

  it('resets the failure count on a stream commit', async () => {
    const requester = new ScriptedRequester([
      new RecoverableTransportError('x'),
      new RecoverableTransportError('x'),
      new RecoverableTransportError('x'),
      asPairs(fullPayload([['put-object', putSkill()]])),
    ]);
    const store = scriptedStreamStore(requester, { maxConsecutiveFailures: 3 });
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    // Three failures reach the bound, then a commit, then the exhausted
    // requester fails on every reconnect. The count must start again at the
    // commit: the stream's own drop is failure one, and three more connects are
    // owed before giving up. Carrying the three over would give up on the drop
    // itself, with no further connect at all.
    expect(await waitUntil(() => store.failed !== null)).toBe(true);
    expect(store.failed).toContain('gave up after 4 consecutive failures');
    expect(store.failed).toContain('last error: x');
    expect(requester.calls).toHaveLength(7);
  });

  it('bounds stream retries', async () => {
    const store = scriptedStreamStore(new ScriptedRequester(), { maxConsecutiveFailures: 3 });
    store.start();
    expect(await waitUntil(() => store.failed !== null)).toBe(true);
    expect(store.failed).toContain('gave up after 4 consecutive failures');
  });

  it('honours a Retry-After header off the wire', async () => {
    endpoint.queuePoll([], { status: 429, retryAfter: '0' });
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    // If Retry-After were ignored the 5s backoff would blow the timeout.
    const store = pollStore({ initialBackoffMs: 5000 });
    store.start();
    expect(await store.waitForSkills(3000)).toBe(true);
  });

  it('neither dies on nor parks behind an unreasonable Retry-After', async () => {
    // `Retry-After` is a request and `maxBackoffMs` is a promise: the header
    // may come from a proxy rather than LaunchDarkly, and an hour would park
    // revocation for that long.
    const requester = new ScriptedRequester([
      new RecoverableTransportError('slow down', 3_600_000),
      asPairs(fullPayload([['put-object', putSkill()]])),
    ]);
    const store = new FDv2SkillStore(SDK_KEY, {
      mode: 'poll',
      pollIntervalMs: 10_000,
      initialBackoffMs: 5_000,
      maxBackoffMs: 20,
      requester,
    });
    openStores.push(store);
    store.start();
    expect(await store.waitForSkills(3000)).toBe(true);
    expect(requester.calls.length).toBeGreaterThanOrEqual(2);
    expect(store.failed).toBeNull();
  });

  it('parses Retry-After into milliseconds', () => {
    expect(retryAfterMs(new Headers({ 'Retry-After': '2' }))).toBe(2000);
    expect(retryAfterMs(new Headers({ 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }))).toBeNull();
    expect(retryAfterMs(new Headers())).toBeNull();
  });

  it('classifies statuses into recoverable and fatal', () => {
    expect(classifyStatus(500).constructor.name).toBe('RecoverableTransportError');
    expect(classifyStatus(429).constructor.name).toBe('RecoverableTransportError');
    expect(classifyStatus(401).constructor.name).toBe('FatalTransportError');
    expect(classifyStatus(403).constructor.name).toBe('FatalTransportError');
    expect(classifyStatus(404).constructor.name).toBe('FatalTransportError');
    expect(classifyStatus(400).constructor.name).toBe('FatalTransportError');
  });

  it('makes backoff exponential and capped', () => {
    expect(backoffDelayMs(1, 1000, 30_000, 0)).toBe(1000);
    expect(backoffDelayMs(2, 1000, 30_000, 0)).toBe(2000);
    expect(backoffDelayMs(3, 1000, 30_000, 0)).toBe(4000);
    expect(backoffDelayMs(20, 1000, 30_000, 0)).toBe(30_000);
  });

  it('never lets jitter exceed the cap', () => {
    for (let attempt = 1; attempt < 12; attempt += 1) {
      for (let i = 0; i < 50; i += 1) {
        const delay = backoffDelayMs(attempt, 1000, 5000);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(5000);
      }
    }
  });

  it('treats a malformed polling envelope as recoverable', () => {
    expect(() => decodePollBody('{"nope":1}')).toThrow(/no 'events' array/);
    expect(() => decodePollBody('not json')).toThrow(/not valid JSON/);
  });

  it('does not let a throwing listener kill delivery', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill('first')]]));
    endpoint.queuePoll(
      events(
        ['server-intent', serverIntent('xfer-changes')],
        ['put-object', putSkill('second')],
        ['payload-transferred', transferred('basis-2')],
      ),
    );
    endpoint.queuePoll([], { status: 304 });
    const store = pollStore();
    store.addListener(SKILL_OBJECT_KIND, () => {
      throw new Error('boom');
    });
    store.start();
    expect(await waitUntil(() => store.getObject(SKILL_OBJECT_KIND, 'second') !== null)).toBe(true);
    expect(store.failed).toBeNull();
  });
});

// ─── The contentHash gap ─────────────────────────────────────────────────────

describe('the missing contentHash', () => {
  // The blocking backend gap, asserted as behaviour rather than assumed. An
  // envelope with no `contentHash` must produce a *withheld* skill with the
  // `missing_content_hash` reason — loudly, diagnosably, and without a crash.
  // There is deliberately no fallback that skips verification: a hash the SDK
  // computed from the content it was handed would certify the content against
  // itself and verify nothing.

  it('withholds a hashless skill with the right reason', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill('pdf-extraction', { omitHash: true })]]));
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    _setStore(store);

    const outcome = await getSkillResult('pdf-extraction');
    expect(outcome.skill).toBeNull();
    expect(outcome.reason).toBe('integrity_failure');
    expect(await getSkill('pdf-extraction')).toBeNull();
    expect(await allSkills()).toEqual([]);
  });

  it('still holds the object, so the outcome is not "absent"', async () => {
    // Holding it is what makes the failure diagnosable. Dropping it at the
    // transport would report `absent` — indistinguishable from "no such skill" —
    // and would let a prune delete the last known-good copy already on disk.
    endpoint.queuePoll(fullPayload([['put-object', putSkill('pdf-extraction', { omitHash: true })]]));
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    const raw = store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction');
    expect(raw).not.toBeNull();
    expect('contentHash' in (raw as RawSkillObject)).toBe(false);
    _setStore(store);
    expect((await getSkillResult('pdf-extraction')).reason).not.toBe('absent');
  });

  it('counts hashless objects', async () => {
    endpoint.queuePoll(
      fullPayload([
        ['put-object', putSkill('a', { omitHash: true })],
        ['put-object', putSkill('b', { omitHash: true })],
        ['put-object', putSkill('c')],
      ]),
    );
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    expect(store.diagnostics.hashlessObjects).toBe(2);
    expect(store.diagnostics.skillObjectsReceived).toBe(3);
  });

  it('logs an error naming the reason code', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill('pdf-extraction', { omitHash: true })]]));
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    const errors = consoleErrors();
    expect(errors).toContain('missing_content_hash');
    expect(errors).toContain('pdf-extraction');
    expect(errors).toContain('contentHash');
  });

  it('says so once when a whole payload is hashless', async () => {
    endpoint.queuePoll(
      fullPayload([
        ['put-object', putSkill('a', { omitHash: true })],
        ['put-object', putSkill('b', { omitHash: true })],
      ]),
    );
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    const summaries = consoleErrors()
      .split('\n')
      .filter((line) => line.includes('No skill content will resolve'));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('All 2 skill object(s)');
  });

  it('does not claim total failure for a partly hashed payload', async () => {
    endpoint.queuePoll(
      fullPayload([
        ['put-object', putSkill('a', { omitHash: true })],
        ['put-object', putSkill('b')],
      ]),
    );
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    expect(consoleErrors()).not.toContain('No skill content will resolve');
  });

  it('distinguishes a mismatched hash from a missing one', async () => {
    // `missing_content_hash` and `hash_mismatch` must not collapse: one is a
    // backend gap and the other is possible tampering.
    endpoint.queuePoll(
      fullPayload([['put-object', putSkill('pdf-extraction', { contentHash: hash('something else') })]]),
    );
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    expect(store.diagnostics.hashlessObjects).toBe(0);
    _setStore(store);
    expect((await getSkillResult('pdf-extraction')).reason).toBe('integrity_failure');
  });

  it('resolves a hashed skill end to end', async () => {
    // The positive control: everything above is a gap, not a broken adapter.
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    _setStore(store);

    const skill = await getSkill('pdf-extraction');
    expect(skill?.key).toBe('pdf-extraction');
    expect(skill?.version).toBe(3);
    expect(new TextDecoder().decode(skill?.content)).toBe(SKILL_BODY);
    expect(skill?.contentHash).toBe(hash(SKILL_BODY));
    expect(skill?.name).toBe('PDF Extraction');
  });

  it('resolves a pinned reference to the pinned version', async () => {
    endpoint.queuePoll(
      fullPayload([
        ['put-object', putSkill('pdf-extraction', { objectVersion: 2, content: 'v2 body' })],
        ['put-object', putSkill('pdf-extraction', { objectVersion: 5, content: 'v5 body' })],
      ]),
    );
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    _setStore(store);

    const pinned = await getSkill('pdf-extraction', { version: 2 });
    expect(new TextDecoder().decode(pinned?.content)).toBe('v2 body');
    expect((await getSkill('pdf-extraction'))?.version).toBe(5);
  });

  it('does not resolve the payload version as a skill version', async () => {
    // The end-to-end form of the wire-key/version assertion. Asking for the
    // payload version resolves nothing — reported `absent`, because the store
    // answers "I hold no such version" rather than answering with the wrong one.
    endpoint.queuePoll(
      fullPayload([['put-object', putSkill('pdf-extraction', { objectVersion: 3, payloadVersion: 42 })]]),
    );
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    _setStore(store);

    const byPayloadVersion = await getSkillResult('pdf-extraction', { version: 42 });
    expect(byPayloadVersion.skill).toBeNull();
    expect(byPayloadVersion.reason).toBe('absent');
    expect(await getSkill('pdf-extraction', { version: 3 })).not.toBeNull();
  });
});

// ─── Server-side only ────────────────────────────────────────────────────────

describe('server-side only', () => {
  it('refuses a mobile key', () => {
    expect(() => new FDv2SkillStore('mob-00000000-0000-4000-8000-000000000000')).toThrow(/mobile key/);
  });

  it('refuses a client-side environment ID', () => {
    expect(() => new FDv2SkillStore('0123456789abcdef01234567')).toThrow(/client-side/);
  });

  it('refuses an empty credential', () => {
    expect(() => new FDv2SkillStore('   ')).toThrow(/server-side SDK key/);
  });

  it('accepts a server-side key', () => {
    expect(new FDv2SkillStore(SDK_KEY)).toBeTruthy();
  });

  it('warns but allows an unrecognised credential shape', () => {
    // Private instances and test doubles issue keys without the public prefix.
    new FDv2SkillStore('my-private-instance-credential');
    expect(logged(warnSpy)).toContain('server-side SDK key');
  });

  it('refuses an unknown mode', () => {
    expect(() => new FDv2SkillStore(SDK_KEY, { mode: 'mobile' as never })).toThrow(/stream/);
  });
});

// ─── The eager re-reconcile ──────────────────────────────────────────────────

describe('watchSkills', () => {
  it('prunes a revoked skill without a restart', async () => {
    // AV-1, closed at this layer. The store's change listener drives the
    // reconcile, so the file goes away seconds after the delete-object rather
    // than at the next process start.
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    endpoint.queuePoll(
      events(
        ['server-intent', serverIntent('xfer-changes')],
        ['delete-object', deleteSkill()],
        ['payload-transferred', transferred('basis-2')],
      ),
    );
    endpoint.queuePoll([], { status: 304 });

    const store = pollStore({ pollIntervalMs: 100 });
    store.start();
    await store.waitForSkills(5000);
    _setStore(store);

    const root = path.join(await scratchRoot(), 'skills');
    const { report, watcher } = await watchSkills('*', root, { debounceMs: 20 });
    try {
      const written = path.join(root, 'pdf-extraction', 'SKILL.md');
      expect(await readFile(written, 'utf8')).toBe(SKILL_BODY);
      expect(report.actions.some((a) => a.action === 'written')).toBe(true);
      expect(await waitUntil(() => !existsSync(written), 10_000)).toBe(true);
    } finally {
      await watcher.close();
    }
  });

  it('rewrites a new version without a restart', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill('pdf-extraction', { content: 'first' })]]));
    endpoint.queuePoll(
      events(
        ['server-intent', serverIntent('xfer-full')],
        ['put-object', putSkill('pdf-extraction', { objectVersion: 4, content: 'second' })],
        ['payload-transferred', transferred('basis-2')],
      ),
    );
    endpoint.queuePoll([], { status: 304 });

    const store = pollStore({ pollIntervalMs: 100 });
    store.start();
    await store.waitForSkills(5000);
    _setStore(store);

    const root = path.join(await scratchRoot(), 'skills');
    const { watcher } = await watchSkills('*', root, { debounceMs: 20 });
    try {
      const written = path.join(root, 'pdf-extraction', 'SKILL.md');
      expect(await readFile(written, 'utf8')).toBe('first');
      expect(await waitUntil(() => existsSync(written) && readFileSync(written, 'utf8') === 'second', 10_000)).toBe(
        true,
      );
    } finally {
      await watcher.close();
    }
  });

  it('coalesces a burst of changes into few reconciles', async () => {
    endpoint.queuePoll(
      fullPayload(Array.from({ length: 12 }, (_, i) => ['put-object', putSkill(`skill-${i}`)] as [string, unknown])),
    );
    endpoint.queuePoll([], { status: 304 });
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    _setStore(store);

    const root = path.join(await scratchRoot(), 'skills');
    const { watcher } = await watchSkills('*', root, { debounceMs: 50 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      // Twelve objects committed in one payload fire twelve listener calls;
      // without coalescing that is twelve reconciles of one root.
      expect(watcher.reconciles).toBeLessThanOrEqual(2);
    } finally {
      await watcher.close();
    }
  });

  it('keeps last known good during an outage', async () => {
    // `onUnavailable: 'keep'` is the endorsed default: an outage must not read as
    // "everything was revoked".
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    endpoint.queuePoll([], { status: 500 });
    const store = pollStore({ pollIntervalMs: 20 });
    store.start();
    await store.waitForSkills(5000);
    _setStore(store);

    const root = path.join(await scratchRoot(), 'skills');
    const { watcher } = await watchSkills('*', root, { debounceMs: 20 });
    try {
      const written = path.join(root, 'pdf-extraction', 'SKILL.md');
      expect(await readFile(written, 'utf8')).toBe(SKILL_BODY);
      // `lastError` rather than `connectionFailures`: the counter resets on the
      // next successful poll, so asserting on it races the retry.
      expect(await waitUntil(() => store.diagnostics.lastError !== null, 10_000)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await readFile(written, 'utf8')).toBe(SKILL_BODY);
    } finally {
      await watcher.close();
    }
  });

  it('refuses a store with no addListener, loudly', async () => {
    _setStore({
      getObject: () => null,
      allObjects: () => ({}),
    });
    await expect(watchSkills('*', await scratchRoot())).rejects.toThrow(/addListener/);
  });

  it('throws when no store is configured', async () => {
    await expect(watchSkills('*', await scratchRoot())).rejects.toThrow(/configured skill store/);
  });

  it('can also be driven by the in-memory store', async () => {
    // The watcher is wired to the seam, not to the FDv2 store.
    const store = new InMemorySkillStore();
    store.put({ key: 'a', version: 1, content: 'body', contentHash: hash('body') });
    _setStore(store);

    const root = path.join(await scratchRoot(), 'skills');
    const { watcher } = await watchSkills('*', root, { debounceMs: 20 });
    try {
      const written = path.join(root, 'a', 'SKILL.md');
      expect(await readFile(written, 'utf8')).toBe('body');
      store.put({ key: 'a', version: 2, content: 'new body', contentHash: hash('new body') });
      expect(await waitUntil(() => existsSync(written) && readFileSync(written, 'utf8') === 'new body', 10_000)).toBe(
        true,
      );
    } finally {
      await watcher.close();
    }
  });
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('makes start idempotent', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    const store = pollStore();
    expect(store.start()).toBe(store);
    expect(store.start()).toBe(store);
    expect(await store.waitForSkills(5000)).toBe(true);
  });

  it('makes close idempotent', async () => {
    const store = pollStore();
    store.start();
    await store.close();
    await store.close();
  });

  it('keeps answering from what it received after close', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    const store = pollStore();
    store.start();
    await store.waitForSkills(5000);
    await store.close();
    expect(store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction')).not.toBeNull();
  });

  it('times out waitForSkills rather than hanging', async () => {
    const store = new FDv2SkillStore(SDK_KEY, {
      mode: 'poll',
      pollIntervalMs: 60_000,
      requester: new ScriptedRequester([new Promise(() => {})]),
    });
    openStores.push(store);
    expect(await store.waitForSkills(50)).toBe(false);
  });

  it('satisfies the seam before it starts', () => {
    const store = new FDv2SkillStore(SDK_KEY);
    expect(store.getObject(SKILL_OBJECT_KIND, 'anything')).toBeNull();
    expect(store.allObjects(SKILL_OBJECT_KIND)).toEqual({});
  });
});

// ─── Timeouts ────────────────────────────────────────────────────────────────

/**
 * A listening socket that accepts connections and never sends a byte.
 *
 * This is the host `readTimeoutMs` exists for: the TCP handshake completes, so
 * nothing fails fast, and then no response ever comes. A request against it can
 * only end by timing out, which makes the elapsed time a direct measurement of
 * the timeout actually applied.
 */
class BlackHole {
  private server!: TcpServer;
  private readonly accepted: Socket[] = [];
  baseUri = '';

  async listen(): Promise<void> {
    this.server = createTcpServer((socket) => {
      this.accepted.push(socket);
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    this.baseUri = `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    for (const socket of this.accepted) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const requesterOf = (store: FDv2SkillStore): FetchRequester =>
  (store as unknown as { requester: FetchRequester }).requester;

describe('timeouts', () => {
  // `readTimeoutMs` is the only network timeout, and every request honours it.
  // The bounds asserted here are loose on purpose: the point is that a request
  // against an unresponsive host fails in roughly `readTimeoutMs` rather than
  // in minutes, and that a regression back to a much longer default fails this
  // suite quickly instead of hanging it.
  let blackHole: BlackHole;

  beforeEach(async () => {
    blackHole = new BlackHole();
    await blackHole.listen();
  });

  afterEach(async () => {
    await blackHole.close();
  });

  it('fails a poll against an unresponsive host within readTimeoutMs', async () => {
    const requester = new FetchRequester(SDK_KEY, blackHole.baseUri, 300);
    const started = Date.now();
    await expect(requester.poll(null, null, new AbortController().signal)).rejects.toThrow(/timed out/);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(2000);
  });

  it('fails a stream connect against an unresponsive host within readTimeoutMs', async () => {
    const requester = new FetchRequester(SDK_KEY, blackHole.baseUri, 300);
    const started = Date.now();
    await expect(requester.stream(null, new AbortController().signal)).rejects.toThrow(RecoverableTransportError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports the timeout and keeps going', async () => {
    const store = new FDv2SkillStore(SDK_KEY, {
      baseUri: blackHole.baseUri,
      mode: 'poll',
      pollIntervalMs: 50,
      initialBackoffMs: 10,
      maxBackoffMs: 50,
      readTimeoutMs: 300,
    });
    openStores.push(store);
    store.start();
    expect(await waitUntil(() => store.diagnostics.connectionFailures >= 1)).toBe(true);
    expect(store.failed).toBeNull();
    expect(store.diagnostics.lastError).toContain('timed out');
  });

  it('returns promptly from close while a connect is pending', async () => {
    // Before the connect returns there is no body read to interrupt; aborting
    // the signal has to reach the pending `fetch` itself, or close waits on a
    // host that will never speak.
    const store = new FDv2SkillStore(SDK_KEY, { baseUri: blackHole.baseUri, mode: 'stream', readTimeoutMs: 60_000 });
    store.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await store.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(store.failed).toBeNull();
  });

  it('defaults the bound per mode', () => {
    expect(DEFAULT_POLL_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_STREAM_READ_TIMEOUT_MS).toBe(300_000);
    expect(requesterOf(new FDv2SkillStore(SDK_KEY, { mode: 'poll' })).readTimeoutMs).toBe(DEFAULT_POLL_TIMEOUT_MS);
    expect(requesterOf(new FDv2SkillStore(SDK_KEY, { mode: 'stream' })).readTimeoutMs).toBe(
      DEFAULT_STREAM_READ_TIMEOUT_MS,
    );
  });

  it.each(['poll', 'stream'] as const)('lets an explicit readTimeoutMs override the %s default', (mode) => {
    expect(requesterOf(new FDv2SkillStore(SDK_KEY, { mode, readTimeoutMs: 42_000 })).readTimeoutMs).toBe(42_000);
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])('rejects a non-positive readTimeoutMs (%s)', (value) => {
    expect(() => new FDv2SkillStore(SDK_KEY, { readTimeoutMs: value })).toThrow(/readTimeoutMs/);
  });
});
