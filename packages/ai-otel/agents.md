# Agent Guide — `@launchdarkly/ai-otel` (OTel Dependency Bundle)

This document describes the role, structure, and constraints of the `@launchdarkly/ai-otel` package for AI agents and contributors.

---

## Role and Tier

**Tier 0 — Dependency bundle (no logic).**

This package has no source logic and exports nothing. Its sole purpose is to carry the seven OpenTelemetry packages that `@launchdarkly/ai-server` dynamically imports (via optional peer dependencies) as hard `dependencies`, so consumers need one `npm install` line instead of eight.

It is a sibling of `@launchdarkly/ai-node`: where `ai-node` bundles `@launchdarkly/node-server-sdk`, `ai-otel` bundles the OTel stack. The two packages are independent and can be installed together or separately.

---

## File Map

| File | Responsibility |
|---|---|
| `src/index.ts` | Comment-only barrel — exports nothing. Describes the package's purpose. |

---

## Public Exports

None. This package intentionally exports nothing. Users import the LaunchDarkly AI SDK through `@launchdarkly/ai-node` or `@launchdarkly/ai-server`.

---

## Dependencies

| Dependency | Why |
|---|---|
| `@opentelemetry/sdk-trace-node` | Node.js tracer provider used by `initClient()` |
| `@opentelemetry/sdk-trace-base` | Core span/tracer abstractions |
| `@opentelemetry/exporter-trace-otlp-http` | OTLP HTTP exporter for LaunchDarkly Observability |
| `@opentelemetry/otlp-exporter-base` | Base classes for OTLP exporters |
| `@opentelemetry/resources` | Resource attribute builder (`service.name`, `highlight.project_id`) |
| `@opentelemetry/context-async-hooks` | `AsyncLocalStorageContextManager` for async context propagation |
| `@opentelemetry/core` | W3C propagators and compression constants |

All seven are hard `dependencies` (not `peerDependencies`) so they are installed automatically with this package.

---

## Common Pitfalls

### 1. Do not add any exports to this package

Adding re-exports here would couple this package's API surface to whichever package it re-exports. Any LaunchDarkly AI exports belong in `@launchdarkly/ai-server`; any Node.js convenience wrapper belongs in `@launchdarkly/ai-node`.

### 2. This package is not appropriate for edge runtimes

The Node.js OTel SDK (`@opentelemetry/sdk-trace-node`) only works in a Node.js environment. Edge consumers should install `@launchdarkly/ai-server` directly and rely on the graceful-degradation path (the SDK emits a `console.warn` and continues with no-op spans).
