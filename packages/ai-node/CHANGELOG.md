# Changelog

## [0.3.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-node-0.2.0...@launchdarkly/ai-node-0.3.0) (2026-10-09)


### Experimental

* **skills:** add experimental Agent Skills under `@launchdarkly/ai-server/experimental`, re-exported from `@launchdarkly/ai-node/experimental` ([a242659](https://github.com/launchdarkly/js-ai-sdk/commit/a242659783689f06d7ef2f1377c26a6735a7f81c))


### Features

* **build:** build the AI SDK like the other LaunchDarkly JS SDKs so CommonJS apps can load it (2/4) ([#77](https://github.com/launchdarkly/js-ai-sdk/issues/77)) ([2cda755](https://github.com/launchdarkly/js-ai-sdk/commit/2cda7551c8feb7e352040384befea2cd76cb5d94))
* **build:** dual ESM/CommonJS output via tsup ([d8e62e4](https://github.com/launchdarkly/js-ai-sdk/commit/d8e62e405d21b1854f5b29a0aa5661099b1d8c37))
* **client:** `initClient(client, options)` accepts telemetry options for a pre-initialized client ([a242659](https://github.com/launchdarkly/js-ai-sdk/commit/a242659783689f06d7ef2f1377c26a6735a7f81c))
* **client:** warn about unrecognized `initClient` options instead of ignoring them silently ([a242659](https://github.com/launchdarkly/js-ai-sdk/commit/a242659783689f06d7ef2f1377c26a6735a7f81c))


### Bug Fixes

* **client:** `shutdownTelemetry()` releases the OpenTelemetry globals the SDK registered, so a later `initClient` exports spans again ([a242659](https://github.com/launchdarkly/js-ai-sdk/commit/a242659783689f06d7ef2f1377c26a6735a7f81c))
* **client:** a repeat `initClient(client)` returns the client already set instead of replacing it ([a242659](https://github.com/launchdarkly/js-ai-sdk/commit/a242659783689f06d7ef2f1377c26a6735a7f81c))
* **client:** an `initClient` that fails, or that `shutdown()` interrupts, closes the client it built, and a failure is no longer cached, so the next call retries ([a242659](https://github.com/launchdarkly/js-ai-sdk/commit/a242659783689f06d7ef2f1377c26a6735a7f81c))
* **deps:** depend on the @launchdarkly/ai-server release each package needs ([#119](https://github.com/launchdarkly/js-ai-sdk/issues/119)) ([9c2a56b](https://github.com/launchdarkly/js-ai-sdk/commit/9c2a56b27a309515032758f64c9c2c7c21477f33))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @launchdarkly/ai-server bumped from ^0.3.0 to ^0.4.0

## [0.2.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-node-0.1.1...@launchdarkly/ai-node-0.2.0) (2026-09-08)


### Features

* emit $ld:ai:sdk:info event per AI package ([#43](https://github.com/launchdarkly/js-ai-sdk/issues/43)) ([ba09c09](https://github.com/launchdarkly/js-ai-sdk/commit/ba09c09590a00042cf2435debafac6d2f87ee1b2))

## [0.1.1](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-node-0.1.0...@launchdarkly/ai-node-0.1.1) (2026-08-07)


### Bug Fixes

* add module docstrings to all packages ([b913a06](https://github.com/launchdarkly/js-ai-sdk/commit/b913a06101a4bbd857a59babab852ca6944d3dca))
* add module docstrings to all packages ([#14](https://github.com/launchdarkly/js-ai-sdk/issues/14)) ([56fec00](https://github.com/launchdarkly/js-ai-sdk/commit/56fec00c42c6f1586cec6a9683f038e52eade2a2))

## [0.1.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-node-0.0.1...@launchdarkly/ai-node-0.1.0) (2026-08-05)


### Features

* initial commit — LaunchDarkly AI SDK for TypeScript ([977dba8](https://github.com/launchdarkly/js-ai-sdk/commit/977dba849cf8d9636030b664f99c0a86da74c0d2))
* initial commit — LaunchDarkly AI SDK for TypeScript ([#1](https://github.com/launchdarkly/js-ai-sdk/issues/1)) ([947f5bb](https://github.com/launchdarkly/js-ai-sdk/commit/947f5bb0c79d64f7e36985e4501bfdcee25c0a48))

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
