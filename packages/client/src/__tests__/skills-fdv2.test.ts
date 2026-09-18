/**
 * The FDv2 skill delivery transport.
 *
 * Two layers, deliberately:
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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Socket, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _clearState,
  _setEmitterForTesting,
  _setStore,
  allSkills,
  getSkill,
  getSkillResult,
  InMemorySkillStore,
} from '../skills.js';
import { SKILL_OBJECT_KIND } from '../skills-core.js';
import {
  backoffDelayMs,
  classifyStatus,
  DEFAULT_BASE_URI,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_STREAM_READ_TIMEOUT_MS,
  DEFAULT_STREAM_URI,
  decodePollBody,
  FDV2_KEY_DELIMITER,
  FDV2_OBJECT_KIND,
  FDv2SkillStore,
  FetchRequester,
  isSkillEvent,
  iterSse,
  MAX_RESPONSE_CHARS,
  type PollResult,
  ProtocolReader,
  RecoverableTransportError,
  type Requester,
  retryAfterMs,
  SkillObjectSet,
  StaleRequestStateError,
  seamObjectFromPut,
  splitWireKey,
  tombstoneFromDelete,
} from '../skills-fdv2.js';
import { writeSkills } from '../skills-fs.js';
import { SkillWatcher, watchSkills } from '../skills-watch.js';
import type { RawSkillObject, ReconcileReport } from '../types.js';

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
  /** When set alongside `holdStreamOpen`, a `heart-beat` is sent on this interval. */
  heartbeatMs: number | null = null;
  private readonly heartbeats = new Set<ReturnType<typeof setInterval>>();
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
    // Sent even when blank: a proxy that emits an empty `Retry-After` is a case
    // the store has to survive, so the fake has to be able to produce one.
    if (queued.retryAfter !== undefined) headers['Retry-After'] = queued.retryAfter;
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
      if (this.heartbeatMs !== null) {
        const timer = setInterval(() => res.write('event: heart-beat\ndata: {}\n\n'), this.heartbeatMs);
        this.heartbeats.add(timer);
        res.on('close', () => {
          clearInterval(timer);
          this.heartbeats.delete(timer);
        });
      }
      return;
    }
    res.end();
  }

  async close(): Promise<void> {
    for (const timer of this.heartbeats) clearInterval(timer);
    this.heartbeats.clear();
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

/** A telemetry emitter that records instead of emitting (§3.24). */
class RecordingEmitter {
  records: Array<[string, Record<string, unknown>]> = [];
  record(signal: string, properties: Record<string, unknown>): void {
    this.records.push([signal, properties]);
  }
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

  it('keys the snapshot by the skill key, not the wire key', () => {
    // `writeSkills('*')` builds its prune keep-set from these keys, so a
    // `key:version` spelling here would make every unverifiable object fall out
    // of the keep-set and take the copy already on disk with it. `allRaw` is
    // what matches a held object back to the event that carried it.
    const held = new SkillObjectSet();
    const wire = putSkill('pdf-extraction', { objectVersion: 3 });
    held.put(seamObjectFromPut(wire) as RawSkillObject);
    expect(wire.key).toBe('pdf-extraction:3');
    expect(Object.keys(held.snapshot())).toEqual(['pdf-extraction']);
    expect(held.allRaw()).toEqual([{ ...seamObjectFromPut(wire) }]);
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

  it('counts objects arriving under an unknown intent code as ignored, and warns once per intent', () => {
    // A future intent code is neither a full nor a changes transfer, so its
    // objects cannot be applied without guessing — and guessing could empty the
    // store. They are dropped, but visibly: counted under `objectsIgnored`, with
    // one warning per intent rather than one per object.
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, fullPayload([['put-object', putSkill('kept')]]));
    const before = warnSpy.mock.calls.length;
    drive(
      reader,
      events(
        ['server-intent', serverIntent('xfer-future')],
        ['put-object', putSkill('a')],
        ['put-object', putSkill('b')],
        ['delete-object', deleteSkill('kept')],
        ['payload-transferred', transferred('basis-2')],
      ),
    );
    expect(reader.diagnostics.objectsIgnored).toBe(3);
    expect(reader.diagnostics.skillObjectsReceived).toBe(1);
    expect(warnSpy.mock.calls.length - before).toBe(1);
    expect(logged(warnSpy)).toContain('xfer-future');
    expect(held.get('kept', null)).not.toBeNull();
    expect(held.size).toBe(1);
    // A fresh intent announcement warns afresh.
    drive(reader, events(['server-intent', serverIntent('xfer-future')], ['put-object', putSkill('c')]));
    expect(warnSpy.mock.calls.length - before).toBe(2);
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

  it('reports but does not count a delete-object for a key it never held (§3.25)', () => {
    // `objectsRevoked` is read precisely when somebody is working out whether a
    // revocation landed, so a tombstone for nothing must not inflate it. The
    // tombstone still reaches listeners through `changes`.
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, fullPayload([['put-object', putSkill('kept')]]));
    const outcomes = drive(
      reader,
      events(
        ['server-intent', serverIntent('xfer-changes')],
        ['delete-object', deleteSkill('never-held')],
        ['payload-transferred', transferred('basis-2')],
      ),
    );
    expect(reader.diagnostics.objectsRevoked).toBe(0);
    expect((outcomes.at(-1)?.changes ?? []).map((raw) => ({ key: raw.key, version: raw.version }))).toEqual([
      { key: 'never-held', version: 3 },
    ]);
    expect(held.size).toBe(1);
  });

  it('counts a delete-object that actually removed something — the other half', () => {
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(
      reader,
      fullPayload([
        ['put-object', putSkill('a')],
        ['put-object', putSkill('b')],
      ]),
    );
    drive(
      reader,
      events(
        ['server-intent', serverIntent('xfer-changes')],
        ['delete-object', deleteSkill('a')],
        ['delete-object', deleteSkill('a')],
        ['payload-transferred', transferred('basis-2')],
      ),
    );
    // The second delete of the same object removed nothing, so one, not two.
    expect(reader.diagnostics.objectsRevoked).toBe(1);
    expect(held.size).toBe(1);
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
    // Expected, so the reconnect it asks for is not counted as a failure.
    expect(outcome.expected).toBe(true);
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
    const outcomes = drive(reader, skillPayload([], { state: 'basis-2' }));
    expect(held.size).toBe(0);
    expect(reader.diagnostics.payloadsIgnored).toBe(0);
    // And it reports the revocation, which is what wakes a listener. A full
    // transfer revokes by omission — no `delete-object` says the skill is gone —
    // so an empty change list here would commit an empty store silently and
    // leave the revoked files on disk until the process restarted.
    expect(outcomes.at(-1)?.changes).toEqual([{ key: 'pdf-extraction', version: 3 }]);
    expect(reader.diagnostics.objectsRevoked).toBe(1);
  });

  it('reports the departures when a full transfer replaces the set', () => {
    // The general form of the same thing: what the payload did not carry is
    // gone, and a listener that reads versions needs both halves of a version
    // move — the put for the arrival, the tombstone for the departure.
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(
      reader,
      skillPayload([
        ['put-object', putSkill('a')],
        ['put-object', putSkill('b')],
      ]),
    );
    const outcomes = drive(
      reader,
      skillPayload([['put-object', putSkill('a', { objectVersion: 4 })]], { state: 'basis-2' }),
    );
    expect(held.size).toBe(1);
    // The arrival carries content, as a put's change always has; the departures
    // are tombstones, spelled exactly as `delete-object`'s are.
    const changes = outcomes.at(-1)?.changes ?? [];
    expect(changes.map((raw) => ({ key: raw.key, version: raw.version }))).toEqual([
      { key: 'a', version: 4 },
      { key: 'a', version: 3 },
      { key: 'b', version: 3 },
    ]);
    expect(changes[0].content).toBe(SKILL_BODY);
    expect(changes.slice(1).every((raw) => !('content' in raw))).toBe(true);
  });

  it('does not count a version bump as a revocation', () => {
    // `objectsRevoked` is the kind of counter an operator alerts on, so a
    // routine version move must not raise it. The departed version is still
    // reported, because a listener that reads versions needs both halves.
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, skillPayload([['put-object', putSkill('pdf-extraction', { objectVersion: 1 })]]));
    const outcomes = drive(
      reader,
      skillPayload([['put-object', putSkill('pdf-extraction', { objectVersion: 2 })]], { state: 'basis-2' }),
    );
    expect(reader.diagnostics.objectsRevoked).toBe(0);
    expect((outcomes.at(-1)?.changes ?? []).map((raw) => ({ key: raw.key, version: raw.version }))).toEqual([
      { key: 'pdf-extraction', version: 2 },
      { key: 'pdf-extraction', version: 1 },
    ]);
  });

  it('counts only the keys a full transfer dropped altogether', () => {
    // One key moves and one leaves: exactly one revocation, both tombstones.
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(
      reader,
      skillPayload([
        ['put-object', putSkill('a', { objectVersion: 1 })],
        ['put-object', putSkill('b', { objectVersion: 1 })],
      ]),
    );
    const outcomes = drive(
      reader,
      skillPayload([['put-object', putSkill('a', { objectVersion: 2 })]], { state: 'basis-2' }),
    );
    expect(reader.diagnostics.objectsRevoked).toBe(1);
    expect((outcomes.at(-1)?.changes ?? []).map((raw) => raw.key)).toEqual(['a', 'a', 'b']);
  });

  it('counts a key that leaves once however many versions it held', () => {
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(
      reader,
      skillPayload([
        ['put-object', putSkill('a', { objectVersion: 1 })],
        ['put-object', putSkill('a', { objectVersion: 2 })],
      ]),
    );
    drive(reader, skillPayload([['put-object', putSkill('b', { objectVersion: 1 })]], { state: 'basis-2' }));
    expect(reader.diagnostics.objectsRevoked).toBe(1);
    expect(held.get('a', null)).toBeNull();
  });

  it('does not adopt the basis of a foreign payload announced with the none intent (§3.25)', () => {
    // A `none` intent builds no pending set, and the foreign check must not be
    // gated on one: the transfer that follows still names a payload, and
    // adopting its selector would resume the next connection from someone
    // else's payload with every diagnostic reading healthy.
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, fullPayload([['put-object', putSkill()]], 'basis-skills'));
    const outcomes = drive(
      reader,
      events(['server-intent', serverIntent('none', 'env-flags')], ['payload-transferred', transferred('basis-flags')]),
    );
    expect(outcomes.at(-1)?.basis).toBeNull();
    expect(reader.diagnostics.payloadsIgnored).toBe(1);
    expect(held.get('pdf-extraction', null)).not.toBeNull();
  });

  it('does not adopt the selector of a payload it declined', () => {
    // Ignoring a foreign payload's contents while adopting its resume point
    // would ask the next poll or stream to resume from someone else's payload:
    // skill updates could stop arriving while every diagnostic read healthy.
    const reader = new ProtocolReader(new SkillObjectSet());
    const ours = drive(reader, skillPayload([['put-object', putSkill()]], { state: 'skills-basis' }));
    expect(ours.at(-1)?.basis).toBe('skills-basis');

    const outcomes = drive(
      reader,
      skillPayload([['put-object', putFlag()]], { payloadId: 'env-flags', state: 'flag-basis' }),
    );
    expect(outcomes.at(-1)?.basis).toBeNull();
    expect(reader.diagnostics.payloadsIgnored).toBe(1);
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
    // see one object per key.
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

  it('keeps asking from the skill basis when another payload transfers', async () => {
    // The wire half of the declined-payload case: the store must resume from the
    // payload skills arrive on, not from the one it just threw away.
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]], 'skills-basis'));
    endpoint.queuePoll(
      events(
        ['server-intent', serverIntent('xfer-full', 'env-flags')],
        ['put-object', putFlag()],
        ['payload-transferred', transferred('flag-basis')],
      ),
    );
    endpoint.queuePoll([], { status: 304 });
    const store = pollStore();
    store.start();
    expect(await waitUntil(() => endpoint.requests.length >= 3)).toBe(true);
    expect(endpoint.requests.slice(0, 3).map((r) => r.query.basis)).toEqual([
      undefined,
      'skills-basis',
      'skills-basis',
    ]);
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

describe('SSE framing', () => {
  const sseBody = (text: string): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });

  const framed = async (text: string): Promise<Array<[string, unknown]>> => {
    const seen: Array<[string, unknown]> = [];
    for await (const event of iterSse(sseBody(text))) seen.push(event);
    return seen;
  };

  it('drops a block with no event name without eating the next event', async () => {
    expect(await framed('data: {"orphan":true}\n\nevent: heart-beat\ndata: {}\n\n')).toEqual([['heart-beat', {}]]);
  });

  it('keeps both named events around a nameless block', async () => {
    expect(
      await framed('event: heart-beat\ndata: {"n":1}\n\ndata: {"orphan":true}\n\nevent: heart-beat\ndata: {"n":2}\n\n'),
    ).toEqual([
      ['heart-beat', { n: 1 }],
      ['heart-beat', { n: 2 }],
    ]);
  });

  it('ignores a comment between events', async () => {
    expect(
      await framed('event: heart-beat\ndata: {"n":1}\n\n: keep-alive\n\nevent: heart-beat\ndata: {"n":2}\n\n'),
    ).toEqual([
      ['heart-beat', { n: 1 }],
      ['heart-beat', { n: 2 }],
    ]);
  });

  it('dispatches a named block with no data as a null payload', async () => {
    expect(await framed('event: heart-beat\n\n')).toEqual([['heart-beat', null]]);
  });

  /**
   * Feeds `iterSse` the same text in reads of a fixed size, so a test can say
   * which quantity the bound is being pushed past. `sseBody` hands the whole
   * body over as one read, which is the one shape a real `fetch` never produces:
   * undici caps its chunks at 64 KiB (16 KiB through gzip) however much the
   * server wrote at once.
   */
  const chunkedBody = (text: string, chunk: number): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (let i = 0; i < text.length; i += chunk) controller.enqueue(encoder.encode(text.slice(i, i + chunk)));
        controller.close();
      },
    });

  /** Enqueues exactly the reads given, so a test can place the read boundaries. */
  const readsOf = (...reads: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const read of reads) controller.enqueue(encoder.encode(read));
        controller.close();
      },
    });

  const drained = async (body: ReadableStream<Uint8Array>): Promise<Array<[string, unknown]>> => {
    const seen: Array<[string, unknown]> = [];
    for await (const event of iterSse(body)) seen.push(event);
    return seen;
  };

  it('bounds an unterminated line and fails recoverably rather than buffering it without limit', async () => {
    // A server (or a proxy) that never sends a newline would otherwise grow the
    // line buffer until the process ran out of memory. Recoverable, so the
    // connection is dropped and retried rather than the store giving up.
    const newlineless = 'x'.repeat(MAX_RESPONSE_CHARS + 1024);
    await expect(drained(chunkedBody(newlineless, 1024 * 1024))).rejects.toBeInstanceOf(RecoverableTransportError);
  });

  it('bounds the accumulated data lines of one event the same way', async () => {
    // Every read here ends on a line boundary, so no tail is ever carried and the
    // accumulated `data:` total is the only quantity that grows. That is what
    // makes this the per-event check rather than the tail check: handed the whole
    // body in one read, or in reads that straddle the lines, the tail crosses
    // first and this would pass without the per-event accounting it pins.
    const line = `data: ${'y'.repeat(1024 * 1024)}\n`;
    const dataPerLine = line.length - 'data: '.length;
    const lines = Math.ceil(MAX_RESPONSE_CHARS / dataPerLine) + 1;
    const body = readsOf('event: put-object\n', ...Array.from({ length: lines }, () => line));
    await expect(drained(body)).rejects.toThrow(/characters of data for one event/);
  });

  it('accepts a read that delivered many finished events at once', async () => {
    // The bound is per event, and the two quantities it measures must not be
    // summed while a read is still being split: a burst whose events are each
    // well inside the bound is not one oversized event, however much of it
    // arrived together. Sized past the bound in total and nowhere near it per
    // event, which is the only shape that tells the two apart.
    const one = (i: number) =>
      `event: put-object\ndata: ${JSON.stringify({ i, pad: 'p'.repeat(4 * 1024 * 1024) })}\n\n`;
    const count = Math.ceil(MAX_RESPONSE_CHARS / (4 * 1024 * 1024)) + 1;
    const burst = Array.from({ length: count }, (_, i) => one(i)).join('');
    expect(burst.length).toBeGreaterThan(MAX_RESPONSE_CHARS);
    expect(await drained(sseBody(burst))).toHaveLength(count);
  });

  it('accepts one event larger than the cap verification enforces on content', async () => {
    // Content rides inline in the envelope, so the transport bound has to clear
    // the 10 MiB content cap: a skill this size is verification's business to
    // accept or withhold, and must reach it rather than being dropped as a
    // framing failure and retried into the failure budget.
    const big = JSON.stringify({ content: 'z'.repeat(11 * 1024 * 1024) });
    expect(big.length).toBeLessThan(MAX_RESPONSE_CHARS);
    const framedEvents = await drained(chunkedBody(`event: put-object\ndata: ${big}\n\n`, 64 * 1024));
    expect(framedEvents).toEqual([['put-object', JSON.parse(big)]]);
  });

  it('still dispatches an event well inside the bound', async () => {
    const big = JSON.stringify({ content: 'z'.repeat(64 * 1024) });
    expect(await framed(`event: put-object\ndata: ${big}\n\n`)).toEqual([['put-object', JSON.parse(big)]]);
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

  /**
   * Honours the store's abort signal the way the real requester does: a
   * scripted promise that never settles still lets `close()` return, since the
   * store aborts the signal and awaits the delivery loop.
   */
  private async next(signal: AbortSignal): Promise<Array<[string, unknown]>> {
    const outcome = this.outcomes.length > 0 ? this.outcomes.shift() : new RecoverableTransportError('x');
    if (outcome instanceof Error) throw outcome;
    if (outcome instanceof Promise) {
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = (): void => reject(signal.reason ?? new Error('aborted'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      return Promise.race([outcome as Promise<Array<[string, unknown]>>, aborted]);
    }
    return outcome as Array<[string, unknown]>;
  }

  async poll(basis: string | null, etag: string | null, signal: AbortSignal): Promise<PollResult> {
    this.calls.push([basis, etag]);
    return { notModified: false, events: await this.next(signal), etag: null };
  }

  async stream(basis: string | null, signal: AbortSignal): Promise<AsyncIterable<[string, unknown]>> {
    this.calls.push([basis, null]);
    const scripted = await this.next(signal);
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

/**
 * A healthy server with nothing to send: every connection is answered with the
 * `none` intent — what we hold is already current — and then closed with a
 * goodbye, which is how a long-lived stream is recycled. Nothing commits,
 * because there is nothing to commit; given a first transfer, it delivers that
 * on the first connection and nothing on any connection after.
 */
class UnchangingRequester implements Requester {
  connections = 0;

  constructor(private readonly firstTransfer: WireEvent[] = []) {}

  poll(): Promise<PollResult> {
    throw new Error('not a polling double');
  }

  async stream(): Promise<AsyncIterable<[string, unknown]>> {
    this.connections += 1;
    const transfer =
      this.connections === 1 && this.firstTransfer.length > 0
        ? this.firstTransfer
        : events(['server-intent', serverIntent('none')]);
    const scripted = asPairs([
      ...transfer,
      ...events(['goodbye', { reason: 'server recycle', silent: true, catastrophe: false }]),
    ]);
    return (async function* () {
      yield* scripted;
    })();
  }
}

/**
 * A server that says goodbye and nothing else: every connection is closed with
 * a silent, non-catastrophic goodbye, without a `server-intent` ever arriving.
 * Indistinguishable from a recycle at the event level, but nothing was ever
 * served, so reconnecting cannot make progress.
 */
class GoodbyeOnlyRequester implements Requester {
  connections = 0;

  poll(): Promise<PollResult> {
    throw new Error('not a polling double');
  }

  async stream(): Promise<AsyncIterable<[string, unknown]>> {
    this.connections += 1;
    const scripted = asPairs(events(['goodbye', { reason: 'recycling', silent: true }]));
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
    const started = Date.now();
    // `false`, and promptly: a caller gating boot on the return value must not
    // be told a payload arrived, nor be left to sit out the whole timeout.
    expect(await store.waitForSkills(5000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(store.failed).not.toBeNull();
  });

  it('resolves waitForSkills false immediately once delivery has given up', async () => {
    endpoint.queuePoll([], { status: 401 });
    const store = pollStore();
    store.start();
    expect(await waitUntil(() => store.failed !== null)).toBe(true);
    const started = Date.now();
    expect(await store.waitForSkills(5000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
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

  it('does not count an up-to-date connection against the retry bound', async () => {
    // An environment whose skills never change is answered with the `none`
    // intent and then recycled, so nothing ever commits. Clearing the failure
    // row only at a commit would give up on this healthy server after
    // maxConsecutiveFailures + 1 recycles, and no later revocation would ever
    // be delivered.
    const requester = new UnchangingRequester();
    const store = scriptedStreamStore(requester, { maxConsecutiveFailures: 3 });
    store.start();
    // A bound well inside the test timeout, so a loop that gave up fails here
    // rather than by running out of time: each recycle costs a 1ms backoff.
    expect(await waitUntil(() => requester.connections >= 8, 2000)).toBe(true);
    expect(store.failed).toBeNull();
    expect(store.diagnostics.connectionFailures).toBe(0);
    expect(store.diagnostics.lastError).toBeNull();
  });

  it('keeps delivering after more recycles than the retry bound tolerates', async () => {
    // The same server, but with a payload transferred first: the content it
    // delivered has to survive the recycles, and delivery has to still be live
    // afterwards rather than quietly given up on.
    const requester = new UnchangingRequester(fullPayload([['put-object', putSkill()]], 'basis-1'));
    const store = scriptedStreamStore(requester, { maxConsecutiveFailures: 3 });
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    expect(await waitUntil(() => requester.connections >= 6, 2000)).toBe(true);
    expect(store.failed).toBeNull();
    expect(store.diagnostics.connectionFailures).toBe(0);
    expect(store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction')).not.toBeNull();
  });

  it('bounds a server that only ever says goodbye', async () => {
    // A goodbye is exempt from the retry bound because it is how a healthy
    // stream is recycled — but a connection that says goodbye without ever
    // sending a `server-intent` served nothing. Exempting that too would
    // reconnect without limit, and without `failed` or the diagnostics ever
    // saying so.
    const requester = new GoodbyeOnlyRequester();
    const store = scriptedStreamStore(requester, { maxConsecutiveFailures: 3 });
    store.start();
    expect(await waitUntil(() => store.failed !== null, 2000)).toBe(true);
    expect(store.failed).toContain('gave up after 4 consecutive failures');
    expect(store.failed).toContain('server said goodbye: recycling');
    expect(requester.connections).toBe(4);
    expect(store.diagnostics.connectionFailures).toBe(4);
    expect(store.diagnostics.lastError).not.toBeNull();
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

  it('gives up on a server that announces a transfer and drops before committing, every time (§3.25)', async () => {
    // An `xfer-full` intent is a promise, not a delivery. A server that sends
    // one and drops before `payload-transferred` has delivered nothing, and a
    // store that counted the announcement as health would retry it forever at
    // the initial backoff. Only a committed payload or a `none` intent resets
    // the row of failures.
    const outcomes: unknown[] = [];
    for (let i = 0; i < 10; i += 1) {
      outcomes.push(asPairs(events(['server-intent', serverIntent('xfer-full')], ['put-object', putSkill()])));
    }
    const requester = new ScriptedRequester(outcomes);
    const store = scriptedStreamStore(requester, { maxConsecutiveFailures: 3 });
    store.start();
    expect(await waitUntil(() => store.failed !== null, 5000)).toBe(true);
    expect(store.failed).toContain('gave up after 4 consecutive failures');
    expect(requester.calls).toHaveLength(4);
    expect(store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction')).toBeNull();
  });

  it('honours a Retry-After header off the wire', async () => {
    endpoint.queuePoll([], { status: 429, retryAfter: '1' });
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    // A one-second request sitting between a 20ms backoff and a 5s cap, so the
    // wait that follows can only have come from the header.
    const store = pollStore({ initialBackoffMs: 20, maxBackoffMs: 5000 });
    const started = Date.now();
    store.start();
    expect(await store.waitForSkills(4000)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('does not treat a blank Retry-After as no delay at all', async () => {
    // `Number('')` is 0 and finite, so a header a proxy sent empty would win
    // over the backoff and reconnect with no wait — burning every retry the
    // bound allows in a few milliseconds and going permanently fatal.
    for (let i = 0; i < 5; i += 1) endpoint.queuePoll([], { status: 503, retryAfter: '' });
    const store = pollStore({ initialBackoffMs: 100, maxBackoffMs: 100, maxConsecutiveFailures: 3 });
    const started = Date.now();
    store.start();
    expect(await waitUntil(() => store.failed !== null, 4000)).toBe(true);
    // Three backoffs before the fourth failure gives up. Jitter can halve each,
    // so 120ms is the floor; collapsed, the whole run lands in single digits.
    expect(Date.now() - started).toBeGreaterThanOrEqual(120);
  });

  it('floors an honoured Retry-After at initialBackoffMs', async () => {
    // `Retry-After: 0` is legal and means "try again now". Taken literally it
    // is a busy loop against the retry bound, so it is honoured as the shortest
    // delay the store was configured to wait.
    const requester = new ScriptedRequester([
      new RecoverableTransportError('slow down', 0),
      asPairs(fullPayload([['put-object', putSkill()]])),
    ]);
    const store = new FDv2SkillStore(SDK_KEY, {
      mode: 'poll',
      pollIntervalMs: 10_000,
      initialBackoffMs: 200,
      maxBackoffMs: 5_000,
      requester,
    });
    openStores.push(store);
    const started = Date.now();
    store.start();
    expect(await store.waitForSkills(3000)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });

  it('recovers from a 400 by dropping the basis and asking again', async () => {
    // The request carries the SDK key, a `basis` selector and an etag. A
    // selector the server has stopped accepting is rejected as a 400, and
    // treating that as permanently fatal would stop delivery for the process
    // lifetime over state the store could simply drop.
    endpoint.queuePoll(fullPayload([['put-object', putSkill('first')]], 'basis-1'), { etag: 'etag-1' });
    endpoint.queuePoll([], { status: 400 });
    endpoint.queuePoll(fullPayload([['put-object', putSkill('second')]], 'basis-2'));
    const store = pollStore();
    store.start();
    expect(await waitUntil(() => store.getObject(SKILL_OBJECT_KIND, 'second') !== null)).toBe(true);
    expect(store.failed).toBeNull();
    // The retry asks from scratch: no selector, and no etag that would let the
    // server answer 304 for a basis it just rejected.
    const retry = endpoint.requests[2];
    expect(retry.query.basis).toBeUndefined();
    expect(retry.ifNoneMatch).toBeUndefined();
  });

  it('asks from scratch after a 400 even on a budget an outage has spent', async () => {
    // The one repair available does not compete with the retry bound. A 400
    // arriving on a spent budget would otherwise give up while holding the one
    // request known to fix it, and delivery would stop for the process lifetime
    // over state the store was about to drop.
    endpoint.queuePoll(fullPayload([['put-object', putSkill('first')]], 'basis-1'), { etag: 'etag-1' });
    endpoint.queuePoll([], { status: 500 });
    endpoint.queuePoll([], { status: 400 });
    endpoint.queuePoll(fullPayload([['put-object', putSkill('second')]], 'basis-2'));
    const store = pollStore({ maxConsecutiveFailures: 1 });
    store.start();
    expect(await waitUntil(() => store.getObject(SKILL_OBJECT_KIND, 'second') !== null)).toBe(true);
    expect(store.failed).toBeNull();
    // The repair went out from scratch rather than never going out at all.
    const repair = endpoint.requests[3];
    expect(repair.query.basis).toBeUndefined();
    expect(repair.ifNoneMatch).toBeUndefined();
  });

  it('meets the spent budget on a non-400 after the repair', async () => {
    // The exemption is for the repair, not for the run that follows it.
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]], 'basis-1'));
    endpoint.queuePoll([], { status: 500 });
    endpoint.queuePoll([], { status: 400 });
    endpoint.queuePoll([], { status: 500 });
    const store = pollStore({ maxConsecutiveFailures: 1 });
    store.start();
    expect(await waitUntil(() => store.failed !== null)).toBe(true);
    expect(store.failed).toContain('gave up after 3 consecutive failures');
    expect(endpoint.requests).toHaveLength(4);
  });

  it('stops on a 400 for a request that carried no basis', async () => {
    // Nothing left to drop: the request was already the from-scratch one, so
    // the endpoint is refusing the request itself.
    endpoint.queuePoll([], { status: 400 });
    const store = pollStore();
    store.start();
    expect(await waitUntil(() => store.failed !== null)).toBe(true);
    expect(store.failed).toContain('400');
    expect(store.failed).toContain('base URI');
    expect(store.failed).toContain('FDv2');
    expect(endpoint.requests).toHaveLength(1);
  });

  it('stops on a second 400 after the basis has been dropped', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]], 'basis-1'));
    endpoint.queuePoll([], { status: 400 });
    endpoint.queuePoll([], { status: 400 });
    const store = pollStore();
    store.start();
    expect(await waitUntil(() => store.failed !== null)).toBe(true);
    expect(store.failed).toContain('400');
    expect(endpoint.requests).toHaveLength(3);
    // The content the first transfer delivered is still servable.
    expect(store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction')).not.toBeNull();
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
    // A blank value is absent, not zero.
    expect(retryAfterMs(new Headers({ 'Retry-After': '' }))).toBeNull();
    expect(retryAfterMs(new Headers({ 'Retry-After': '   ' }))).toBeNull();
    expect(retryAfterMs(new Headers({ 'Retry-After': '0' }))).toBe(0);
  });

  it('classifies statuses into recoverable and fatal', () => {
    expect(classifyStatus(500).constructor.name).toBe('RecoverableTransportError');
    expect(classifyStatus(429).constructor.name).toBe('RecoverableTransportError');
    expect(classifyStatus(401).constructor.name).toBe('FatalTransportError');
    expect(classifyStatus(403).constructor.name).toBe('FatalTransportError');
    expect(classifyStatus(404).constructor.name).toBe('FatalTransportError');
    expect(classifyStatus(405).constructor.name).toBe('FatalTransportError');
    // A 400 may be the selector the request carried rather than the request
    // itself, so it is retried once from scratch before it is fatal.
    expect(classifyStatus(400)).toBeInstanceOf(StaleRequestStateError);
    expect(classifyStatus(400)).toBeInstanceOf(RecoverableTransportError);
    expect(classifyStatus(400).message).toContain('base URI');
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

  const hashlessSummaries = (): string[] =>
    consoleErrors()
      .split('\n')
      .filter((line) => line.includes('No skill content will resolve'));

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

  it('leaves the copy on disk alone when a hashless payload replaces a good one', async () => {
    // The whole point of withholding, asserted through the reconcile rather than
    // through the accessors — and the case the hash gap makes universal, since
    // today *every* object arrives hashless. `writeSkills('*')` derives its prune
    // keep-set from the keys `allObjects` is keyed by, so a key it cannot parse
    // as a skill key drops out of the keep-set and prune deletes the last
    // known-good copy. Which is the outcome this transport was written to avoid.
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    endpoint.queuePoll(
      fullPayload([['put-object', putSkill('pdf-extraction', { objectVersion: 4, omitHash: true })]], 'basis-2'),
    );
    endpoint.queuePoll([], { status: 304 });

    const store = pollStore({ pollIntervalMs: 20 });
    store.start();
    await store.waitForSkills(5000);
    _setStore(store);

    const root = path.join(await scratchRoot(), 'skills');
    const written = path.join(root, 'pdf-extraction', 'SKILL.md');
    await writeSkills('*', root);
    expect(readFileSync(written, 'utf8')).toBe(SKILL_BODY);

    expect(await waitUntil(() => store.diagnostics.hashlessObjects > 0, 5000)).toBe(true);
    const report = await writeSkills('*', root);

    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf8')).toBe(SKILL_BODY);
    expect(report.actions.some((action) => action.action === 'removed')).toBe(false);
    // Reported against the skill's own key, so the failure names the skill.
    expect(report.actions.some((action) => action.action === 'error' && action.key === 'pdf-extraction')).toBe(true);
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
    const summaries = hashlessSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain('All 2 skill object(s)');
  });

  it('does not repeat the summary for a store that has not moved', () => {
    // `contentHash` is not on the wire yet, so a server answering `xfer-changes`
    // rather than `xfer-none` re-delivers the same hashless payload on every
    // poll. One problem is one paragraph, not one per interval.
    const reader = new ProtocolReader(new SkillObjectSet());
    const payload = fullPayload([
      ['put-object', putSkill('a', { omitHash: true })],
      ['put-object', putSkill('b', { omitHash: true })],
    ]);
    drive(reader, payload);
    drive(reader, payload);
    drive(reader, payload);
    expect(hashlessSummaries()).toHaveLength(1);
  });

  it('speaks again when the hashless objects change', () => {
    // A different set of withheld skills is a different problem.
    const reader = new ProtocolReader(new SkillObjectSet());
    drive(reader, fullPayload([['put-object', putSkill('a', { omitHash: true })]]));
    drive(reader, fullPayload([['put-object', putSkill('b', { omitHash: true })]], 'basis-2'));
    expect(hashlessSummaries()).toHaveLength(2);
  });

  it('speaks again about a relapse after a recovery', () => {
    const reader = new ProtocolReader(new SkillObjectSet());
    const broken = fullPayload([['put-object', putSkill('a', { omitHash: true })]]);
    drive(reader, broken);
    drive(reader, fullPayload([['put-object', putSkill('a')]], 'basis-2'));
    drive(reader, broken);
    expect(hashlessSummaries()).toHaveLength(2);
  });

  it('bounds what it remembers about hashless objects', () => {
    // One entry per `(key, version)` for the life of the process would leak
    // slowly in an agent whose skills are versioned often.
    const reader = new ProtocolReader(new SkillObjectSet());
    for (let version = 1; version <= 600; version += 1) {
      drive(
        reader,
        fullPayload(
          [['put-object', putSkill('pdf-extraction', { objectVersion: version, omitHash: true })]],
          'basis-1',
        ),
      );
    }
    expect(reader._warnedHashless.size).toBeLessThan(600);
  });

  it('forgets what it remembers once everything held verifies', () => {
    const reader = new ProtocolReader(new SkillObjectSet());
    drive(reader, fullPayload([['put-object', putSkill('a', { omitHash: true })]]));
    expect(reader._warnedHashless.size).toBeGreaterThan(0);
    drive(reader, fullPayload([['put-object', putSkill('a')]], 'basis-2'));
    expect(reader._warnedHashless.size).toBe(0);
  });

  it('remembers per reader, so two stores in one process do not cross-talk', () => {
    // The dedupe memory is held by the reader, not the module: a second store
    // in the same process reporting the same hashless object is a second
    // deployment problem, and must be told about it.
    const first = new ProtocolReader(new SkillObjectSet());
    drive(first, fullPayload([['put-object', putSkill('a', { omitHash: true })]]));
    const before = errorSpy.mock.calls.length;
    const second = new ProtocolReader(new SkillObjectSet());
    drive(second, fullPayload([['put-object', putSkill('a', { omitHash: true })]]));
    expect(errorSpy.mock.calls.length).toBeGreaterThan(before);
    expect(first._warnedHashless).not.toBe(second._warnedHashless);
  });

  it('still reports each hashless object in a payload separately', () => {
    // The per-object dedupe the bound and the summary must not disturb.
    const reader = new ProtocolReader(new SkillObjectSet());
    drive(
      reader,
      fullPayload([
        ['put-object', putSkill('a', { omitHash: true })],
        ['put-object', putSkill('b', { omitHash: true })],
      ]),
    );
    const perObject = consoleErrors()
      .split('\n')
      .filter((line) => line.includes('arrived without a contentHash and will be withheld'));
    expect(perObject).toHaveLength(2);
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
    // The store's change listener drives the reconcile, so the file goes away
    // seconds after the delete-object rather than at the next process start.
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

  it('coalesces a burst of changes into exactly one reconcile', async () => {
    // Three things make this test either evidence or theatre, and all three have
    // to be right:
    //
    // 1. **The burst has to arrive after the watcher registers.** A payload
    //    committed before `watchSkills` attaches its listener notifies nobody,
    //    so the reconcile counter never leaves zero — and an upper bound
    //    (`<= 2`) then passes against an implementation with the debouncing
    //    deleted. So the seed payload is what boot waits for, and the burst is
    //    queued only once the watcher is up.
    // 2. **The assertion has to be an equality, and it has to see movement.**
    //    Exactly one more reconcile than the initial one, and the counter has to
    //    have advanced at all; a run in which it stays at zero is not testing
    //    coalescing.
    // 3. **The notifications have to be spread over time.** This one is not in
    //    the spec and it is what actually makes the test discriminate, verified
    //    by mutation: `SkillWatcher.schedule` also has a `pending` flag, so a
    //    burst that arrives in *one synchronous run* of the listener collapses
    //    to a single reconcile whether or not the debounce exists. Twelve
    //    objects in one commit are therefore not enough. Three commits arriving
    //    a poll apart are: each one lands after the previous reconcile would
    //    already have started and cleared `pending`, so only the debounce window
    //    can merge them.
    endpoint.queuePoll(fullPayload([['put-object', putSkill('seed')]]));
    const store = pollStore({ pollIntervalMs: 20 });
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    _setStore(store);

    const root = path.join(await scratchRoot(), 'skills');
    // Comfortably longer than the three commits take to arrive at a 20 ms poll
    // interval — with enough margin that a loaded CI runner cannot push the
    // third commit out of the window and turn a correct implementation red.
    const { watcher } = await watchSkills('*', root, { debounceMs: 1000 });
    try {
      // The initial reconcile is the caller's own result and is excluded from
      // the counter, so this is the baseline the equality is measured against.
      expect(watcher.reconciles).toBe(0);

      // Twelve objects across three commits. Twelve, because a commit notifies
      // once per *changed object* rather than once per commit (§3.25) — which is
      // why the debounce exists at all rather than being a refinement of a
      // per-commit notification.
      for (let commit = 0; commit < 3; commit += 1) {
        endpoint.queuePoll(
          events(
            ['server-intent', serverIntent('xfer-changes')],
            ...Array.from(
              { length: 4 },
              (_, i) => ['put-object', putSkill(`skill-${commit}-${i}`)] as [string, unknown],
            ),
            ['payload-transferred', transferred(`basis-${commit + 2}`)],
          ),
        );
      }

      // The endpoint really served the changes rather than a steady 304 for the
      // duration — the other way this test goes vacuous. Asserted on the store's
      // own counters, so "nothing was delivered" cannot read as "delivery was
      // coalesced".
      expect(await waitUntil(() => store.diagnostics.skillObjectsReceived >= 13, 10_000)).toBe(true);
      expect(store.diagnostics.payloadsTransferred).toBeGreaterThanOrEqual(4);

      // The counter moved...
      expect(await waitUntil(() => watcher.reconciles > 0, 10_000)).toBe(true);
      // ...and then settled at exactly one. Waited out past a further whole
      // window, so a second reconcile would have landed by now.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(watcher.reconciles).toBe(1);
      // And the one reconcile saw the settled state — the last commit's objects
      // included — rather than a half-applied burst.
      expect(await readFile(path.join(root, 'skill-2-3', 'SKILL.md'), 'utf8')).toBe(SKILL_BODY);
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

  it('prunes when a full transfer drops every skill', async () => {
    // A full transfer revokes by omission, so this payload carries no
    // `delete-object` at all. The commit still has to wake the watcher, or the
    // revoked file sits on disk until the process restarts.
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    endpoint.queuePoll(
      events(['server-intent', serverIntent('xfer-full')], ['payload-transferred', transferred('basis-2')]),
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
      expect(readFileSync(written, 'utf8')).toBe(SKILL_BODY);
      expect(await waitUntil(() => !existsSync(written), 10_000)).toBe(true);
    } finally {
      await watcher.close();
    }
  });

  it('reconciles again for a change that commits during the initial write', async () => {
    // The listener is registered before the initial reconcile, so a payload that
    // commits while that reconcile is doing its filesystem I/O is not lost. The
    // fake store fires its listener from inside `allObjects` — that is, from
    // inside the initial reconcile — and answers with the set as it was, so the
    // second version only reaches disk if the watcher heard about it.
    const verified = (content: string): RawSkillObject => ({
      key: 'a',
      version: 1,
      content,
      contentHash: hash(content),
    });

    let fire: (() => void) | null = null;
    let objects: Record<string, RawSkillObject> = { a: verified('first') };
    let fired = false;
    _setStore({
      getObject: (_kind: string, key: string) => objects[key] ?? null,
      allObjects: () => {
        const current = objects;
        if (!fired && fire) {
          fired = true;
          objects = { a: verified('second') };
          fire();
        }
        return current;
      },
      addListener: (_kind: string, fn: () => void) => {
        fire = fn;
      },
      removeListener: () => {
        fire = null;
      },
    });

    const root = path.join(await scratchRoot(), 'skills');
    const { report, watcher } = await watchSkills('*', root, { debounceMs: 10 });
    try {
      expect(fired).toBe(true);
      expect(report.actions.some((action) => action.action === 'written')).toBe(true);
      const written = path.join(root, 'a', 'SKILL.md');
      expect(await waitUntil(() => readFileSync(written, 'utf8') === 'second', 5000)).toBe(true);
    } finally {
      await watcher.close();
    }
  });

  it('returns a named object, not a tuple, and takes its debounce in milliseconds', async () => {
    // A.12 fixes both, and both are places a port from Python goes wrong
    // silently: destructuring `[report, watcher]` off an object yields
    // `undefined`s, and passing Python's seconds value to `debounceMs` sets a
    // 0.5 ms window that looks like a timing bug rather than a unit bug.
    const store = new InMemorySkillStore();
    store.put({ key: 'a', version: 1, content: 'body', contentHash: hash('body') });
    _setStore(store);

    const result = await watchSkills('*', path.join(await scratchRoot(), 'skills'), {
      // Milliseconds. A whole second here, so the assertion below cannot be
      // satisfied by a window that has already elapsed.
      debounceMs: 1000,
    });
    try {
      expect(Object.keys(result).sort()).toEqual(['report', 'watcher']);
      expect(Array.isArray(result)).toBe(false);
      expect(result.report.actions.some((action) => action.action === 'written')).toBe(true);
      expect(result.watcher).toBeInstanceOf(SkillWatcher);

      // The unit, observably: a change notified now has not reconciled a
      // quarter of a second later, because the window is 1000 ms and not 1.
      store.put({ key: 'a', version: 2, content: 'new body', contentHash: hash('new body') });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(result.watcher.reconciles).toBe(0);
    } finally {
      await result.watcher.close();
    }
  });

  it('rejects a negative debounce and a non-finite one', async () => {
    // `NaN` is the case a `< 0` guard misses — `NaN < 0` is false — and it is
    // not benign: `setTimeout(fn, NaN)` fires at 1 ms, collapsing the window so
    // that every delivered object reconciles and nothing coalesces at all. So
    // the guard has to reject it the way `writeSkills` already rejects a
    // non-numeric `timeout`.
    const store = new InMemorySkillStore();
    _setStore(store);
    const root = path.join(await scratchRoot(), 'skills');
    const listeners = (): unknown[] =>
      (store as unknown as { listeners: Map<string, unknown[]> }).listeners.get(SKILL_OBJECT_KIND) ?? [];

    for (const debounceMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(watchSkills('*', root, { debounceMs })).rejects.toThrow(/debounceMs/);
    }
    // Refused before anything was registered or written: the validation runs
    // ahead of the listener and ahead of the initial reconcile.
    expect(listeners()).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  it('calls onReconcile for a delivery-triggered reconcile and not for the initial one', async () => {
    // The initial report is returned directly, so delivering it through the
    // callback as well would make a caller handle the same reconcile twice.
    const store = new InMemorySkillStore();
    store.put({ key: 'a', version: 1, content: 'first', contentHash: hash('first') });
    _setStore(store);

    const seen: ReconcileReport[] = [];
    const root = path.join(await scratchRoot(), 'skills');
    const { report, watcher } = await watchSkills('*', root, {
      debounceMs: 20,
      onReconcile: (each) => {
        seen.push(each);
      },
    });
    try {
      // The initial reconcile did happen — it wrote the file — and it did not
      // reach the callback.
      expect(report.actions.some((action) => action.action === 'written')).toBe(true);
      expect(await readFile(path.join(root, 'a', 'SKILL.md'), 'utf8')).toBe('first');
      expect(seen).toEqual([]);

      store.put({ key: 'a', version: 2, content: 'second', contentHash: hash('second') });

      expect(await waitUntil(() => seen.length > 0, 10_000)).toBe(true);
      expect(seen).toHaveLength(1);
      // A real report for the re-reconcile, not the initial one handed over a
      // second time.
      expect(seen[0]).not.toBe(report);
      expect(seen[0].actions.map((action) => [action.key, action.action])).toContainEqual(['a', 'updated']);
      expect(seen[0].ok).toBe(true);
    } finally {
      await watcher.close();
    }
  });

  it('survives a reconcile that throws — the next notification still reconciles', async () => {
    // A watcher that died on one bad run would silently stop pruning, which is
    // strictly worse than a noisy one: revocations would keep arriving and
    // nothing would act on them, and the process would look healthy.
    //
    // `onUnavailable: 'raise'` against a store that throws is the shortest real
    // path to a *throwing* reconcile — every ordinary failure is reported as an
    // `error` action instead.
    const body = (content: string): RawSkillObject => ({
      key: 'a',
      version: 1,
      content,
      contentHash: hash(content),
    });
    let explode = false;
    let notify: (() => void) | null = null;
    _setStore({
      getObject: () => {
        if (explode) throw new Error('transport failure');
        return body('first');
      },
      allObjects: () => ({ 'a:1': body('first') }),
      addListener: (_kind: string, fn: () => void) => {
        notify = fn;
      },
      removeListener: () => {
        notify = null;
      },
    });

    const root = path.join(await scratchRoot(), 'skills');
    const { watcher } = await watchSkills([{ key: 'a', version: 1 }], root, {
      debounceMs: 10,
      onUnavailable: 'raise',
    });
    try {
      expect(await readFile(path.join(root, 'a', 'SKILL.md'), 'utf8')).toBe('first');
      expect(notify).not.toBeNull();

      explode = true;
      (notify as unknown as () => void)();

      // The failure is visible rather than swallowed, and the watcher says so.
      expect(await waitUntil(() => /the watcher continues/.test(consoleErrors()), 10_000)).toBe(true);
      // The throwing run does not count as a completed reconcile.
      expect(watcher.reconciles).toBe(0);

      explode = false;
      (notify as unknown as () => void)();

      expect(await waitUntil(() => watcher.reconciles > 0, 10_000)).toBe(true);
    } finally {
      await watcher.close();
    }
  });

  it('raises an invalid root out of watchSkills rather than inside a worker', async () => {
    // The initial reconcile runs on the caller's thread precisely so this is a
    // rejected promise the caller can catch, exactly as `writeSkills` would give
    // them — not a line in a background task's log that a caller cannot see and
    // cannot react to.
    const store = new InMemorySkillStore();
    _setStore(store);
    const scratch = await scratchRoot();

    // A root whose parent does not exist: never created recursively (§3.22).
    await expect(watchSkills('*', path.join(scratch, 'a', 'b', 'c'))).rejects.toThrow();
    // And a root that is a file rather than a directory.
    const file = path.join(scratch, 'file');
    await writeFile(file, '', 'utf8');
    await expect(watchSkills('*', file)).rejects.toThrow();

    // Nothing was logged instead of thrown — the failure travelled one way only.
    expect(consoleErrors()).toBe('');
  });

  it('leaves no listener behind when the initial reconcile fails', async () => {
    // The listener is registered *before* the initial reconcile so a payload
    // committing during its filesystem I/O is not lost — which means a reconcile
    // that throws has to detach on the way out. The caller is handed an
    // exception, not a watcher to close, so nothing else can.
    const store = new InMemorySkillStore();
    _setStore(store);
    const listeners = (): unknown[] =>
      (store as unknown as { listeners: Map<string, unknown[]> }).listeners.get(SKILL_OBJECT_KIND) ?? [];
    const notADirectory = path.join(await scratchRoot(), 'file');
    await writeFile(notADirectory, '', 'utf8');

    await expect(watchSkills('*', notADirectory)).rejects.toThrow();

    expect(listeners()).toEqual([]);
    // And the store holding no reference to it is the observable that matters: a
    // later change must not reach a watcher nobody can close.
    store.put({ key: 'a', version: 1, content: 'body', contentHash: hash('body') });
    expect(listeners()).toEqual([]);
  });

  it('refuses a store with no addListener, loudly', async () => {
    _setStore({
      getObject: () => null,
      allObjects: () => ({}),
    });
    // The message names both remedies: the one-shot reconcile, and the store
    // that does implement the listener half of the seam.
    await expect(watchSkills('*', await scratchRoot())).rejects.toThrow(/writeSkills[\s\S]*FDv2SkillStore/);
  });

  it('passes prune and timeout straight through to writeSkills (§3.26)', async () => {
    // Driven behaviourally rather than by spying on the import: a `prune: false`
    // that reached `writeSkills` leaves a stale managed skill alone on the
    // initial reconcile *and* on a re-reconcile, and a `timeout: 0` that reached
    // it exhausts before retrieval — both are §3.22 outcomes only `writeSkills`
    // produces.
    const seed = new InMemorySkillStore();
    seed.put({ key: 'a', version: 1, content: 'first', contentHash: hash('first') });
    seed.put({ key: 'stale', version: 1, content: 'old', contentHash: hash('old') });
    _setStore(seed);
    const root = path.join(await scratchRoot(), 'skills');
    expect((await writeSkills('*', root)).ok).toBe(true);
    // Now a store that no longer holds `stale`: with pruning on it would be removed.
    const store = new InMemorySkillStore();
    store.put({ key: 'a', version: 1, content: 'first', contentHash: hash('first') });
    _setStore(store);

    const { report, watcher } = await watchSkills('*', root, { debounceMs: 10, prune: false });
    try {
      expect(report.ok).toBe(true);
      expect(report.actions.some((a) => a.action === 'removed')).toBe(false);
      expect(await readFile(path.join(root, 'stale', 'SKILL.md'), 'utf8')).toBe('old');

      store.put({ key: 'a', version: 2, content: 'second', contentHash: hash('second') });
      expect(await waitUntil(() => watcher.reconciles === 1, 10_000)).toBe(true);
      expect(await readFile(path.join(root, 'stale', 'SKILL.md'), 'utf8')).toBe('old');
    } finally {
      await watcher.close();
    }

    const timed = await watchSkills([{ key: 'a', version: 2 }], root, { debounceMs: 10, timeout: 0 });
    try {
      expect(timed.report.ok).toBe(false);
      expect(timed.report.errors.map((a) => a.error).join('\n')).toMatch(/timeout was exhausted/);
    } finally {
      await timed.watcher.close();
    }
  });

  it('close() survives a store whose removeListener throws, and stays closed', async () => {
    // Detaching is best effort: a store that cannot detach must not leave the
    // watcher half-closed with its timer armed, and a second close is a no-op.
    let notify: (() => void) | null = null;
    _setStore({
      getObject: () => null,
      allObjects: () => ({}),
      addListener: (_kind: string, fn: () => void) => {
        notify = fn;
      },
      removeListener: () => {
        throw new Error('cannot detach');
      },
    });
    const { watcher } = await watchSkills('*', path.join(await scratchRoot(), 'skills'), { debounceMs: 10 });
    await watcher.close();
    expect(consoleErrors()).toContain('cannot detach');
    const errorsAfterClose = errorSpy.mock.calls.length;
    await watcher.close();
    expect(errorSpy.mock.calls.length).toBe(errorsAfterClose);
    // Closed: a notification that still reaches it schedules nothing.
    (notify as unknown as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(watcher.reconciles).toBe(0);
  });

  it('logs an async onReconcile that rejects, and the next commit still reconciles', async () => {
    // `onReconcile` may be async. A rejection must be caught and logged like a
    // synchronous throw — not left as an unhandled rejection — and must not
    // stop the watcher.
    const store = new InMemorySkillStore();
    store.put({ key: 'a', version: 1, content: 'first', contentHash: hash('first') });
    _setStore(store);
    let calls = 0;
    const root = path.join(await scratchRoot(), 'skills');
    const { watcher } = await watchSkills('*', root, {
      debounceMs: 10,
      onReconcile: async () => {
        calls += 1;
        if (calls === 1) throw new Error('async callback exploded');
      },
    });
    try {
      store.put({ key: 'a', version: 2, content: 'second', contentHash: hash('second') });
      expect(await waitUntil(() => /async callback exploded/.test(consoleErrors()), 10_000)).toBe(true);
      expect(consoleErrors()).toContain('callback threw');
      store.put({ key: 'a', version: 3, content: 'third', contentHash: hash('third') });
      expect(await waitUntil(() => watcher.reconciles === 2, 10_000)).toBe(true);
      expect(calls).toBe(2);
      expect(await readFile(path.join(root, 'a', 'SKILL.md'), 'utf8')).toBe('third');
    } finally {
      await watcher.close();
    }
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

  it('detaches from the store on close, so a closed watcher is no longer notified', async () => {
    const store = new InMemorySkillStore();
    store.put({ key: 'a', version: 1, content: 'first', contentHash: hash('first') });
    _setStore(store);
    const listeners = (): unknown[] =>
      (store as unknown as { listeners: Map<string, unknown[]> }).listeners.get(SKILL_OBJECT_KIND) ?? [];

    const root = path.join(await scratchRoot(), 'skills');
    const { watcher } = await watchSkills('*', root, { debounceMs: 20 });
    expect(listeners()).toContain(watcher.notify);

    await watcher.close();

    expect(listeners()).not.toContain(watcher.notify);
    store.put({ key: 'a', version: 4, content: 'second', contentHash: hash('second') });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await readFile(path.join(root, 'a', 'SKILL.md'), 'utf8')).toBe('first');
    expect(watcher.reconciles).toBe(0);
  });

  it('leaves no listeners behind across repeated watchers', async () => {
    const store = new InMemorySkillStore();
    _setStore(store);
    const listeners = (): unknown[] =>
      (store as unknown as { listeners: Map<string, unknown[]> }).listeners.get(SKILL_OBJECT_KIND) ?? [];
    const root = path.join(await scratchRoot(), 'skills');
    for (let i = 0; i < 5; i += 1) {
      const { watcher } = await watchSkills('*', root, { debounceMs: 20 });
      expect(listeners()).toHaveLength(1);
      await watcher.close();
    }
    expect(listeners()).toEqual([]);
  });

  it('still closes against a store with no removeListener', async () => {
    // `removeListener` is optional: an older store keeps working, at the cost
    // of the listener staying registered.
    const registered: unknown[] = [];
    _setStore({
      getObject: () => null,
      allObjects: () => ({}),
      addListener: (_kind, fn) => {
        registered.push(fn);
      },
    });
    const { watcher } = await watchSkills('*', path.join(await scratchRoot(), 'skills'), { debounceMs: 20 });
    expect(registered).toEqual([watcher.notify]);
    await watcher.close();
    await watcher.close();
    expect(registered).toEqual([watcher.notify]);
  });

  it('treats removing an unregistered listener from the FDv2 store as a no-op', () => {
    const store = pollStore();
    const fn = (): void => {};
    store.removeListener(SKILL_OBJECT_KIND, fn);
    store.addListener(SKILL_OBJECT_KIND, fn);
    store.removeListener('flag', fn);
    store.removeListener(SKILL_OBJECT_KIND, fn);
    store.removeListener(SKILL_OBJECT_KIND, fn);
    const listeners = (store as unknown as { listeners: Map<string, unknown[]> }).listeners;
    expect(listeners.get(SKILL_OBJECT_KIND)).toEqual([]);
  });

  it('refuses a listener for a kind the FDv2 store cannot notify', () => {
    const store = pollStore();
    expect(() => store.addListener('flag', vi.fn())).toThrow(/never fire/);
    expect(() => store.addListener('segment', vi.fn())).toThrow(/never fire/);
  });

  it('retains no listener it refused, so nothing is left to leak', () => {
    const store = pollStore();
    expect(() => store.addListener('flag', vi.fn())).toThrow();
    const listeners = (store as unknown as { listeners: Map<string, unknown[]> }).listeners;
    expect(listeners.has('flag')).toBe(false);
  });

  it('still lets a refused listener be detached unconditionally', async () => {
    // `SkillWatcher.close` removes without knowing whether the add succeeded.
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    const store = pollStore();
    const fn = vi.fn();
    expect(() => store.addListener('flag', fn)).toThrow();
    expect(() => store.removeListener('flag', fn)).not.toThrow();
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    expect(fn).not.toHaveBeenCalled();
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

  it('isInitialized tracks the first payload, and stays true after close (§3.25)', async () => {
    // The probe `writeSkills('*')` reads to decide whether it may prune. Before
    // the first payload, an empty store and an environment with no skills are
    // the same answer through `allObjects`; this is what tells them apart.
    const silent = new FDv2SkillStore(SDK_KEY, {
      mode: 'poll',
      pollIntervalMs: 60_000,
      requester: new ScriptedRequester([new Promise(() => {})]),
    });
    openStores.push(silent);
    expect(silent.isInitialized()).toBe(false);
    silent.start();
    expect(await silent.waitForSkills(50)).toBe(false);
    expect(silent.isInitialized()).toBe(false);

    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    const delivering = pollStore();
    delivering.start();
    expect(await delivering.waitForSkills(5000)).toBe(true);
    expect(delivering.isInitialized()).toBe(true);
    await delivering.close();
    // Content outlives the connection, so the fact about it does too.
    expect(delivering.isInitialized()).toBe(true);
  });

  it('a 304 counts as initialized — the payload held is confirmed current', async () => {
    endpoint.queuePoll([], { status: 304 });
    const store = pollStore();
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    expect(store.isInitialized()).toBe(true);
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

  it('retains no waiter for a wait that timed out', async () => {
    const store = new FDv2SkillStore(SDK_KEY, {
      mode: 'poll',
      pollIntervalMs: 60_000,
      requester: new ScriptedRequester([new Promise(() => {})]),
    });
    openStores.push(store);
    const waiters = (store as unknown as { firstPayloadWaiters: unknown[] }).firstPayloadWaiters;
    for (let i = 0; i < 3; i += 1) expect(await store.waitForSkills(10)).toBe(false);
    // Every timed-out wait left behind is retained for the store's lifetime.
    expect(waiters).toHaveLength(0);
  });

  it('resolves waitForSkills false at once for a wait started after close', async () => {
    // A connection that is open and has delivered nothing: the store is neither
    // holding a payload nor has it given up, which is the state in which a wait
    // used to run its timeout out in full.
    endpoint.holdStreamOpen = true;
    endpoint.queueStream([]);
    const store = streamStore();
    store.start();
    expect(await waitUntil(() => endpoint.requests.length > 0)).toBe(true);
    await store.close();
    const started = Date.now();
    expect(await store.waitForSkills(3_000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('resolves waitForSkills false at once for a store closed before it started', async () => {
    const store = pollStore();
    await store.close();
    const started = Date.now();
    expect(await store.waitForSkills(3_000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not report a clean close as a delivery failure', async () => {
    endpoint.holdStreamOpen = true;
    endpoint.queueStream([]);
    const store = streamStore();
    store.start();
    expect(await waitUntil(() => endpoint.requests.length > 0)).toBe(true);
    await store.close();
    expect(await store.waitForSkills(50)).toBe(false);
    expect(store.failed).toBeNull();
  });

  it('still answers waitForSkills true after close when a payload arrived', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    const store = pollStore();
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    await store.close();
    expect(await store.waitForSkills(3_000)).toBe(true);
  });

  it('refuses to restart a closed store', async () => {
    const store = pollStore();
    store.start();
    await store.close();
    expect(() => store.start()).toThrow(/cannot be restarted/);
  });

  it('opens no second delivery loop once closed', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    const store = pollStore({ pollIntervalMs: 60_000 });
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    await store.close();
    const requests = endpoint.requests.length;
    // The refusal itself is asserted above; what matters here is that the store
    // opened nothing, rather than throwing after starting a second loop.
    try {
      store.start();
    } catch {
      /* expected */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(endpoint.requests).toHaveLength(requests);
  });

  it('refuses to restart a store closed before it ever started', async () => {
    const store = pollStore();
    await store.close();
    expect(() => store.start()).toThrow(/cannot be restarted/);
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

// ─── Endpoints ───────────────────────────────────────────────────────────────

describe('endpoints', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Runs one poll and one stream connect through a stubbed `fetch`; returns the URLs requested. */
  async function requestedUrls(requester: FetchRequester): Promise<{ poll: string; stream: string }> {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      urls.push(String(input));
      return new Response(null, { status: 304 });
    });
    await requester.poll(null, null, new AbortController().signal);
    await expect(requester.stream(null, new AbortController().signal)).rejects.toThrow();
    return { poll: urls[0], stream: urls[1] };
  }

  it('polls sdk.launchdarkly.com and streams from stream.launchdarkly.com by default', async () => {
    expect(DEFAULT_BASE_URI).toBe('https://sdk.launchdarkly.com');
    expect(DEFAULT_STREAM_URI).toBe('https://stream.launchdarkly.com');
    const requester = requesterOf(new FDv2SkillStore(SDK_KEY));
    expect(requester.baseUri).toBe(DEFAULT_BASE_URI);
    expect(requester.streamUri).toBe(DEFAULT_STREAM_URI);
    const { poll, stream } = await requestedUrls(requester);
    expect(poll).toBe('https://sdk.launchdarkly.com/sdk/poll');
    expect(stream).toBe('https://stream.launchdarkly.com/sdk/stream');
  });

  it('sends both endpoints to a custom baseUri when no streamUri is given', async () => {
    const requester = requesterOf(new FDv2SkillStore(SDK_KEY, { baseUri: 'https://relay.example.com/' }));
    const { poll, stream } = await requestedUrls(requester);
    expect(poll).toBe('https://relay.example.com/sdk/poll');
    expect(stream).toBe('https://relay.example.com/sdk/stream');
  });

  it('lets streamUri differ from baseUri', async () => {
    const requester = requesterOf(
      new FDv2SkillStore(SDK_KEY, { baseUri: 'https://sdk.example.com', streamUri: 'https://stream.example.com/' }),
    );
    const { poll, stream } = await requestedUrls(requester);
    expect(poll).toBe('https://sdk.example.com/sdk/poll');
    expect(stream).toBe('https://stream.example.com/sdk/stream');
  });

  it('keeps the default poll host when only streamUri is given', () => {
    const requester = requesterOf(new FDv2SkillStore(SDK_KEY, { streamUri: 'https://stream.example.com' }));
    expect(requester.baseUri).toBe(DEFAULT_BASE_URI);
    expect(requester.streamUri).toBe('https://stream.example.com');
  });

  it('carries the basis to whichever host the request goes to', async () => {
    const requester = new FetchRequester(SDK_KEY, 'https://sdk.example.com', 1000, 'https://stream.example.com');
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      urls.push(String(input));
      return new Response(null, { status: 304 });
    });
    await requester.poll('(p:a:1)', null, new AbortController().signal);
    await expect(requester.stream('(p:a:1)', new AbortController().signal)).rejects.toThrow();
    expect(urls[0]).toBe('https://sdk.example.com/sdk/poll?basis=%28p%3Aa%3A1%29');
    expect(urls[1]).toBe('https://stream.example.com/sdk/stream?basis=%28p%3Aa%3A1%29');
  });

  /**
   * An oversized poll body, served in `chunk`-sized reads and counting how many
   * were pulled. Finite on purpose, at a little past the bound: an unbounded
   * reader then fails the read count rather than running the worker out of
   * memory, so a regression here reads as an assertion and not as a crash.
   */
  const oversizedPollBody = (chunk: number): { body: ReadableStream<Uint8Array>; reads: () => number } => {
    const total = Math.ceil(MAX_RESPONSE_CHARS / chunk) + 8;
    let reads = 0;
    return {
      reads: () => reads,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (reads >= total) {
            controller.close();
            return;
          }
          reads += 1;
          controller.enqueue(new TextEncoder().encode('x'.repeat(chunk)));
        },
      }),
    };
  };

  it('bounds a poll body rather than buffering whatever the server sends', async () => {
    // `response.text()` would materialize the whole body and leave it to be
    // measured after, which is no bound at all — the allocation has already
    // happened. The read count is what pins that it stops early rather than
    // reading to the end and rejecting the result.
    const chunk = 1024 * 1024;
    const { body, reads } = oversizedPollBody(chunk);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
    const requester = new FetchRequester(SDK_KEY, 'https://sdk.example.com', 1000);
    await expect(requester.poll(null, null, new AbortController().signal)).rejects.toBeInstanceOf(
      RecoverableTransportError,
    );
    expect(reads()).toBeLessThanOrEqual(MAX_RESPONSE_CHARS / chunk + 2);
  });

  it('says nothing was applied when a poll body crosses the bound', async () => {
    const { body } = oversizedPollBody(4 * 1024 * 1024);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
    const requester = new FetchRequester(SDK_KEY, 'https://sdk.example.com', 1000);
    await expect(requester.poll(null, null, new AbortController().signal)).rejects.toThrow(
      /exceeded the \d+ character transport bound.*nothing from it was applied/,
    );
  });

  it('reassembles a poll body that arrives across several reads', async () => {
    // The bounded read decodes incrementally, so a multi-byte character split
    // across two reads must not be mangled into replacement characters — that
    // would corrupt content the hash is checked against.
    const payload = JSON.stringify({ events: [{ event: 'put-object', data: { note: 'café — naïve' } }] });
    const bytes = new TextEncoder().encode(payload);
    const split = bytes.indexOf(0xc3) + 1; // mid-sequence, inside 'é'
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
    const requester = new FetchRequester(SDK_KEY, 'https://sdk.example.com', 1000);
    const result = await requester.poll(null, null, new AbortController().signal);
    expect(result.events).toEqual([['put-object', { note: 'café — naïve' }]]);
  });
});

// ─── Layering, and the absence of telemetry ──────────────────────────────────

// ─── Transport contract assertions the spec names (§3.25) ────────────────────

describe('transport contract', () => {
  const source = readFileSync(new URL('../skills-fdv2.ts', import.meta.url), 'utf8');

  it('holds the wire kind as its own declaration, not an alias of the seam kind', () => {
    // One is a wire value LaunchDarkly owns, the other an SDK seam. They are
    // equal today; a change to either must be a deliberate change to that one.
    expect(source).toMatch(/export const FDV2_OBJECT_KIND = 'skill';/);
    expect(source).not.toMatch(/FDV2_OBJECT_KIND\s*=\s*SKILL_OBJECT_KIND/);
    expect(FDV2_OBJECT_KIND).toBe(SKILL_OBJECT_KIND);
  });

  it('the 401 message names the SDK key', () => {
    expect(classifyStatus(401).message).toMatch(/SDK key/);
  });

  it('a goodbye on a store holding committed content keeps it', () => {
    const held = new SkillObjectSet();
    const reader = new ProtocolReader(held);
    drive(reader, fullPayload([['put-object', putSkill()]]));
    const outcome = reader.handle('goodbye', { reason: 'recycle', silent: true, catastrophe: false });
    expect(outcome.disconnect).toBeTruthy();
    expect(held.get('pdf-extraction', null)).not.toBeNull();
    // An in-flight transfer is abandoned too, without touching what was committed.
    drive(reader, events(['server-intent', serverIntent('xfer-full')], ['put-object', putSkill('other')]));
    reader.handle('goodbye', { reason: 'recycle', silent: true });
    expect(held.size).toBe(1);
  });

  it('bound exhaustion logs the error and keeps serving last known good, in one test', async () => {
    const requester = new ScriptedRequester([asPairs(fullPayload([['put-object', putSkill()]]))]);
    const store = scriptedStreamStore(requester, { maxConsecutiveFailures: 2 });
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    expect(await waitUntil(() => store.failed !== null, 5000)).toBe(true);
    expect(consoleErrors()).toMatch(/will not retry/);
    expect(consoleErrors()).toMatch(/gave up after 3 consecutive failures/);
    expect(store.getObject(SKILL_OBJECT_KIND, 'pdf-extraction')).not.toBeNull();
    expect(store.allObjects(SKILL_OBJECT_KIND)).toHaveProperty('pdf-extraction');
  });

  it('holds a tampered object while the accessor reports integrity_failure', async () => {
    // Verification is the accessor's job, not the transport's: the store keeps
    // what arrived, and the reported outcome is what tells a caller to fail closed.
    endpoint.queuePoll(fullPayload([['put-object', putSkill('tampered', { contentHash: hash('something else') })]]));
    const store = pollStore();
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    _setStore(store);
    expect(store.getObject(SKILL_OBJECT_KIND, 'tampered')).not.toBeNull();
    const outcome = await getSkillResult('tampered');
    expect(outcome.reason).toBe('integrity_failure');
    expect(outcome.skill).toBeNull();
    expect(store.getObject(SKILL_OBJECT_KIND, 'tampered')).not.toBeNull();
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects a non-positive or non-finite pollIntervalMs (%s)', (value) => {
    // `NaN` is the case a `<= 0` guard misses.
    expect(() => new FDv2SkillStore(SDK_KEY, { mode: 'poll', pollIntervalMs: value })).toThrow(/pollIntervalMs/);
  });

  it('rejects a non-string credential', () => {
    expect(() => new FDv2SkillStore(42 as never)).toThrow(/server-side SDK key/);
    expect(() => new FDv2SkillStore(undefined as never)).toThrow(/server-side SDK key/);
  });

  it('refusal messages for mobile and client-side credentials say skills are server-side', () => {
    expect(() => new FDv2SkillStore('mob-00000000-0000-4000-8000-000000000000')).toThrow(/server-side/);
    expect(() => new FDv2SkillStore('0123456789abcdef01234567')).toThrow(/server-side/);
  });

  it.each([
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    -1,
  ])('waitForSkills rejects a non-finite or negative timeoutMs (%s)', async (value) => {
    const store = pollStore();
    await expect(store.waitForSkills(value)).rejects.toThrow(/timeoutMs/);
  });

  it('an idle stream carrying heartbeats stays connected past what the read timeout alone would allow', async () => {
    // The read deadline bounds the gap between reads, not the connection's
    // life. Heartbeats well inside `readTimeoutMs` keep one connection open for
    // several multiples of it, with no reconnect.
    endpoint.holdStreamOpen = true;
    endpoint.heartbeatMs = 20;
    endpoint.queueStream(fullPayload([['put-object', putSkill()]]));
    const store = streamStore({ readTimeoutMs: 100 });
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(endpoint.requests).toHaveLength(1);
    expect(store.failed).toBeNull();
    expect(store.diagnostics.connectionFailures).toBe(0);
    expect(store.diagnostics.lastError).toBeNull();
  });

  it('a stream interrupted by close does not count as a success', async () => {
    // `streamOnce` returning because the signal aborted is the store closing,
    // not the server answering — so the row of failures must not be reset by it.
    let release: (() => void) | null = null;
    const parked: Requester = {
      poll() {
        throw new Error('not a polling double');
      },
      async stream(_basis, signal) {
        return (async function* () {
          yield ['heart-beat', {}] as [string, unknown];
          await new Promise<void>((resolve) => {
            release = resolve;
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          // One more event after the abort, so the loop observes the signal.
          yield ['heart-beat', {}] as [string, unknown];
        })();
      },
    };
    const requester = new ScriptedRequester([new RecoverableTransportError('x'), parked as never]);
    const wrapped: Requester = {
      poll: (b, e, s) => requester.poll(b, e, s),
      stream: async (b, s) => {
        if (requester.calls.length === 0) return requester.stream(b, s);
        requester.calls.push([b, null]);
        return parked.stream(b, s);
      },
    };
    const store = scriptedStreamStore(wrapped, { maxConsecutiveFailures: 5 });
    store.start();
    expect(await waitUntil(() => release !== null, 5000)).toBe(true);
    expect(store.diagnostics.connectionFailures).toBe(1);
    await store.close();
    expect(store.diagnostics.connectionFailures).toBe(1);
  });
});

describe('listeners', () => {
  it('logs an async listener whose promise rejects rather than leaving it unhandled', async () => {
    endpoint.queuePoll(fullPayload([['put-object', putSkill()]]));
    const store = pollStore();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      store.addListener(SKILL_OBJECT_KIND, async () => {
        throw new Error('async listener exploded');
      });
      store.start();
      expect(await store.waitForSkills(5000)).toBe(true);
      expect(await waitUntil(() => /async listener exploded/.test(consoleErrors()), 5000)).toBe(true);
      expect(consoleErrors()).toContain('delivery continues');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(store.failed).toBeNull();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('layering', () => {
  /** `skills-fdv2.ts`'s own source text — the only way to assert a leaf. */
  const source = readFileSync(new URL('../skills-fdv2.ts', import.meta.url), 'utf8');

  /** Every `from '...'` specifier in a source file, in order. */
  function importsOf(text: string): string[] {
    return [...text.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+'([^']+)'/gm)].map(([, specifier]) => specifier);
  }

  it('adds no dependency beyond the standard library', () => {
    // The package's sole runtime dependency is the OpenTelemetry API, and the
    // transport is not allowed to add a second one. A `package.json` assertion
    // would not catch it — a transitive dependency of another package resolves
    // perfectly well from here.
    const external = importsOf(source).filter((specifier) => !specifier.startsWith('.'));
    expect(external.filter((specifier) => !specifier.startsWith('node:'))).toEqual([]);
  });

  it('imports the shared internals for the seam kind and nothing else from the feature', () => {
    // The transport sits *below* the `SkillStore` interface: it produces raw
    // wire objects and knows nothing about verification, the `Skill` type, or
    // materialization. The seam kind is the one thing it legitimately needs from
    // above, so that import is spelled out and the rest are named as forbidden.
    const relative = [...new Set(importsOf(source).filter((specifier) => specifier.startsWith('.')))];
    // `types.js` is the package's value-type module, not a layer of the feature:
    // the wire objects it produces have to be typed somehow. `skills-core.js` is
    // the only feature module, and `skills.js` / `skills-fs.js` /
    // `skills-watch.js` are absent by construction rather than by coincidence.
    expect(relative.sort()).toEqual(['./skills-core.js', './types.js']);

    // And only the seam kind comes out of the shared internals — not the
    // verification helpers, not the store state.
    const fromCore = source.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/skills-core\.js'/);
    expect(fromCore).not.toBeNull();
    expect((fromCore as RegExpMatchArray)[1].split(',').map((name) => name.trim())).toEqual(['SKILL_OBJECT_KIND']);
  });

  it('is imported by nothing in the feature, so the layering cannot invert', () => {
    // The package index re-exports it, which is the publication point rather
    // than a layer — but no *module* of the feature may reach for it, or the
    // accessors would start depending on one particular transport.
    for (const module of ['skills.ts', 'skills-core.ts', 'skills-fs.ts', 'skills-watch.ts']) {
      const text = readFileSync(new URL(`../${module}`, import.meta.url), 'utf8');
      expect(importsOf(text), module).not.toContain('./skills-fdv2.js');
    }
  });
});

describe('telemetry', () => {
  it('records no signal of its own across a full delivery cycle', async () => {
    // The three signals in the allowlist belong to verification and to
    // materialization. The transport holds what arrived and counts what it
    // ignored; it does not judge content, so it has nothing to report — in
    // particular not for the hashless object below, which is verification's to
    // withhold and not the transport's to flag.
    const emitter = new RecordingEmitter();
    _setEmitterForTesting(emitter);

    endpoint.queuePoll(
      fullPayload([
        ['put-object', putSkill('pdf-extraction')],
        ['put-object', putSkill('hashless', { omitHash: true })],
        ['put-object', putSkill('tampered', { contentHash: hash('something else') })],
        ['put-object', putFlag()],
      ]),
    );
    endpoint.queuePoll(
      events(
        ['server-intent', serverIntent('xfer-changes')],
        ['delete-object', deleteSkill('pdf-extraction')],
        ['payload-transferred', transferred('basis-2')],
      ),
    );

    const store = pollStore({ pollIntervalMs: 20 });
    store.start();
    expect(await store.waitForSkills(5000)).toBe(true);
    expect(await waitUntil(() => store.diagnostics.objectsRevoked > 0, 10_000)).toBe(true);
    // Serving is part of the cycle too, and it is the surface a naive
    // implementation would verify on.
    store.allObjects(SKILL_OBJECT_KIND);
    store.getObject(SKILL_OBJECT_KIND, 'tampered');
    await store.close();

    expect(emitter.records).toEqual([]);
  });
});
