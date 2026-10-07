# Agent Guide — `@launchdarkly/ai-typesafe`

This Tier 1 handler sends a judge config to TypeSafe Jev.

## Invariants

- Routing metadata is `['TypeSafe', 'messages']`. Judge mode normalizes to `messages`.
- Questions come only from `extractTypesafeQuestions`, which reads the variation's `classifiers` list.
- The handler does not append or request `{score, reasoning}` formatting. That block is stripped from `message_history` before it becomes Jev state.
- One `systemOne` call returns one result per label. The handler's `output` is `{"kind":"typesafe","results":[...]}`. The client expands that into `judgeResults`.
- Auth is `TYPESAFE_API_KEY`. The factory does not take a client or a key.
- No tools and no streaming.
- Telemetry is `invoke_agent` → `chat <model>`. Content is gated by `captureContent`.

## Files

- `src/questions.ts` — classifier extraction, state construction, and answer-to-score mapping.
- `src/handler.ts` — Jev call and spans.
- `src/index.ts` — package registration and exports.
- `src/version.ts` — release-please managed package identity.
