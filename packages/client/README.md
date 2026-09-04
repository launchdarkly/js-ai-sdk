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

await shutdown();
```

Routing is by each node config's `provider.name` + `meta.mode`, so a single graph can mix providers when you pass multiple handlers. Provider packages also export a single-provider convenience (e.g. `claudeGraph`, `openaiGraph`, `langchainGraph`) that pre-binds their handler.

`resolveGraph(key, options)` returns a `GraphDefinition` without executing it. It still requires `context` at resolution time (it has no deferred `.invoke()`). The definition carries `.enabled` so you can branch on a disabled graph before traversing. `graph(...).invoke()` throws if the graph is disabled.

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

Agent Skills are versioned `SKILL.md` documents managed in LaunchDarkly, attachable to AI Config variations by reference. This package surfaces which skills a config references, retrieves their content, and materializes them onto disk where agent runtimes (the Claude Agent SDK and friends) can discover them.

**Everything below runs against the `SkillStore` seam**, and the shipped default is *absent*, so the accessors throw an actionable error until a store is configured. `InMemorySkillStore` is provided for local development, tests, and bring-your-own-content; `FDv2SkillStore` is the delivery transport that receives content from LaunchDarkly — see [Receiving skills from LaunchDarkly](#receiving-skills-from-launchdarkly).

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
// hex, over the verbatim UTF-8 bytes of `content` — content that does not hash
// to it is withheld, so this is not a field to hand-wave.
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
// `Skill.content` is a Uint8Array — the verified verbatim bytes, exactly what
// was hashed. The SDK never interprets them; decode or parse them yourself.
const newest = await getSkill('pdf-extraction'); // newest available
const pinned = await getSkill('pdf-extraction', { version: 2 }); // exact version, or null
const batch = await getSkills(refs); // input order; misses omitted
// `getSkill` returns null for four different reasons. When you need to tell them
// apart — to fail closed on suspected tampering — ask for the outcome instead.
const outcome = await getSkillResult('pdf-extraction', { version: 2 });
if (outcome.reason === 'integrity_failure') throw new Error(outcome.detail ?? 'withheld');
const everything = await allSkills();
const text = new TextDecoder().decode(newest?.content); // if you want a string

// Materialize onto disk at <root>/<key>/SKILL.md. Only the leaf directory is
// ever created, so `.claude` must already exist — a typo in the path is an
// error, not an invitation to scatter a directory tree.
const report = await writeSkills(refs, '.claude/skills');
if (!report.ok) {
  for (const action of report.errors) {
    console.error(`skill ${action.key}: ${action.error}`);
  }
}
```

`writeSkills` is a **reconcile**, not a copy. It records what it wrote in `<root>/.launchdarkly-skills.json` and only ever overwrites or deletes paths that manifest lists under a matching key — a file you placed yourself is reported as an error and left alone. Revocation is pruning: a skill absent from the resolved set is removed on the next run.

One narrow exception keeps that conservatism from becoming a trap. The manifest is written atomically, once, last, so a process killed after a skill file lands but before that write would leave the file at a managed path with no manifest entry — which is exactly what an unmanaged collision looks like, so every later reconcile would refuse it and the skill would stay stuck. So a colliding file whose bytes **already are** the resolved content is adopted: recorded in the manifest and reported `skipped_current`, and a crashed reconcile heals itself on the next run. Nothing is overwritten, because nothing needs to be — the only file ever adopted is one that is already byte-identical to what LaunchDarkly resolved. A file whose bytes differ, or one that cannot be read at all, is still refused and left untouched.

```ts
// Everything the store holds, materialized at boot.
const report = await writeSkills('*', '.claude/skills', {
  prune: true,          // default — remove formerly-managed skills no longer resolved
  timeout: 10,          // SECONDS, not milliseconds (cross-language contract)
  onUnavailable: 'keep', // 'keep' reports a failed retrieval; 'raise' throws
});
```

**Know what `'*'` asks for.** It materializes the **whole project library**, which puts every
skill's `description` into the agent's context — including skills no AI Config references and
skills belonging to other teams. `writeSkills(skillRefs(config), root)`, the form used in the
example above, materializes only what the resolved variation actually asked for. Reach for
`'*'` when you genuinely want the entire library on disk.

| Export | Description |
|---|---|
| `skillRefs(config)` | Project a config's `skills` array into typed `SkillReference[]`. Pure — no client, no store, no telemetry. `[]` when absent. |
| `getSkill(key, { version? })` | One verified skill. Omit `version` for the newest available. Resolves to `null` for not-found or a version mismatch; throws only when no store is configured. |
| `getSkillResult(key, { version? })` | The same retrieval as `getSkill`, reported instead of collapsed. Resolves to `{ skill, reason, detail }`, where `reason` is one of `ok` / `absent` / `integrity_failure` / `store_unavailable` / `wrong_version`. Throws only when no store is configured — same as `getSkill`. See [fail closed on tampering](#fail-closed-on-tampering-getskillresult). |
| `getSkills(refs)` | Batch form. Accepts `SkillReference` values and bare key strings (string = latest). Results follow input order; missing or unverifiable entries are omitted. |
| `allSkills()` | Every verified skill the store holds. |
| `writeSkills(skills, root, options?)` | Materialize to `<root>/<key>/SKILL.md`. Accepts `Skill` / `SkillReference` / key strings, or the literal `'*'`. Returns a `ReconcileReport`. Throws for a caller error — an unusable `root`, a bare string other than `'*'` — as distinct from the per-skill `error` actions in the report. |
| `InMemorySkillStore` | A `SkillStore` backed by a plain object. `put(raw)`, `getObject(kind, key, version?)`, `allObjects(kind)`, `addListener(kind, fn)`. Holds one object per key, so it answers a version pin with what it has and lets the accessor refuse a mismatch. |
| `FDv2SkillStore(sdkKey, options?)` | The delivery transport: a `SkillStore` fed by LaunchDarkly over the SDK-facing FDv2 channel. `start()`, `waitForSkills(timeoutMs)`, `close()`, `diagnostics`, `failed`. **Server-side only** — a mobile key or client-side environment ID throws. See [Receiving skills from LaunchDarkly](#receiving-skills-from-launchdarkly). |
| `watchSkills(skills, root, options?)` | `writeSkills` plus a re-reconcile on every delivery change. Resolves to `{ report, watcher }`; `await watcher.close()` when done. Revocation then takes effect within `debounceMs` of arriving rather than at the next restart. |

#### Receiving skills from LaunchDarkly

`InMemorySkillStore` is for tests and bring-your-own-content. In production, skill content arrives through `FDv2SkillStore`, which speaks LaunchDarkly's SDK-facing FDv2 delivery channel — the same `GET /sdk/poll` and `GET /sdk/stream` endpoints the base SDK's FDv2 data source uses, authenticated with the environment's server-side SDK key.

```ts
import { FDv2SkillStore, initClient, watchSkills } from '@launchdarkly/ai-server';

const store = new FDv2SkillStore(process.env.LD_SDK_KEY!).start();
await store.waitForSkills(10_000);
await initClient({ skillStore: store });

// Materialize now, and re-materialize whenever delivery changes.
const { report, watcher } = await watchSkills('*', '.claude/skills');
try {
  // ...
} finally {
  await watcher.close();
  await store.close();
}
```

**Nothing above the store changes.** The accessors, integrity verification, and `writeSkills` are transport-agnostic: they see raw objects through the `SkillStore` seam and cannot tell which store produced them. Everything documented above about verification and reconcile semantics applies unchanged.

**Server-side only.** Skills are for server-side agent runtimes and skill content is customer-confidential. A mobile key (`mob-…`) or a client-side environment ID throws from the constructor.

**Streaming is the default, and it is what makes revocation fast.** A `delete-object` reaches a live stream in seconds; with `mode: 'poll'` it arrives within one `pollIntervalMs`. Paired with `watchSkills`, a revoked skill's `SKILL.md` leaves the disk without a restart. During an outage the store keeps serving the last content it received and `writeSkills`' default `onUnavailable: 'keep'` leaves managed files alone — an outage must not read as "everything was revoked".

**The connection also carries your flags.** A client cannot request only the skill payload, so a skills-enabled environment delivers flag and segment objects on the same connection. They are skipped, not evaluated — this store does no evaluation of any kind — and `diagnostics.objectsIgnored` counts them.

> **Beta caveats, worth knowing before you deploy.** Payload signing does not exist on this channel yet, so delivery is TLS-only and the content hash establishes self-consistency, not origin authenticity. FDv2 is opt-in per account: without it the endpoints return HTTP 403, which the store reports as a fatal error naming the setting. `ld-relay` does not speak the FDv2 endpoints, so relay-only deployments cannot receive skills.

**If every skill comes back empty, check `diagnostics.hashlessObjects`.** Verification requires `contentHash` on the delivered object and withholds anything without one, so a nonzero count there means skills are being withheld rather than that the environment has none. The store logs an error per hashless object and one summary per wholly-hashless payload, both naming the reason. There is deliberately no fallback that skips verification: a hash the SDK computed from the content it was handed would certify the content against itself.

| Export | Description |
|---|---|
| `createSkill(init)` / `createSkillReference(init)` | Build frozen `Skill` / `SkillReference` values. Use `createSkill` to hand `writeSkills` content you already have. |
| `createSkillOutcome(init)` | Build a frozen `SkillOutcome`. Exported for tests and for wrapping your own retrieval in the same shape. |
| `SKILL_OBJECT_KIND` | `'skill'` — the delivery object kind. |
| `SKILL_FILENAME` | `'SKILL.md'`. |
| `MANIFEST_FILENAME` | `'.launchdarkly-skills.json'` — add this to your `.gitignore` if you do not commit materialized skills. |
| `MANIFEST_VERSION` | `1`. |
| `MAX_SKILL_CONTENT_BYTES` | `65536` — the hard cap. Content above it is refused as inauthentic. |

`ReconcileReport` exposes `actions`, `ok` (true iff no action is an `error`), and `errors` (the error actions, in order), so callers never re-derive the filter. Each `ReconcileAction` carries `key`, `action` (`written` | `updated` | `skipped_current` | `removed` | `error`), and nullable `version` / `path` / `error`. A failure belonging to the whole run rather than one skill — a corrupt manifest, for instance — carries the **empty string** in `key`.

**Security posture.** `writeSkills` is writing LaunchDarkly-delivered content to your disk, so it fails closed: skill keys are re-validated locally, content is hash-verified again immediately before writing, writes go through a temp file in the target's own directory and an atomic rename at mode `0644`, symlinked roots/directories/targets are refused, a target that is not a regular file (a FIFO, a device node) is refused rather than read, and a corrupt manifest suppresses every destructive action. One limitation is worth stating plainly, and it is a platform bound rather than a detail: Node exposes no `renameat`/`unlinkat`/`openat`, so no destructive step can be performed relative to a pinned directory descriptor. Every check here is therefore a per-component `lstat` taken immediately before the path-based operation — a check-then-use race, not a closed window — and unlike the Python SDK, which closes that window on POSIX by holding a descriptor opened `O_RDONLY|O_DIRECTORY|O_NOFOLLOW` for the whole reconcile, **this floor is what runs on every platform Node supports, Linux included.** An attacker who already has **write permission on the managed root** can therefore win a race to redirect a write or a delete outside it. Windows adds nothing worse and nothing better: reparse-point checks (`GetFileAttributesW` / `FILE_FLAG_OPEN_REPARSE_POINT`) are deliberately not implemented in this release, and Windows is not a tested platform for it — neither SDK repository has a Windows CI runner. So write permission on the managed root is *the* security boundary here. Keep it writable only by the identity running the reconcile — see [privilege separation](#privilege-separation-the-agent-must-not-be-able-to-rewrite-its-own-skills).

**Two constraints on skill keys, imposed here rather than by the data model.** A key becomes a single directory name, so `writeSkills` rejects — as a reported `error` action, on every platform — a key over 255 bytes and the 22 Windows reserved device names (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`). Both are checked in the filesystem layer only: a key like `aux` remains valid everywhere else, so an AI Config referencing it still parses and its other skills still materialize. One residual the SDK cannot check for you: the 255-byte bound is per *path component*, not on the total path, so `<root>/<key>/SKILL.md` can still exceed Windows' 260-character `MAX_PATH` if the root is deep and the key is long. The root is yours, so budget for it there.

**Skill content is opaque to the SDK.** A verified `Skill` carries `content` as a `Uint8Array` — the exact bytes that were hashed — and the SDK never parses, decodes, or interprets it anywhere. There is deliberately no frontmatter accessor and no YAML dependency: a consumer that wants the frontmatter decodes the bytes and parses them itself, with whatever parser and bounds it trusts.

**No LaunchDarkly telemetry is emitted for skills.** Signals go through an internal no-op emitter; `client.track()` is never called and no LD context is involved.

#### Observability: integrity failures are logged for your SIEM

A skill that fails integrity verification is **withheld** — the accessor returns `null`, `writeSkills` reports an `error` action, and no unverified byte reaches your agent. Every failure additionally writes one line to `console.error` in a fixed, machine-parseable shape, so that withholding is *detectable* and not merely correct:

```text
[LaunchDarkly] ld.skills.integrity_failure {"action":"withheld","event":"ld.skills.integrity_failure","expected_hash":"5f2b...","language":"typescript","observed_hash":"9c14...","reason":"content hash mismatch","reason_code":"hash_mismatch","skill_key":"pdf-extraction","version":2}
```

The line is a `[LaunchDarkly] ` prefix, the event name, a space, and a single JSON object. To ingest it: match `ld.skills.integrity_failure`, take everything from the first `{`, parse it.

**The record is written regardless of how you configure telemetry.** It is not sampled, not batched, and not conditional on a LaunchDarkly connection — no LaunchDarkly telemetry is emitted for skills at all. If you send LaunchDarkly nothing, this log record is your complete detection surface for tampered or malformed skill content.

**`ld.skills.integrity_failure` is a stability commitment.** The event name will not be renamed, and no field will be renamed or removed, outside a major release with a changelog entry. It is safe to build an alert on.

| Field | Always present | Value |
|---|---|---|
| `event` | yes | `ld.skills.integrity_failure`. |
| `action` | yes | `withheld` — what the SDK did about it. Content that fails verification is never returned and never written to disk. |
| `skill_key` | yes | The skill key, or `<invalid-key>` when the key itself failed validation. Keys arrive from the wire, so one is never echoed verbatim. |
| `reason_code` | yes | A stable token from the closed vocabulary below. Alert on this field, not on `reason`. |
| `reason` | yes | Human-readable detail, including byte counts. Wording may change between releases. |
| `language` | yes | `typescript`. Distinguishes SDKs in a polyglot fleet; the Python SDK emits the same record with `python`. |
| `version` | no | The skill version. Omitted when the delivered version was not an integer >= 1. |
| `expected_hash` | no | The `contentHash` delivered with the content, or `<not-a-sha256-digest>` when it was not 64 lowercase hex characters. Omitted when the failure happened before any hash was read. |
| `observed_hash` | no | The sha256 this SDK computed locally. Omitted when the failure happened before hashing. |

Optional fields are **omitted, never null** — the absence of `observed_hash` means no hash was computed, which is itself information. Skill content, filesystem paths, and credentials never appear in the record; the key and the expected hash are shape-checked and replaced with the placeholders above when they do not look like what they claim to be, so a hostile store cannot use the log line to exfiltrate a skill body.

| `reason_code` | What happened |
|---|---|
| `not_an_object` | The store served something that is not an object. |
| `invalid_key` | The key does not match `^[a-z0-9][a-z0-9-]*$` within 256 characters. |
| `invalid_version` | The version is not an integer >= 1. |
| `missing_content` | `content` is absent or not a string. |
| `missing_content_hash` | `contentHash` is absent or not a string. |
| `not_utf8` | The content has no UTF-8 encoding (a lone surrogate), so there are no bytes LaunchDarkly could have hashed. |
| `over_size_cap` | The content exceeds `MAX_SKILL_CONTENT_BYTES`, so it is inauthentic whatever it hashes to. |
| `hash_mismatch` | The content does not hash to the `contentHash` delivered alongside it. |

These eight tokens are the whole vocabulary, and the Python SDK emits the same eight for the same conditions — including identical JSON key order — so one parser and one alert rule cover a polyglot fleet.

#### Fail closed on tampering: `getSkillResult`

The log record above is the *operator's* view. Your application gets the same distinction programmatically from `getSkillResult`, which returns the outcome instead of collapsing it:

```ts
import { getSkillResult } from '@launchdarkly/ai-server';

const outcome = await getSkillResult('pdf-extraction', { version: 2 });

switch (outcome.reason) {
  case 'ok':
    return outcome.skill; // non-null exactly here
  case 'integrity_failure':
    // Content and its declared digest disagreed. Do not proceed on a fallback:
    // the safe interpretation is that skill delivery is being tampered with.
    console.error(`refusing to start: ${outcome.detail}`);
    process.exit(1);
  case 'absent':
    // Nobody configured this skill, or it was revoked. Ordinary; carry on.
    return null;
  case 'wrong_version':
    // The pinned version is not what the store holds — a rollout skew, usually.
    return null;
  case 'store_unavailable':
    // The store could not answer. An outage, not an answer of "no" — retry or
    // run degraded, but do not treat it as a revocation.
    return null;
}
```

| `reason` | `skill` | What happened |
|---|---|---|
| `ok` | the skill | Retrieved and verified. |
| `absent` | `null` | The store holds nothing under that key. Not configured, not yet delivered, or revoked. |
| `integrity_failure` | `null` | Content failed verification and was withheld. The `ld.skills.integrity_failure` record above was written for the same failure. |
| `wrong_version` | `null` | A version was pinned and the store answered with a different one. |
| `store_unavailable` | `null` | The store threw. Nothing was retrieved, so nothing is known either way. |

`detail` carries the human-readable reason for every non-`ok` outcome and is `null` for `ok`. It is safe to log or surface: it names the key, the requested and held versions, and the failure category, and never skill content or a filesystem path.

**`getSkill` is unchanged.** It still resolves to `null` for all four failure outcomes and still rejects only when no store is configured — no existing caller has to change anything. The two accessors run the identical lookup and the identical verification, and differ *only* in what they report: `getSkill` gives you the skill or `null`, `getSkillResult` also gives you the reason. Nothing is retried, cached, or logged twice — by the time either returns, an integrity failure has already written its record — so reaching for `getSkillResult` costs nothing but the wider return type.

These five tokens are the whole vocabulary, and the Python SDK publishes the same five for the same conditions. There is deliberately no batch equivalent: `getSkills` and `allSkills` still omit entries they could not return, so call `getSkillResult` per key where the outcome matters.

**`hash_mismatch` deserves a page, not a dashboard.** The other codes are consistent with a malformed store, a bad deployment, or a truncated response. `hash_mismatch` means content and its declared digest disagree, which is the shape of active tampering with skill delivery — in transit, in a cache, or in whatever backs your `SkillStore`. If you serve skill content only from LaunchDarkly, `over_size_cap` and `not_utf8` warrant alerts on the same reasoning: neither should ever occur.

#### Privilege separation: the agent must not be able to rewrite its own skills

**The recommended deployment runs `writeSkills` as a different identity than the agent.** Reconcile as one user, run the agent as another. Everything the reconcile puts on disk is owner-write-only, and set explicitly rather than inherited from the process umask: skill files and the manifest at `0644` (applied to the open file handle, so it cannot be redirected), the per-skill `<root>/<key>/` directories at `0755`, and the execute bit never set on anything. Those modes are only a defense if the two identities actually differ — under a single identity they describe a directory the agent can freely rewrite.

**What to verify, as the identity that will run the agent.** The SDK cannot check this for you (see below), so make it a deployment step: confirm the agent's identity has no write access to

- the managed root itself,
- the per-skill directories `<root>/<key>/` and the files `<root>/<key>/SKILL.md`,
- the manifest at `<root>/.launchdarkly-skills.json`.

```bash
# Run as the agent's user. Every line should print DENIED.
root=.claude/skills
for target in "$root" "$root/.launchdarkly-skills.json" "$root"/*/ "$root"/*/SKILL.md; do
  [ -e "$target" ] || continue
  if [ -w "$target" ]; then echo "WRITABLE — fix this: $target"; else echo "DENIED: $target"; fi
done
```

The managed root's own mode is **yours, not the SDK's**: `writeSkills` creates only that one leaf directory, and does so with the process umask, precisely because the root is a path you chose. Own it — `chown reconcile-user:agent-group` plus `chmod 0755` on the root is the shape that makes the rest of the tree's modes mean something. It is also the mitigation for the race described under *Security posture* above: that race requires write permission on the managed root, which privilege separation is what denies.

**Why this is the mitigation that matters.** A `SKILL.md` is agent *instructions*. An agent that can write its own skills directory can rewrite its own instructions, and an agent processing untrusted input is exactly the thing that might be induced to do so. Write access to the manifest is worse than write access to a skill, because the manifest is what tells the *next* reconcile which paths the SDK owns and may delete: an agent that can edit it can keep a skill LaunchDarkly has revoked, or aim the SDK's own delete path at something it should not touch. `writeSkills` re-validates every manifest entry from scratch for exactly that reason — it treats that file as untrusted input, never as authorization — but an agent that cannot edit it at all is the stronger position, and only your deployment can provide that.

**The SDK deliberately does not report whether the root is writable.** There is no such field on `ReconcileReport`, and its absence is a decision rather than an oversight. The SDK knows only its own identity, which trivially has write access — it just wrote there. It cannot know which identity will later run the agent, so any check it could make would answer a different question than the one that matters, and would read as reassurance exactly where caution is wanted. You know both identities; the SDK knows one.

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
| `ProviderGraphResponse` | The value returned by `graph(...).invoke()`: `{ response, usage, trackData, judgeResults? }` |
| `GraphTopology` | The parsed graph flag shape (`root` + `edges`) |
| `Skill` | A verified skill document: `key`, `version`, `content` (`Uint8Array` — the verified verbatim bytes), `contentHash`, `name`, `description` |
| `SkillReference` | A version-pinned pointer to a skill: `{ key, version }` |
| `SkillOutcome` | What `getSkillResult()` resolves to: `{ skill, reason, detail }`. `skill` is non-null exactly when `reason` is `'ok'` |
| `SkillOutcomeReason` | The closed set of retrieval outcomes: `'absent' \| 'integrity_failure' \| 'ok' \| 'store_unavailable' \| 'wrong_version'` |
| `SkillStore` | The structural seam skill content is retrieved through: `getObject(kind, key, version?)`, `allObjects`, optional `addListener` |
| `RawSkillObject` | The wire shape a `SkillStore` serves, before verification. Every field is untrusted. |
| `ReconcileReport` | The result of `writeSkills()`: `{ actions, ok, errors }` |
| `ReconcileAction` | One outcome from a reconcile: `{ key, action, version, path, error }` |
| `ReconcileActionKind` | The closed set of reconcile outcomes: `'written' \| 'updated' \| 'skipped_current' \| 'removed' \| 'error'` |
| `OnUnavailable` | `'keep' \| 'raise'` — how `writeSkills` reacts to content it could not retrieve |
| `WriteSkillsOptions` | Options accepted by `writeSkills()` (`prune`, `timeout` in seconds, `onUnavailable`) |
