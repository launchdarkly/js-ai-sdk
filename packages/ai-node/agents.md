# Agent Guide — `@launchdarkly/ai-node` (Node.js Convenience Wrapper)

This document describes the role, structure, and constraints of the `@launchdarkly/ai-node` package for AI agents and contributors.

---

## Role and Tier

**Tier 0 — Convenience wrapper.**

This package is a pure barrel that re-exports the entire public surface of `@launchdarkly/ai-server` and carries `@launchdarkly/node-server-sdk` as a hard (non-peer) dependency. No new logic lives here.

Its purpose: Node.js application developers install this single package and get both the LaunchDarkly AI SDK and the Node.js server SDK in one step, without managing `@launchdarkly/node-server-sdk` as a peer dependency themselves.

For edge runtimes (Vercel, Cloudflare Workers, Deno, etc.) use `@launchdarkly/ai-server` directly and pass a pre-initialized client to `initClient(client)` (the BYOC path).

---

## File Map

| File | Responsibility |
|---|---|
| `src/index.ts` | Single `export * from '@launchdarkly/ai-server'` — the entire public barrel |

---

## Public Exports

This package re-exports everything from `@launchdarkly/ai-server` and nothing else:

```ts
export * from '@launchdarkly/ai-server';
```

Every symbol available from `@launchdarkly/ai-server` is available from `@launchdarkly/ai-node` under the same name. No additional symbols are added. When `@launchdarkly/ai-server` gains a new export, this package automatically picks it up.

---

## Dependencies

| Dependency | Why |
|---|---|
| `@launchdarkly/ai-server` | The package being re-exported |
| `@launchdarkly/node-server-sdk` | Carried as a hard dep so consumers don't need to install it manually; auto-discovered by `initClient()` via dynamic import |

---

## OTel Setup

This package itself emits no spans. OTel is initialized and configured by `@launchdarkly/ai-server` (re-exported through this package) during `initClient()`.

Install the OTel packages alongside this package:
```sh
npm install @launchdarkly/ai-node @launchdarkly/ai-otel
```

`@launchdarkly/ai-otel` bundles the required OTel SDK packages. Once installed, OTel spans from all handler packages are automatically collected when `initClient()` runs.

For OTLP endpoint configuration see the [`@launchdarkly/ai-server` agents.md](../client/agents.md#otel-setup).

---

## `initClient()` — When to Call It

`initClient()` is re-exported from `@launchdarkly/ai-server`. Full details in the [`@launchdarkly/ai-server` agents.md](../client/agents.md#lifecycle-invariants).

**Short answer for Node.js apps:**

- **You don't need to call it** — lazy init runs automatically on the first `config().invoke()` call as long as `LD_SDK_KEY` is set.
- **Call it explicitly** when you need custom `serviceName`/`environment`, a custom OTLP endpoint, or want to pre-warm the connection before the first user request:
  ```ts
  import { initClient } from '@launchdarkly/ai-node';
  await initClient({ serviceName: 'my-service', environment: 'production' });
  ```
- **For edge runtimes (BYOC path)**, use `@launchdarkly/ai-server` directly and pass a pre-initialized client: `await initClient(myEdgeClient)`. Do not use this package for edge runtimes — it carries `@launchdarkly/node-server-sdk` as a hard dependency, which will not work on edge.

---

## Common Pitfalls

### 1. Do not add logic to this package

This package must remain a pure re-export barrel. Any new utility, type, or helper belongs in `@launchdarkly/ai-server`, not here. Adding logic here creates a maintenance burden and violates the single-responsibility principle — Node.js users would get behavior that non-Node consumers (who import `ai-server` directly) do not.

### 2. Do not import from both packages in the same application

Importing from both `@launchdarkly/ai-node` and `@launchdarkly/ai-server` in the same app can produce duplicate module instances if the dependency graph deduplication fails (e.g. mismatched semver ranges). Pick one: use `@launchdarkly/ai-node` for standard Node.js apps, `@launchdarkly/ai-server` for edge/custom runtimes. The `getClient()` singleton is process-wide and shared regardless of which package path you import through, but type mismatches from dual imports can confuse TypeScript.
