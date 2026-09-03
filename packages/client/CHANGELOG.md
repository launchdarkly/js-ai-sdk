# Changelog

## [0.2.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-server-0.1.1...@launchdarkly/ai-server-0.2.0) (2026-09-03)


### Features

* **AIC-3230:** emit evaluation context identity ([#47](https://github.com/launchdarkly/js-ai-sdk/issues/47)) ([45f585f](https://github.com/launchdarkly/js-ai-sdk/commit/45f585fd25d7ee0dc6ad58c55424b3835f98f693))
* emit $ld:ai:sdk:info event per AI package ([#43](https://github.com/launchdarkly/js-ai-sdk/issues/43)) ([ba09c09](https://github.com/launchdarkly/js-ai-sdk/commit/ba09c09590a00042cf2435debafac6d2f87ee1b2))
* emit conversation id and judge evals ([d359c0b](https://github.com/launchdarkly/js-ai-sdk/commit/d359c0b6a6fdb3193e5596c5401a167f049890ff))
* emit evaluation context identity on feature_flag spans ([85fcae5](https://github.com/launchdarkly/js-ai-sdk/commit/85fcae5ace01b3c5de164600ccdffbadace10802))
* emit gen_ai.conversation.id ([#25](https://github.com/launchdarkly/js-ai-sdk/issues/25)) ([0c64af9](https://github.com/launchdarkly/js-ai-sdk/commit/0c64af9bbdc8978662ba57af30aaa939c4a841f2))
* gate the judge explanation on captureContent ([e820247](https://github.com/launchdarkly/js-ai-sdk/commit/e82024744ec8eff0f9f41f8aededb5d97f3ba8e2))
* record judge scores as gen_ai.evaluation.result ([8e9146f](https://github.com/launchdarkly/js-ai-sdk/commit/8e9146f84c56fd2835db44404da2ebf089bffadc))
* record judge scores as gen_ai.evaluation.result ([#27](https://github.com/launchdarkly/js-ai-sdk/issues/27)) ([a8d3bd5](https://github.com/launchdarkly/js-ai-sdk/commit/a8d3bd5b43da38696ea0c516ba26c8e760a4aab7))


### Bug Fixes

* **AIC-3230:** align user context canonical identity ([a06e964](https://github.com/launchdarkly/js-ai-sdk/commit/a06e9646244a42e372061c6975714190c6f6f780))
* bind conversation id at stream() call time ([bcf1e11](https://github.com/launchdarkly/js-ai-sdk/commit/bcf1e1147f5cb2bea4bc6f290d097e9a58070092))
* scope the processor, keep streaming parenting, accept a nullish id ([8edbb40](https://github.com/launchdarkly/js-ai-sdk/commit/8edbb40b30169fe61d2bf39a0c054430c68ccac4))
* stop exporting judge reasoning, restore error semantics, freeze the end time ([a8767cc](https://github.com/launchdarkly/js-ai-sdk/commit/a8767cc6b04aa29a8989796cdf036d90fe1d937c))
* use tool keys in tool call telemetry ([e55c010](https://github.com/launchdarkly/js-ai-sdk/commit/e55c010fba80eb0748a1be74e35b4fc3a8b99456))
* use tool keys in tool call telemetry ([#38](https://github.com/launchdarkly/js-ai-sdk/issues/38)) ([7b28715](https://github.com/launchdarkly/js-ai-sdk/commit/7b28715e41ad7cd4977df753fd1dd447be1e884a))
* warn when a conversation id is bound before OTel init ([2f0e367](https://github.com/launchdarkly/js-ai-sdk/commit/2f0e3670a4135b80dcccf05a9e9808d3d4a045d9))

## [0.1.1](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-server-0.1.0...@launchdarkly/ai-server-0.1.1) (2026-08-07)


### Bug Fixes

* add module docstring to client package ([4f1afb7](https://github.com/launchdarkly/js-ai-sdk/commit/4f1afb7d481f59904b5d60f67169c7c2af75d6a1))
* add module docstring to client package ([#12](https://github.com/launchdarkly/js-ai-sdk/issues/12)) ([1a361a9](https://github.com/launchdarkly/js-ai-sdk/commit/1a361a9e385091c89968521ad9d5185fd0b1ae58))

## [0.1.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-server-0.0.1...@launchdarkly/ai-server-0.1.0) (2026-08-05)


### Features

* initial commit — LaunchDarkly AI SDK for TypeScript ([977dba8](https://github.com/launchdarkly/js-ai-sdk/commit/977dba849cf8d9636030b664f99c0a86da74c0d2))
* initial commit — LaunchDarkly AI SDK for TypeScript ([#1](https://github.com/launchdarkly/js-ai-sdk/issues/1)) ([947f5bb](https://github.com/launchdarkly/js-ai-sdk/commit/947f5bb0c79d64f7e36985e4501bfdcee25c0a48))

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
