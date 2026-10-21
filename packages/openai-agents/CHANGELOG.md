# Changelog

## [0.4.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-openai-agents-0.3.0...@launchdarkly/ai-openai-agents-0.4.0) (2026-10-09)


### Features

* **AIC-3210:** support streaming responses from agent graph nodes ([#84](https://github.com/launchdarkly/js-ai-sdk/issues/84)) ([24671e8](https://github.com/launchdarkly/js-ai-sdk/commit/24671e84d802c233109a409a7f0fce9034490c7d))
* **AIC-3211:** record each graph node as its own tracking event ([#91](https://github.com/launchdarkly/js-ai-sdk/issues/91)) ([2df2923](https://github.com/launchdarkly/js-ai-sdk/commit/2df2923cd6f831a6583c9747b0d17626189d292c))
* **AIC-3495:** record which public helpers an application calls ([#115](https://github.com/launchdarkly/js-ai-sdk/issues/115)) ([aeb4019](https://github.com/launchdarkly/js-ai-sdk/commit/aeb40190b237bb75f788c4c925008c2a9a856ab4))
* **build:** build the AI SDK like the other LaunchDarkly JS SDKs so CommonJS apps can load it (2/4) ([#77](https://github.com/launchdarkly/js-ai-sdk/issues/77)) ([2cda755](https://github.com/launchdarkly/js-ai-sdk/commit/2cda7551c8feb7e352040384befea2cd76cb5d94))


### Bug Fixes

* **deps:** depend on the @launchdarkly/ai-server release each package needs ([#119](https://github.com/launchdarkly/js-ai-sdk/issues/119)) ([9c2a56b](https://github.com/launchdarkly/js-ai-sdk/commit/9c2a56b27a309515032758f64c9c2c7c21477f33))
* **handlers:** camelize snake_case model.parameters for framework handlers ([75c6287](https://github.com/launchdarkly/js-ai-sdk/commit/75c6287ebdc4098df6722dfc76656b068e9a3985))
* **langchain:** stop forwarding additionalModelRequestFields to ChatBedrockConverse ([f6268fd](https://github.com/launchdarkly/js-ai-sdk/commit/f6268fdc2c186efd68f91831afba8224974b6bee))
* **openai-agents:** forward only an allowlist of ModelSettings fields from model.parameters ([398e935](https://github.com/launchdarkly/js-ai-sdk/commit/398e935ef0cb987169a5d1113a9abbf65f20e194))
* pass AI Config model parameters through to every provider handler ([#73](https://github.com/launchdarkly/js-ai-sdk/issues/73)) ([993225f](https://github.com/launchdarkly/js-ai-sdk/commit/993225f3d1cb46016d5f2a21394d5dd505e27e4a))
* **telemetry:** report OpenAI tool arguments as an object, not a JSON string ([#68](https://github.com/launchdarkly/js-ai-sdk/issues/68)) ([d614791](https://github.com/launchdarkly/js-ai-sdk/commit/d614791799361ce2ad71f177f298bcc4e51bcf97))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @launchdarkly/ai-server bumped from ^0.3.0 to ^0.4.0

## [0.3.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-openai-agents-0.2.0...@launchdarkly/ai-openai-agents-0.3.0) (2026-09-18)


### Features

* **AIC-3106:** add multimodal history support to graph().invoke() ([#18](https://github.com/launchdarkly/js-ai-sdk/issues/18)) ([9737530](https://github.com/launchdarkly/js-ai-sdk/commit/9737530fbd0610fbaebf3f36e3f0c5b2e7c5c834))
* **client:** stamp modelKey and modelVersion from _ldMeta on tracking events ([758fe7c](https://github.com/launchdarkly/js-ai-sdk/commit/758fe7c0730f8f285a28ea702a6e4c8d87033312))
* **client:** stamp modelKey and modelVersion from _ldMeta on tracking events ([#66](https://github.com/launchdarkly/js-ai-sdk/issues/66)) ([89e4f0e](https://github.com/launchdarkly/js-ai-sdk/commit/89e4f0e45570ccfc4606deb3284dbaa343481bbe))


### Bug Fixes

* **client:** harden model stamps, share node trackData builder, keep judge results from inheriting parent model identity ([d374962](https://github.com/launchdarkly/js-ai-sdk/commit/d374962bf01024d5e2a6f1f2c3f11aaaea7ee75e))

## [0.2.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-openai-agents-0.1.1...@launchdarkly/ai-openai-agents-0.2.0) (2026-09-08)


### Features

* **AIC-3230:** emit evaluation context identity ([#47](https://github.com/launchdarkly/js-ai-sdk/issues/47)) ([45f585f](https://github.com/launchdarkly/js-ai-sdk/commit/45f585fd25d7ee0dc6ad58c55424b3835f98f693))
* emit $ld:ai:sdk:info event per AI package ([#43](https://github.com/launchdarkly/js-ai-sdk/issues/43)) ([ba09c09](https://github.com/launchdarkly/js-ai-sdk/commit/ba09c09590a00042cf2435debafac6d2f87ee1b2))
* emit evaluation context identity on feature_flag spans ([85fcae5](https://github.com/launchdarkly/js-ai-sdk/commit/85fcae5ace01b3c5de164600ccdffbadace10802))
* gate the judge explanation on captureContent ([e820247](https://github.com/launchdarkly/js-ai-sdk/commit/e82024744ec8eff0f9f41f8aededb5d97f3ba8e2))
* record judge scores as gen_ai.evaluation.result ([#27](https://github.com/launchdarkly/js-ai-sdk/issues/27)) ([a8d3bd5](https://github.com/launchdarkly/js-ai-sdk/commit/a8d3bd5b43da38696ea0c516ba26c8e760a4aab7))

## [0.1.1](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-openai-agents-0.1.0...@launchdarkly/ai-openai-agents-0.1.1) (2026-08-07)


### Bug Fixes

* add module docstrings to all packages ([b913a06](https://github.com/launchdarkly/js-ai-sdk/commit/b913a06101a4bbd857a59babab852ca6944d3dca))
* add module docstrings to all packages ([#14](https://github.com/launchdarkly/js-ai-sdk/issues/14)) ([56fec00](https://github.com/launchdarkly/js-ai-sdk/commit/56fec00c42c6f1586cec6a9683f038e52eade2a2))

## [0.1.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-openai-agents-0.0.1...@launchdarkly/ai-openai-agents-0.1.0) (2026-08-05)


### Features

* initial commit — LaunchDarkly AI SDK for TypeScript ([977dba8](https://github.com/launchdarkly/js-ai-sdk/commit/977dba849cf8d9636030b664f99c0a86da74c0d2))
* initial commit — LaunchDarkly AI SDK for TypeScript ([#1](https://github.com/launchdarkly/js-ai-sdk/issues/1)) ([947f5bb](https://github.com/launchdarkly/js-ai-sdk/commit/947f5bb0c79d64f7e36985e4501bfdcee25c0a48))

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
