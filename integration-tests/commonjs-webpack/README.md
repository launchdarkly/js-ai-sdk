# CommonJS + Webpack integration test

Proves, from npm-shaped artifacts, that a CommonJS AWS Lambda bundled with Webpack — and a plain CommonJS or ESM consumer — can load the published packages.

```bash
yarn test:integration
```

## What the harness does

1. `yarn build` at the repo root.
2. `npm pack` for `client`, `ai-node`, `ai-otel`, `openai-messages`, and `langchain-messages` — the same tarball layout `npm publish` produces, so `"exports"` resolution is exercised exactly as a customer sees it.
3. Installs those tarballs plus Webpack 5.104.1, webpack-cli, and webpack-node-externals 3.0.0 (the versions reported in the incident) into `.staging/consumer`.
4. Bundles `fixture/handler.cjs` twice — once with the LaunchDarkly AI packages left external, once with `allowlist: [/^@launchdarkly\/ai-/]`.
5. Invokes each bundle through `fixture/invoke.cjs` and asserts the outcome.
6. Runs `fixture/entrypoints.cjs` (`require`) and `fixture/entrypoints.mjs` (`import`) against the same installed tarballs.

The handler only reports which symbols resolved. It never reads an SDK key, calls LaunchDarkly, or invokes a model.

## Cases

| Case | Expected |
|---|---|
| `externalized` | Loads successfully — Webpack downlevels `await import()` to `require()`, which the published `require` condition now resolves. This is the regression fixture for the original bug |
| `allowlisted` | Loads `config`, `initClient`, the OpenAI messages handler, and the OTel tracer provider |
| `entrypoints.cjs` | `require()` of every packed package root resolves its exports |
| `entrypoints.mjs` | Native `import` of every packed package root resolves its exports |

The suite also asserts each tarball ships `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`, and `dist/index.d.cts`, that every package manifest publishes both export conditions, and that optional dependencies stay behind a runtime `import()` in the CJS output.
