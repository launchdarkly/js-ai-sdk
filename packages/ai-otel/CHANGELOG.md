# Changelog

## [1.0.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-otel-0.3.0...@launchdarkly/ai-otel-1.0.0) (2026-10-30)


### ⚠ BREAKING CHANGES

* **client:** spans carry launchdarkly.project_id instead of highlight.project_id

### Bug Fixes

* **client:** stamp launchdarkly.project_id on the telemetry resource ([#176](https://github.com/launchdarkly/js-ai-sdk/issues/176)) ([93fb412](https://github.com/launchdarkly/js-ai-sdk/commit/93fb412e794bd7019404d5b12c7087bfaab71670))

## [0.3.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-otel-0.2.0...@launchdarkly/ai-otel-0.3.0) (2026-10-26)


### ⚠ BREAKING CHANGES

* **client:** the client no longer loads .env. Add import 'dotenv/config' to your entrypoint (and install dotenv) if you relied on it.

### Bug Fixes

* **client:** stop loading dotenv from library code ([#69](https://github.com/launchdarkly/js-ai-sdk/issues/69)) ([fea34f3](https://github.com/launchdarkly/js-ai-sdk/commit/fea34f309dba7f94264efaf0d065b9d80b29a8c2))

## [0.2.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-otel-0.1.1...@launchdarkly/ai-otel-0.2.0) (2026-10-09)


### Features

* **build:** build the AI SDK like the other LaunchDarkly JS SDKs so CommonJS apps can load it (2/4) ([#77](https://github.com/launchdarkly/js-ai-sdk/issues/77)) ([2cda755](https://github.com/launchdarkly/js-ai-sdk/commit/2cda7551c8feb7e352040384befea2cd76cb5d94))
* **build:** dual ESM/CommonJS output via tsup ([d8e62e4](https://github.com/launchdarkly/js-ai-sdk/commit/d8e62e405d21b1854f5b29a0aa5661099b1d8c37))

## [0.1.1](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-otel-0.1.0...@launchdarkly/ai-otel-0.1.1) (2026-08-07)


### Bug Fixes

* add module docstrings to all packages ([b913a06](https://github.com/launchdarkly/js-ai-sdk/commit/b913a06101a4bbd857a59babab852ca6944d3dca))
* add module docstrings to all packages ([#14](https://github.com/launchdarkly/js-ai-sdk/issues/14)) ([56fec00](https://github.com/launchdarkly/js-ai-sdk/commit/56fec00c42c6f1586cec6a9683f038e52eade2a2))

## [0.1.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-otel-0.0.1...@launchdarkly/ai-otel-0.1.0) (2026-08-05)


### Features

* initial commit — LaunchDarkly AI SDK for TypeScript ([977dba8](https://github.com/launchdarkly/js-ai-sdk/commit/977dba849cf8d9636030b664f99c0a86da74c0d2))
* initial commit — LaunchDarkly AI SDK for TypeScript ([#1](https://github.com/launchdarkly/js-ai-sdk/issues/1)) ([947f5bb](https://github.com/launchdarkly/js-ai-sdk/commit/947f5bb0c79d64f7e36985e4501bfdcee25c0a48))

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
