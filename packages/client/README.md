# `@launchdarkly/ai-server` — Core Client

The core package for the LaunchDarkly AI SDK. It owns the LaunchDarkly client lifecycle, telemetry pipeline, all shared types, and the primary entry points that handler packages depend on.

All handler packages (`@launchdarkly/ai-*`) depend on this package.

> **Node.js users:** consider installing [`@launchdarkly/ai-node`](../ai-node/README.md) instead. It re-exports this package's full API and bundles `@launchdarkly/node-server-sdk` as a hard dependency, so no peer dependency setup is needed.

## Installation

### Without telemetry

```bash
npm install @launchdarkly/ai-server
```

`@launchdarkly/node-server-sdk` is an optional peer dependency — include it for standard Node.js, or pass a pre-initialized client from another LD SDK (e.g. `@launchdarkly/vercel-server-sdk`) to `initClient(client)` for edge runtimes.

The SDK works fully without the OpenTelemetry packages — feature flags evaluate, handlers run, and LaunchDarkly AI events are tracked. Spans are created as no-ops. If you start `initClient()` without the OTel SDK packages installed, the SDK logs a single `console.warn` and continues normally.

### With telemetry (recommended for production)

To export traces to the LaunchDarkly Observability dashboard (or any OTLP-compatible backend), install the OTel SDK peer dependencies alongside the core package:

```bash
npm install @launchdarkly/ai-server \
  @opentelemetry/sdk-trace-node \
  @opentelemetry/sdk-trace-base \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/otlp-exporter-base \
  @opentelemetry/resources \
  @opentelemetry/context-async-hooks \
  @opentelemetry/core
```

No code changes are required — `initClient()` detects the packages at runtime and sets up the tracer provider automatically.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `LD_SDK_KEY` | Yes | LaunchDarkly server-side SDK key |
| `LD_BASE_URI` | No | Override the LaunchDarkly polling base URI (e.g. for staging) |
| `LD_STREAM_URI` | No | Override the streaming URI |
| `LD_EVENTS_URI` | No | Override the events URI |
| `LD_SERVICE_NAME` | No | OTel `service.name` resource attribute (default: `nodejs-sdk`) |
| `LD_ENVIRONMENT` | No | `deployment.environment` resource attribute attached to telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | OTLP endpoint override (default: LaunchDarkly Observability backend) |

The client uses **lazy initialization**: importing the package does not connect to LaunchDarkly. The singleton is created automatically on the first API call that needs it (`config().invoke()`, `graph().invoke()`, `resolveGraph()`, etc.), as long as `LD_SDK_KEY` is set in the environment.

Call `initClient()` explicitly when you want to:
- Pass SDK or telemetry options programmatically (overriding env vars)
- Initialize at startup before the first AI call (e.g. to avoid latency on the first request)
- Fail fast at boot if `LD_SDK_KEY` is missing

```ts
import { initClient, shutdown, waitForTelemetry, shutdownTelemetry } from '@launchdarkly/ai-server';

// Standard Node.js path — auto-discovers @launchdarkly/node-server-sdk.
// Returns the initialized LDClientInterface for further use if needed.
const client = await initClient({
  sdkKey: 'sdk-...',
  serviceName: 'my-service',
  environment: 'production',
});

// Or skip initClient() and let the first model/graph call initialize lazily.

// Edge / custom runtime path — pass an already-initialized client.
// @launchdarkly/node-server-sdk is NOT required in this case.
// import { init } from '@launchdarkly/vercel-server-sdk';
// const vercelClient = init(clientSideId, edgeConfigClient);
// await initClient(vercelClient);

// Flush telemetry, flush LD events, and close the client.
await shutdown();
```

| Export | Description |
|---|---|
| `initClient(options?)` | Auto-discover and initialize `@launchdarkly/node-server-sdk`. Optional — the first AI API call triggers lazy init when `LD_SDK_KEY` is set. Returns `Promise<LDClientInterface>`. |
| `initClient(client, options?)` | **BYOC overload** — accept a pre-initialized `LDClientInterface` (e.g. from `@launchdarkly/vercel-server-sdk` or any edge runtime). Skips SDK auto-discovery. |
| `getClient()` | Return the initialized `LDClientInterface`. Throws if `initClient` has not completed. |
| `shutdown()` | Flush all events and telemetry, then close the client. Call before process exit. |
| `waitForTelemetry()` | Wait for the OTel provider to be ready. Useful to avoid dropping early spans. |
| `shutdownTelemetry()` | Flush and stop the OTel exporter independently of the LD client. |
| `inspectConfig(key, context)` | Read an AI Config variation without invoking the model. Never throws. Returns `{ enabled, config, meta }`. |

### `config(args)`

The primary entry point for AI config invocations. Accepts either a single handler or an array of handlers and routes to the correct one at invoke-time based on the flag variation's provider and mode.

```ts
import { config } from '@launchdarkly/ai-server';
import { createOpenAIHandler } from '@launchdarkly/ai-openai-messages';
import { createOpenAIAgentHandler } from '@launchdarkly/ai-openai-agents';
import { createClaudeAgentsHandler } from '@launchdarkly/ai-claude-agents';

// Single handler — must match the flag variation's provider+mode, or throws.
const caller = config({
  key: 'my-ai-config-flag',
  handler: createOpenAIHandler(),
  toolHandlers: { myTool: myToolFn },      // optional: tool implementations
});

const result = await caller.invoke(
  'What is feature flagging?',
  { kind: 'user', key: 'user-123' },
  { userName: 'Alice' },                   // optional: template substitutions
);
console.log(result.response); // string
console.log(result.usage);    // { input, output, total }

// Multiple handlers — routing selects the match by provider + mode.
const router = config({
  key: 'my-ai-config-flag',
  toolHandlers: { search: searchFn },
  handler: [
    createOpenAIHandler(),        // providesFor: ['OpenAI', 'messages']
    createOpenAIAgentHandler(),   // providesFor: ['OpenAI', 'agent']
    createClaudeAgentsHandler(),  // providesFor: ['Anthropic', 'agent']
  ],
});

const result2 = await router.invoke('Summarize this document', { kind: 'user', key: 'user-123' });
console.log(result2.judgeResults); // judge evaluation results when skipJudges is false (default)
console.log(result2.trackData);    // run ID, config key, model name, etc.

// Multi-turn conversation — pass prior turns as history (4th arg after variables).
const history = [
  { role: 'user', content: 'What is feature flagging?' },
  { role: 'assistant', content: 'Feature flagging is a technique for safely releasing features...' },
];
const result3 = await caller.invoke('Can you give me an example?', { kind: 'user', key: 'user-123' }, undefined, history);

await shutdown();
```

### `graph(key, options)`

Runs a multi-agent workflow defined in a LaunchDarkly agent graph flag. The SDK uses a **model-driven router**: it starts at the root node, presents outgoing edges as handoff choices to the model, and follows whichever edge the model selects — threading both the original user request and the previous node's response into each subsequent node. The loop terminates when the model produces a final answer, a leaf is reached, a cycle is detected, or the step cap is hit.

Each node runs through the same tracked path as `config().invoke()`, so every node emits its own telemetry and judges, tagged with the graph key. Graph-level `$ld:ai:graph:*` events wrap the full run.

```ts
import { graph, shutdown } from '@launchdarkly/ai-server';
import { createClaudeAgentsHandler } from '@launchdarkly/ai-claude-agents';

const g = graph('support-graph', {
  handlers: [createClaudeAgentsHandler()], // pass multiple for mixed-provider graphs
  toolHandlers: { search: searchFn },
});

const result = await g.invoke(
  'I was double charged',
  { kind: 'user', key: 'user-123' },
  { account_tier: 'pro' },   // optional variables
);

console.log(result.response); // final output
console.log(result.usage);    // aggregate { input, output, total }

// Stream tokens while traversing the same graph path (node boundaries included):
for await (const event of g.stream('I was double charged', { kind: 'user', key: 'user-123' })) {
  if (event.type === 'chunk') process.stdout.write(event.text);
  if (event.type === 'done') console.log('\n', event.usage);
}

await shutdown();
```

Routing is by each node config's `provider.name` + `meta.mode`, so a single graph can mix providers when you pass multiple handlers. Provider packages also export a single-provider convenience (e.g. `claudeGraph`, `openaiGraph`, `langchainGraph`) that pre-binds their handler.

`graph(...).stream()` yields `GraphStreamEvent` values (`node_start`, `chunk` with `nodeKey`, `node_done`, `handoff`, final `done`) while keeping the same handoff / path / graph-level telemetry as `invoke()`. Handlers without `.stream` fall back to a single chunk per node, matching `config().stream()`.

`resolveGraph(key, options)` returns a `GraphDefinition` without executing it. It still requires `context` at resolution time (it has no deferred `.invoke()`). The definition carries `.enabled` so you can branch on a disabled graph before traversing. `graph(...).invoke()` / `.stream()` throw if the graph is disabled.

### `Registry` / `globalRegistry` / `compose`

A `Registry` bundles handlers and tool implementations that can be shared across `config()`, `graph()`, and `resolveGraph()` calls. Pass it as `options.registry`; local `handler`/`toolHandlers` always take precedence.

```ts
import { Registry, globalRegistry, compose, config } from '@launchdarkly/ai-server';
import { createClaudeAgentsHandler } from '@launchdarkly/ai-claude-agents';

// Build a reusable registry
const myRegistry = new Registry({
  handlers: [createClaudeAgentsHandler()],
  tools: { myTool: myToolFn },
});

// Or register incrementally
myRegistry.register({ tools: { anotherTool: anotherFn } });

// Use globalRegistry as a process-wide default
globalRegistry.register({ handlers: [createClaudeAgentsHandler()] });

// Combine two registries — b wins over a on conflict, neither is mutated
const combined = compose(myRegistry, anotherRegistry);

const router = config({ key: 'my-flag', registry: myRegistry });
```

### `inspectConfig(key, context)`

Reads an AI Config flag variation **without invoking any AI provider**. Use this for health checks, logging, feature-gate probes, or any situation where you need to know whether a config is enabled or what model it points to — without spending API quota.

```ts
import { inspectConfig } from '@launchdarkly/ai-server';

const result = await inspectConfig('my-ai-config-flag', { kind: 'user', key: 'user-123' });

if (!result.enabled) {
  console.log('Flag is off — skipping AI call');
} else {
  console.log(result.config?.model?.name); // e.g. 'claude-opus-4-5'
  console.log(result.meta?.variationKey);
}
```

**Guarantees:**
- Never throws — returns `{ enabled: false, config: null, meta: null }` on any error (network failure, bad key, schema mismatch, etc.)
- Does not emit LD telemetry events
- Does not call any AI provider
- Lazily initializes the LD client (same as all other entry points)

| Return field | Type | Description |
|---|---|---|
| `enabled` | `boolean` | Whether the flag variation is active |
| `config` | `AiConfigRep \| null` | The parsed AI config, or `null` when disabled or invalid |
| `meta` | `VariationMeta \| null` | Variation metadata (key, version, mode), or `null` when unreachable |

---

### Agent Skills

Agent Skills are versioned `SKILL.md` documents managed in LaunchDarkly and attached to AI Config variations by reference. This package tells you which skills a config references, retrieves their content, and writes them to `<root>/<key>/SKILL.md`, where agent runtimes such as the Claude Agent SDK discover them.

**Everything below goes through a `SkillStore`.** None is configured by default, so the accessors throw an actionable error until you set one. Use `InMemorySkillStore` for local development, tests, and bring-your-own-content, and `FDv2SkillStore` to receive content from LaunchDarkly — see [Receiving skills from LaunchDarkly](#receiving-skills-from-launchdarkly).

```ts
import { createHash } from 'node:crypto';
import {
  allSkills,
  getSkill,
  getSkillResult,
  getSkills,
  initClient,
  InMemorySkillStore,
  skillRefs,
  writeSkills,
} from '@launchdarkly/ai-server';

// A store serves wire-shaped raw objects. `contentHash` is sha256, lowercase
// hex, over the verbatim UTF-8 bytes of `content`. Content that does not hash
// to it is withheld.
const content = '---\nname: PDF Extraction\n---\nExtract text from PDFs.\n';
const store = new InMemorySkillStore();
store.put({
  key: 'pdf-extraction',
  version: 2,
  content,
  contentHash: createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex'),
});

// Configure it as part of ordinary initialization...
await initClient({ skillStore: store });
// ...or alongside a pre-initialized client on an edge runtime:
// await initClient(myEdgeClient, { skillStore: store });

// Which skills does a resolved config reference? A pure projection — no I/O,
// and it works before any client exists.
const refs = skillRefs({
  model: { name: 'claude-opus-4-5' },
  provider: { name: 'Anthropic' },
  instructions: 'Summarize the attached document.',
  skills: [{ key: 'pdf-extraction', version: 2 }],
}); // [{ key: 'pdf-extraction', version: 2 }]

// In real use the config comes from LaunchDarkly:
// const info = await inspectConfig('doc-agent', { kind: 'user', key: 'user-123' });
// const refs = skillRefs(info.config);

// Retrieve content. Every skill is hash-verified before you see it.
// `Skill.content` is a Uint8Array of the verified verbatim bytes; the SDK never
// interprets them.
const newest = await getSkill('pdf-extraction'); // newest available
const pinned = await getSkill('pdf-extraction', { version: 2 }); // exact version, or null
const batch = await getSkills(refs); // input order; misses omitted
// `getSkill` returns null for four different reasons. To tell them apart (for
// example, to fail closed on suspected tampering), ask for the outcome instead.
const outcome = await getSkillResult('pdf-extraction', { version: 2 });
if (outcome.reason === 'integrity_failure') throw new Error(outcome.detail ?? 'withheld');
const everything = await allSkills();
const text = new TextDecoder().decode(newest?.content); // if you want a string

// Materialize onto disk at <root>/<key>/SKILL.md. Only the leaf directory is
// created, so `.claude` must already exist.
const report = await writeSkills(refs, '.claude/skills');
if (!report.ok) {
  for (const action of report.errors) {
    console.error(`skill ${action.key}: ${action.error}`);
  }
}
```

`writeSkills` is a **reconcile**, not a copy. It records what it wrote in `<root>/.launchdarkly-skills.json` and overwrites or deletes **only** paths that manifest lists under a matching key. A file you placed yourself is reported as an error and left alone. Revocation is pruning: a skill absent from the resolved set is removed on the next run.

**One exception: byte-identical files are adopted.** A file at a managed path whose bytes already equal the resolved content is recorded in the manifest and reported `skipped_current` instead of refused. This lets a reconcile that crashed after writing a skill file, but before writing the manifest, recover on the next run. A file whose bytes differ, or that cannot be read, is still refused and left untouched.

```ts
// Everything the store holds, materialized at boot.
const report = await writeSkills('*', '.claude/skills', {
  prune: true,          // default — remove formerly-managed skills no longer resolved
  timeout: 10,          // seconds, not milliseconds
  onUnavailable: 'keep', // 'keep' reports a failed retrieval; 'raise' throws
});
```

**Know what `'*'` asks for.** It writes the **whole project library**, which puts every skill's `description` into the agent's context, including skills no AI Config references and skills belonging to other teams. `writeSkills(skillRefs(config), root)`, as in the first example, writes only what the resolved variation asked for.

| Export | Description |
|---|---|
| `skillRefs(config)` | Project a config's `skills` array into typed `SkillReference[]`. Pure — no client, no store, no telemetry. `[]` when absent. |
| `getSkill(key, { version? })` | One verified skill. Omit `version` for the newest available. Resolves to `null` when the skill is unavailable; throws only when no store is configured. |
| `getSkillResult(key, { version? })` | The same retrieval, reporting **why**: resolves to `{ skill, reason, detail }`, where `reason` is `ok` / `absent` / `integrity_failure` / `store_unavailable` / `wrong_version`. Throws only when no store is configured. See [fail closed on tampering](#fail-closed-on-tampering-getskillresult). |
| `getSkills(refs)` | Batch form. Accepts `SkillReference` values and bare key strings (string = latest). Results follow input order; missing or unverifiable entries are omitted. |
| `allSkills()` | Every verified skill the store holds, newest version per key. |
| `writeSkills(skills, root, options?)` | Materialize to `<root>/<key>/SKILL.md`. Accepts `Skill` / `SkillReference` / key strings, or the literal `'*'`. Returns a `ReconcileReport`. Throws for a caller error (an unusable `root`, a bare string other than `'*'`), distinct from the per-skill `error` actions in the report. |
| `InMemorySkillStore` | An in-memory `SkillStore` for local development and testing: `put(raw)`, `getObject(kind, key, version?)`, `allObjects(kind)`, `addListener(kind, fn)`, `removeListener(kind, fn)`. Holds several versions of a key: `getObject` answers a pin with exactly that version and an omitted version with the newest. `addListener` throws for any kind but `'skill'`. |
| `FDv2SkillStore(sdkKey, options?)` | The delivery transport: a `SkillStore` fed by LaunchDarkly over the SDK-facing FDv2 channel. `start()`, `waitForSkills(timeoutMs)`, `isInitialized()`, `close()`, `diagnostics`, `failed`, `addListener` / `removeListener`. `close()` is **final** — `start()` throws afterwards. Options (`FDv2SkillStoreOptions`): `mode` (`'stream'` default, or `'poll'`), `baseUri`, `streamUri`, `pollIntervalMs`, `readTimeoutMs`, `initialBackoffMs`, `maxBackoffMs` (each positive and finite, with `initialBackoffMs` no greater than `maxBackoffMs`; the constructor throws otherwise). **Server-side only.** See [Receiving skills from LaunchDarkly](#receiving-skills-from-launchdarkly). |
| `watchSkills(skills, root, options?)` | `writeSkills` plus a re-reconcile on every delivery change, so with `'*'` revocation takes effect within `debounceMs` rather than at the next restart (see [Receiving skills from LaunchDarkly](#receiving-skills-from-launchdarkly) for an explicit list). Resolves to `{ report, watcher }`; `await watcher.close()` when done. Options (`WatchSkillsOptions`): everything `writeSkills` takes, plus `debounceMs` (milliseconds, default `DEFAULT_DEBOUNCE_MS`) and `onReconcile`. One watcher per root. |
| `SkillWatcher` | Returned by `watchSkills`: `reconciles` (re-reconciles completed, excluding the initial one), `notify` (the registered change listener), `close()` (idempotent; detaches and awaits any reconcile in flight). |
| `StoreDiagnostics` | What the transport has seen: `payloadsTransferred`, `skillObjectsReceived`, `objectsIgnored`, `objectsRevoked` (keys removed by a `delete-object` or dropped by a full transfer; a version bump or a tombstone for an unknown key does not count), `payloadsIgnored`, `hashlessObjects`, `connectionFailures`, `lastError`. |
| `DEFAULT_BASE_URI` / `DEFAULT_STREAM_URI` | `'https://sdk.launchdarkly.com'` and `'https://stream.launchdarkly.com'`, the default hosts for `GET /sdk/poll` and `GET /sdk/stream`. |
| `DEFAULT_DEBOUNCE_MS` | `500` — the `watchSkills` coalescing window in milliseconds. |
| `createSkill(init)` / `createSkillReference(init)` | Build frozen `Skill` / `SkillReference` values. Use `createSkill` to hand `writeSkills` content you already have. |
| `createSkillOutcome(init)` | Build a frozen `SkillOutcome`, for tests or for wrapping your own retrieval in the same shape. |
| `SKILL_FILENAME` | `'SKILL.md'`. |
| `MANIFEST_FILENAME` | `'.launchdarkly-skills.json'` — add this to your `.gitignore` if you do not commit materialized skills. |
| `MANIFEST_VERSION` | `1`. |

Two internal constants are **not** exported:

- `MAX_SKILL_CONTENT_BYTES` (10 MiB) is a local backstop above which content is withheld. The platform enforces its own, lower limit before delivery, so do not pre-flight against this one. When it withholds content, the `over_size_cap` reason string names the bound.
- `SKILL_OBJECT_KIND` (`'skill'`) is the kind this SDK passes to a store. A store adapter maps whatever its transport calls a skill onto it; it is not the wire contract.

`ReconcileReport` exposes `actions`, `ok` (true when no action is an `error`), and `errors` (the error actions, in order). Each `ReconcileAction` has `key`, `action` (`written` | `updated` | `skipped_current` | `removed` | `error`), and nullable `version` / `path` / `error`. A failure that belongs to the whole run, such as a corrupt manifest, has the **empty string** as its `key`.

**Security posture.** `writeSkills` fails closed:

- skill keys are re-validated locally, and content is hash-verified again immediately before writing;
- writes go to a temp file in the target's own directory, then an atomic rename, at mode `0644`;
- symlinked roots, directories, and targets are refused, as is a target that is not a regular file (a FIFO, a device node);
- a corrupt manifest suppresses every destructive action.

Node exposes no `renameat`/`unlinkat`/`openat`, so how well a directory swap is defended depends on the platform:

- **On Linux, the swap window is closed.** The managed root is opened once (`O_RDONLY|O_DIRECTORY|O_NOFOLLOW`) and held for the whole reconcile, and every child (each `<root>/<key>/`, `SKILL.md`, temp file, and the manifest) is addressed as `/proc/self/fd/<fd>/<name>`. The kernel resolves that to the inode the descriptor holds, so renaming the root or replacing it with a symlink after validation cannot redirect a write or a delete.
- **On macOS and Windows, the window is narrowed but not closed.** `/dev/fd/<fd>/<name>` does not resolve, so each step is preceded by a per-component `lstat` — a check-then-use race that an attacker with **write permission on the managed root, or on any of its ancestor directories**, can win to redirect a write or delete outside the root. Windows also has no reparse-point checks (`GetFileAttributesW` / `FILE_FLAG_OPEN_REPARSE_POINT`) in this release and is not a tested platform.

On macOS and Windows, write permission on the managed root **and its ancestors** is therefore *the* security boundary. Keep them writable only by the identity running the reconcile — see [privilege separation](#privilege-separation-the-agent-must-not-be-able-to-rewrite-its-own-skills). For a root of `.claude/skills` the parent is `.claude`, which an agent identity often owns.

**Some valid keys cannot be directory names.** Each key becomes one directory name, so `writeSkills` rejects, as a per-skill `error` action, a key over 255 bytes and the 22 Windows reserved device names (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`). The check runs on every platform. The key stays valid everywhere else: an AI Config referencing `aux` still parses, and its other skills still materialize. The 255-byte limit is per path component, so `<root>/<key>/SKILL.md` can still exceed Windows' 260-character `MAX_PATH`; keep the root short.

**Skill content is opaque to the SDK.** `Skill.content` is a `Uint8Array` of the exact bytes that were hashed, and the SDK never parses or decodes it. There is no frontmatter accessor or YAML dependency; decode and parse the bytes yourself with a parser you trust.

**No LaunchDarkly telemetry is emitted for skills.** Signals go through an internal no-op emitter; `client.track()` is never called and no LD context is involved.

#### Receiving skills from LaunchDarkly

`InMemorySkillStore` is for tests and bring-your-own-content. In production, skill content arrives through `FDv2SkillStore`, which uses LaunchDarkly's SDK-facing FDv2 delivery channel (the `GET /sdk/poll` and `GET /sdk/stream` endpoints the base SDK's FDv2 data source uses), authenticated with the environment's server-side SDK key.

```ts
import { FDv2SkillStore, initClient, watchSkills } from '@launchdarkly/ai-server';

const store = new FDv2SkillStore(process.env.LD_SDK_KEY!).start();
if (!(await store.waitForSkills(10_000))) {
  // No payload arrived. Reconciling now would find an empty store; see below.
  console.warn(`skill delivery has not answered yet: ${store.failed ?? 'still waiting'}`);
}
await initClient({ skillStore: store });

// Materialize now, and re-materialize whenever delivery changes. The report is
// the initial reconcile's; `onReconcile` sees the delivery-triggered ones.
const { report, watcher } = await watchSkills('*', '.claude/skills', {
  debounceMs: 500, // the default: how long a burst of changes waits before one reconcile runs
  onReconcile: (next) => {
    if (!next.ok) for (const action of next.errors) console.error(`skill ${action.key}: ${action.error}`);
  },
});
try {
  // ...
} finally {
  await watcher.close();
  await store.close();
}
```

**A reconcile that runs before delivery answers does not prune.** A store still waiting for its first payload looks the same as an environment with no skills, and `writeSkills('*')` would otherwise treat that as every skill revoked and delete the files from a previous run. `FDv2SkillStore` reports readiness through the optional `isInitialized()`; until it is true, a reconcile reports the retrieval unavailable (`report.ok` is `false`, and the error names the remedy) and leaves the disk alone. A store without `isInitialized()`, such as `InMemorySkillStore`, is treated as initialized.

**`watchSkills` is one watcher per root.** It registers the store's change listener, runs `writeSkills` once, and returns that report with a `SkillWatcher`.

- The store must implement the optional `addListener`; otherwise `watchSkills` throws rather than degrading to a one-shot reconcile.
- Delivery changes are coalesced over `debounceMs` (default `DEFAULT_DEBOUNCE_MS`, 500 ms), so a payload of forty objects runs one reconcile, not forty. `onReconcile` receives each of those reports, never the initial one.
- The watcher exposes `reconciles` (re-reconciles completed), `notify` (the registered listener, for tests), and `close()`, which detaches and awaits any reconcile in flight.
- Do not point two watchers at one root, or call `writeSkills` on a watched root yourself: two interleaved reconciles of one root lose manifest entries.
- `debounceMs` is in **milliseconds**, while `timeout` in the same options is in **seconds**.

**`waitForSkills` orders boot against the first payload.** It resolves `true` once a payload is committed, or a `304` confirms the held payload is current. It resolves `false` on timeout, or immediately once the store is closed or delivery stops for good on a fatal status (for example, an unauthorized key), including for waits already pending, so a boot gated on it does not proceed on a dead store. Read `failed` to tell a store that gave up from one that timed out; closing a store yourself leaves `failed` as `null`.

**`close()` is final.** `start()` throws on a closed store rather than opening a second connection. A closed store still answers from the content it received, so construct a new store only if you need delivery again.

**`addListener` observes skill changes only.** Only `'skill'` objects are dispatched, so registering under any other kind throws rather than silently never firing. `removeListener` accepts any kind, so detaching on close can be unconditional. `watchSkills` is the intended consumer of both.

**A 422 means this connection will never be assigned a skill payload, and delivery stops.** Every request declares the payload it wants (`kinds=agent-skill`), and LaunchDarkly answers HTTP 422 when it will not serve one.

- **Causes:** a view-scoped SDK key, which cannot be assigned a skill payload (use a key that is not view-scoped), or Agent Skills delivery not being enabled for your account (contact LaunchDarkly support).
- **What the store does:** retrying cannot help, so it gives up. `failed` carries the reason, `lastError` is set, and `waitForSkills` resolves `false` immediately instead of at your timeout. The 422 does not count toward `connectionFailures`, which tracks recoverable failures only.
- **Not the empty case:** an environment with zero skills is served an empty payload that commits normally.
- **Recovery:** `start()` does nothing on a store that has given up, so a process that booted while the cause was in effect picks up skills only after a restart.

**Nothing above the store changes.** The accessors, integrity verification, and `writeSkills` see raw objects through the `SkillStore` interface and cannot tell which store produced them.

**Server-side only.** Skills are for server-side agent runtimes and skill content is customer-confidential. A mobile key (`mob-…`) or a client-side environment ID throws from the constructor.

**The SDK key goes only where you pointed it.** `baseUri` and `streamUri` must be `https://` (plain `http://` is allowed only to a loopback host, for a local test double). Redirects are never followed, so a 3xx stops delivery instead of forwarding the key to the `Location` host.

**Polling and streaming have separate hosts.** By default `/sdk/poll` goes to `https://sdk.launchdarkly.com` and `/sdk/stream` to `https://stream.launchdarkly.com`. Pass `baseUri` alone to use one host for both, or `streamUri` as well to set them independently.

**Streaming is the default, and it is what makes revocation fast.** A `delete-object` reaches a live stream in seconds; with `mode: 'poll'` it arrives within one `pollIntervalMs`. With `watchSkills('*', …)`, a revoked skill's `SKILL.md` leaves the disk without a restart. With an explicit list such as `skillRefs(config)` it does not: a requested skill the store no longer holds stays in the requested set as an `error` action and is not pruned, and the watcher listens only to the skill store, not to flag changes, so unpinning a skill from a config is not seen either. Re-run `writeSkills` with a fresh list for those. During an outage the store keeps serving its last content, and `writeSkills`' default `onUnavailable: 'keep'` leaves managed files alone, so an outage does not read as "everything was revoked".

**Without the watcher, the revocation bound is process lifetime.** If you call `writeSkills` once at boot and never run `watchSkills`, a skill revoked after boot stays on disk, and in the agent's context, until the process reconciles again. To pull a skill immediately, restart or re-run `writeSkills`. Neither recalls content an agent has already read into a conversation.

**One network timeout, and its default depends on the mode.** `readTimeoutMs` bounds every step of a request, connecting included. In `mode: 'poll'` it bounds the whole request (default 10 seconds); in `mode: 'stream'` it bounds each wait for the next bytes (default 300 seconds, well beyond LaunchDarkly's heartbeat interval). A stream that goes quiet past it, or dies mid-body, reconnects. Every retry delay, including one requested with `Retry-After`, is capped at `maxBackoffMs`. Both backoff options must be positive and finite, and `initialBackoffMs` may not exceed `maxBackoffMs`: with no failure bound, they are the only limit on how fast a failing connection is retried. The delay grows on every reconnect, including a server-initiated recycle, and starts over at `initialBackoffMs` only after a stream has stayed open for 60 seconds, or a poll has completed. Recoverable failures are retried for the life of the store, so during an outage `failed` stays `null`, `connectionFailures` keeps counting, and `waitForSkills` runs to its timeout; only a fatal status stops delivery.

**The connection carries only skills.** Every request declares the skill payload, so flag and segment objects do not arrive on it. Any other object kind is skipped, not rejected, and counted in `diagnostics.objectsIgnored`; a nonzero count means the payload has a kind this version does not recognise, not that something failed.

> **Beta caveats, worth knowing before you deploy.** Payload signing does not exist on this channel yet, so delivery is TLS-only and the content hash establishes self-consistency, not origin authenticity. The FDv2 protocol is opt-in per account: without it the endpoints return HTTP 403, which the store reports as a fatal error explaining what to do. `ld-relay` does not speak the FDv2 endpoints, so relay-only deployments cannot receive skills.

**If every skill comes back empty, check `diagnostics.hashlessObjects`.** Objects without a `contentHash` are withheld, so a nonzero count means skills are being withheld, not that the environment has none. The count is cumulative, not the current size of the withheld set. The store logs an error per hashless object, plus a summary when its contents become wholly hashless or the withheld set changes (not repeated for an unchanged re-delivery). There is no fallback that skips verification.

#### Observability: integrity failures are logged for your SIEM

A skill that fails integrity verification is **withheld**: the accessor returns `null`, `writeSkills` reports an `error` action, and no unverified byte reaches your agent. Each failure also writes one machine-parseable line to `console.error`:

```text
[LaunchDarkly] ld.skills.integrity_failure {"action":"withheld","event":"ld.skills.integrity_failure","expected_hash":"5f2b...","language":"typescript","observed_hash":"9c14...","reason":"content hash mismatch","reason_code":"hash_mismatch","skill_key":"pdf-extraction","version":2}
```

The line is a `[LaunchDarkly] ` prefix, the event name, a space, and one JSON object. To ingest it, match `ld.skills.integrity_failure` and parse from the first `{`.

**The record is written regardless of telemetry configuration.** It is not sampled, batched, or dependent on a LaunchDarkly connection. If you send LaunchDarkly nothing, this record is your complete detection surface for tampered or malformed skill content.

**`ld.skills.integrity_failure` is a stability commitment.** The event name will not be renamed, and no field will be renamed or removed, outside a major release with a changelog entry.

| Field | Always present | Value |
|---|---|---|
| `event` | yes | `ld.skills.integrity_failure`. |
| `action` | yes | `withheld` — the content was not returned or written to disk. |
| `skill_key` | yes | The skill key **requested**, or `<invalid-key>` when the key itself failed validation. |
| `reason_code` | yes | A stable token from the vocabulary below. Alert on this, not on `reason`. |
| `reason` | yes | Human-readable detail, including byte counts. Wording may change between releases. |
| `language` | yes | `typescript`. The Python SDK emits the same record with `python`. |
| `served_key` | no | Only on `key_mismatch`: the key the store answered under, redacted like `skill_key`. |
| `served_version` | no | Only on `version_mismatch`: the version the store answered with, as an integer, or `<invalid-version>`. Never on the same record as `served_key`. |
| `version` | no | The delivered version, or on `version_mismatch` the version **requested**. Always an integer. Omitted when not an integer >= 1, and on `key_mismatch`. |
| `expected_hash` | no | The delivered `contentHash`, or `<not-a-sha256-digest>` when it was not 64 lowercase hex characters. Omitted when the failure happened before any hash was read. |
| `observed_hash` | no | The sha256 this SDK computed. Omitted when the failure happened before hashing. |

Optional fields are **omitted, never null**, so an absent `observed_hash` means no hash was computed. The record never contains skill content, filesystem paths, or credentials; the key and expected hash are shape-checked and replaced with the placeholders above when malformed, so a hostile store cannot use the log line to exfiltrate a skill body.

| `reason_code` | What happened |
|---|---|
| `not_an_object` | The store served something that is not an object. |
| `invalid_key` | The key does not match `^[a-z0-9][a-z0-9-]*$` within 256 characters. |
| `invalid_version` | The version is not an integer >= 1. |
| `missing_content` | `content` is absent or not a string. |
| `missing_content_hash` | `contentHash` is absent or not a string. |
| `not_utf8` | The content has no UTF-8 encoding (a lone surrogate), so there are no bytes LaunchDarkly could have hashed. |
| `over_size_cap` | The content exceeds the internal `MAX_SKILL_CONTENT_BYTES` cap, whatever it hashes to. The reason string names the bound. |
| `hash_mismatch` | The content does not hash to the delivered `contentHash`. |
| `key_mismatch` | The store answered under a different key than requested. Adds `served_key`; records **no** `AgentControl Skill Integrity Failure` signal. |
| `version_mismatch` | The store answered a version pin with a different version. Adds `served_version` (`version` is the one requested); records **no** `AgentControl Skill Integrity Failure` signal. Reported to callers as `wrong_version`. |

These ten tokens are the whole vocabulary. The Python SDK emits the same ten for the same conditions, with identical JSON key order, so one parser and one alert rule cover both.

**Page on `hash_mismatch`.** It means content and its declared digest disagree, a possible sign of **active tampering** in transit, in a cache, or in whatever backs your `SkillStore`. Most other codes indicate a malformed store, a bad deployment, or a truncated response. If all your content comes from LaunchDarkly, `over_size_cap` and `not_utf8` should never occur and are worth alerting on too.

**`key_mismatch` and `version_mismatch` skip the product signal.** Both are detected after verification passes, and the usual cause is a bug in a custom `SkillStore` adapter (a stale cache entry, a colliding key, a wrong index lookup) rather than tampering, so neither inflates LaunchDarkly's integrity counter. Both still write this record, so a rule on `ld.skills.integrity_failure` catches them. Neither is reachable through `FDv2SkillStore`, so if it is your only store, treat them like `hash_mismatch`; behind a custom adapter, suspect the adapter first.

`getSkill` returns `null` for a `version_mismatch` like any other failure, so this record is the only place it is visible unless you use `getSkillResult`, which reports it as the `wrong_version` outcome (below).

#### Fail closed on tampering: `getSkillResult`

The log record is for operators; `getSkillResult` is for your application. It runs the same retrieval and verification as `getSkill`, but reports which of five outcomes happened instead of collapsing them all to `null`.

```ts
import { getSkillResult } from '@launchdarkly/ai-server';

const outcome = await getSkillResult('pdf-extraction', { version: 2 });

switch (outcome.reason) {
  case 'ok':
    return outcome.skill; // non-null exactly here
  case 'integrity_failure':
    // Content and its declared digest disagreed, or the store answered under a
    // different key than requested. Treat skill delivery as tampered with.
    console.error(`refusing to start: ${outcome.detail}`);
    process.exit(1);
  case 'absent':
    // Nobody configured this skill, or it was revoked. Ordinary; carry on.
    return null;
  case 'wrong_version':
    // The store answered the pin with a *different* version. This also writes
    // an `ld.skills.integrity_failure` record for your SIEM.
    return null;
  case 'store_unavailable':
    // The store could not answer. An outage, not a revocation — retry or run
    // degraded.
    return null;
}
```

| `reason` | `skill` | What happened |
|---|---|---|
| `ok` | the skill | Retrieved and verified. |
| `absent` | `null` | The store holds nothing under that key: not configured, not yet delivered, or revoked. |
| `integrity_failure` | `null` | Content was delivered and did not verify, or the store answered under a different key (`reason_code: key_mismatch`), so it was withheld. **The one to fail closed on.** |
| `store_unavailable` | `null` | The store threw. Nothing was retrieved, so nothing is known either way. An outage, not a deletion. |
| `wrong_version` | `null` | A version was pinned and the store answered with a different one, so the answer was withheld. Also logged, as `reason_code: version_mismatch`. |

`detail` is human-readable and safe to log or show an operator: it names the key, the requested and held versions, and the failure category, never skill content or a filesystem path. It is `null` for `ok`. Branch on `reason`, not `detail`.

**`getSkill` is unchanged.** It still resolves to `null` for all four failures and rejects only when no store is configured. Both accessors run the same lookup and verification; `getSkillResult` adds no second log record or signal, so switching to it does not double-count anything.

`getSkills` and `allSkills` have no outcome-reporting form: they omit entries they could not return. Use `getSkillResult` per key when you need the reason.

#### Privilege separation: the agent must not be able to rewrite its own skills

**Run `writeSkills` as a different identity than the agent.** Reconcile as one user, run the agent as another. The reconcile sets modes explicitly rather than from the process umask: skill files and the manifest at `0644` (applied to the open file handle, so it cannot be redirected), per-skill `<root>/<key>/` directories at `0755`, and never the execute bit. Those modes only protect anything if the two identities differ.

**What to verify, as the identity that will run the agent.** The SDK cannot check this for you (see below), so make it a deployment step. The agent's identity must have no write access to:

- the managed root itself,
- the per-skill directories `<root>/<key>/` and the files `<root>/<key>/SKILL.md`,
- the manifest at `<root>/.launchdarkly-skills.json`,
- **the root's parent, and every ancestor directory above it.** Write access there lets the root be renamed aside and replaced with a symlink, redirecting the agent's own skill lookups to a directory the agent controls, and on macOS and Windows the reconcile's writes and deletes as well. In the layout `<app>/.claude/skills` the parent is `.claude`, which an agent identity is likely to own.

```bash
# Run as the agent's user. Every line should print DENIED.
root=.claude/skills
targets="$root $root/.launchdarkly-skills.json $root/*/ $root/*/SKILL.md"

# Every ancestor of the root, up to /: write access to any of them is enough to
# swap the root itself for a symlink.
ancestor=$(dirname "$(cd "$(dirname "$root")" && pwd)/$(basename "$root")")
while :; do
  targets="$targets $ancestor"
  [ "$ancestor" = / ] && break
  ancestor=$(dirname "$ancestor")
done

for target in $targets; do
  [ -e "$target" ] || continue
  if [ -w "$target" ]; then echo "WRITABLE — fix this: $target"; else echo "DENIED: $target"; fi
done
```

The managed root's own mode is **yours, not the SDK's**: `writeSkills` creates only that leaf directory, with the process umask, because you chose the path. `chown reconcile-user:agent-group` and `chmod 0755` on the root is what makes the rest of the tree's modes meaningful, and it is what denies the macOS and Windows race described under *Security posture*.

**Why this is the mitigation that matters.** A `SKILL.md` is agent *instructions*: an agent that can write its skills directory can rewrite its own instructions, and an agent handling untrusted input may be induced to. The manifest is more sensitive still, because it tells the next reconcile which paths the SDK owns and may delete; editing it can keep a revoked skill or aim the SDK's delete at something else. `writeSkills` re-validates every manifest entry as untrusted input, but an agent that cannot edit it at all is the stronger position.

Ancestors matter for the same reason. An identity that can rename a directory above the root can substitute the whole tree, with no race involved, and the agent then loads skills it wrote itself. Descriptor pinning inside `writeSkills` cannot prevent that, because the substituted tree is what the agent reads.

**The SDK does not report whether the root is writable.** It knows only its own identity, which just wrote there. It cannot know which identity will run the agent, so any check would answer the wrong question and look like reassurance where caution is needed.

---

### Utility Helpers

```ts
import { parseTemplate, parseJSONWithPossibleFences } from '@launchdarkly/ai-server';

// Replaces {{variable}} placeholders, supports dot-notation ({{user.name}})
const prompt = parseTemplate('Hello, {{name}}!', { name: 'Alice' });

// Parses JSON that may be wrapped in ```json fences
const data = parseJSONWithPossibleFences<{ score: number }>(modelOutput);
```

## Shared Types

All types are re-exported from this package. Handler packages import them from here and never redefine them.

| Type | Description |
|---|---|
| `AiConfigRep` | The AI configuration object fetched from a LaunchDarkly flag variation |
| `Tool` | A tool definition (name, description, JSON Schema parameters) |
| `ProviderHandler` | The callable type that all handler packages produce |
| `ProviderResponse` | The value returned to callers: `{ response, usage, trackData, judgeResults?, judgeTasks? }`. `judgeResults` is populated when `skipJudges` is `false`; `judgeTasks` (a `JudgeTask[]`) is populated when `skipJudges: true`. |
| `ConfigArgs` | Arguments accepted by `config()` (key, handler, toolHandlers, registry) |
| `LDVariationMeta` | LaunchDarkly metadata on a flag variation (enabled, variationKey, version, mode) |
| `LDContext` | Owned by this package (structurally compatible with all LD SDK versions). Import from `@launchdarkly/ai-server` instead of directly from the LD SDK. |
| `LDClientInterface` | Minimal interface `(variation, track, flush, close)` that any LD SDK client satisfies structurally. Returned by `initClient()` and `getClient()`. |
| `GraphOptions` | Options accepted by `graph()` (handlers, toolHandlers, graphJudge — no context) |
| `GraphArgs` | Options accepted by `resolveGraph()` — extends `GraphOptions` with a required `context` |
| `GraphDefinition` | A resolved agent graph: topology accessors, `runNode`, and the traverse primitives |
| `GraphNode` / `GraphEdge` | A node (evaluated agent config + edges) and a directed edge (with handoff data) |
| `ProviderGraphResponse` | The value returned by `graph(...).invoke()`: `{ response, usage, judgeResults? }` |
| `GraphStreamEvent` | Events yielded by `graph(...).stream()`: `node_start` / `chunk` / `node_done` / `handoff` / `done` |
| `GraphTopology` | The parsed graph flag shape (`root` + `edges`) |
| `Skill` | A verified skill document: `key`, `version`, `content` (`Uint8Array` — the verified verbatim bytes), `contentHash`, `name`, `description` |
| `SkillReference` | A version-pinned pointer to a skill: `{ key, version }` |
| `SkillOutcome` | What `getSkillResult()` resolves to: `{ skill, reason, detail }`. `skill` is non-null exactly when `reason` is `'ok'` |
| `SkillOutcomeReason` | The closed set of retrieval outcomes: `'absent' \| 'integrity_failure' \| 'ok' \| 'store_unavailable' \| 'wrong_version'` |
| `SkillStore` | The structural seam skill content is retrieved through: `getObject(kind, key, version?)`, `allObjects`, optional `isInitialized()`, `addListener` / `removeListener`. A store without `isInitialized()` is treated as initialized. |
| `RawSkillObject` | The wire shape a `SkillStore` serves, before verification. Every field is untrusted. |
| `ReconcileReport` | The result of `writeSkills()`: `{ actions, ok, errors }` |
| `ReconcileAction` | One outcome from a reconcile: `{ key, action, version, path, error }` |
| `ReconcileActionKind` | The closed set of reconcile outcomes: `'written' \| 'updated' \| 'skipped_current' \| 'removed' \| 'error'` |
| `OnUnavailable` | `'keep' \| 'raise'` — how `writeSkills` reacts to content it could not retrieve |
| `WriteSkillsOptions` | Options accepted by `writeSkills()` (`prune`, `timeout` in seconds, `onUnavailable`) |
| `WatchSkillsOptions` | `WriteSkillsOptions` plus `debounceMs` (milliseconds) and `onReconcile` — what `watchSkills()` accepts |
| `FDv2Mode` | `'stream' \| 'poll'` — the `mode` option of `FDv2SkillStore` |
| `FDv2SkillStoreOptions` | Options accepted by the `FDv2SkillStore` constructor (`mode`, `baseUri`, `streamUri`, `pollIntervalMs`, `readTimeoutMs`, `initialBackoffMs`, `maxBackoffMs`) |
| `StoreDiagnostics` | The read-only counters `FDv2SkillStore.diagnostics` returns |
