# CommonJS + Webpack integration test

Proves, from npm-shaped artifacts, what a CommonJS AWS Lambda bundled with Webpack can and cannot load today.

```bash
yarn test:integration
```

## What the harness does

1. `yarn build` at the repo root.
2. `npm pack` for `client`, `ai-node`, `ai-otel`, and `openai-messages` — the same tarball layout `npm publish` produces, so `"exports"` resolution is exercised exactly as a customer sees it.
3. Installs those tarballs plus Webpack 5.104.1, webpack-cli, and webpack-node-externals 3.0.0 (the versions reported in the incident) into `.staging/consumer`.
4. Bundles `fixture/handler.cjs` twice — once with the LaunchDarkly AI packages left external, once with `allowlist: [/^@launchdarkly\/ai-/]`.
5. Invokes each bundle through `fixture/invoke.cjs` and asserts the outcome.

The handler only reports which symbols resolved. It never reads an SDK key, calls LaunchDarkly, or invokes a model.

## Cases

| Case | Expected today |
|---|---|
| `externalized` | Fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` / `No "exports" main defined` — the reported bug, kept as a regression fixture |
| `allowlisted` | Loads `config`, `initClient`, the OpenAI messages handler, and the OTel tracer provider |

The `externalized` case is an assertion about the current published shape, not a skipped test. When the packages gain a CommonJS entry point, flip it to assert successful execution rather than deleting it.
