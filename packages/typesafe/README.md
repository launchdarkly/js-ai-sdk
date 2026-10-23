# `@launchdarkly/ai-typesafe`

Judge handler for [TypeSafe Jev](https://docs.system-one.dev/). A judge AI Config whose provider is `TypeSafe` is routed here. Judge mode already normalizes to `messages`, so the handler registers as `['TypeSafe', 'messages']`.

Jev does not return the `{score, reasoning}` JSON other judges use. The questions are the variation's `classifiers` list, sent as Jev `noul`, `choice`, and `score` questions. `extractTypesafeQuestions` is the only reader of that list.

Each label becomes its own `judgeResults` entry, keyed `judgeKey.labelKey`, and carries that label's `eventKey`. The entry's `response` is the selected label value. Every entry carries the full token usage of the one Jev call. LaunchDarkly token telemetry is recorded once for that call. Each label is tracked on its own `eventKey`.

The client reads `TYPESAFE_API_KEY` from the environment.

```ts
import { createTypesafeHandler } from '@launchdarkly/ai-typesafe';
import { config } from '@launchdarkly/ai-node';

const { invoke } = config({
  key: 'my-config',
  handler: createTypesafeHandler(),
});
```

Register it alongside the handler that produces the response being judged:

```ts
registry.register({
  handlers: [createClaudeMessagesHandler(), createTypesafeHandler()],
});
```
