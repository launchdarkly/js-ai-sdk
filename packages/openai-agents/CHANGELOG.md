# Changelog

## [1.0.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-openai-agents-0.5.0...@launchdarkly/ai-openai-agents-1.0.0) (2026-10-30)


### ⚠ BREAKING CHANGES

* **client:** conversation content is now captured on spans by default. To keep it off, call configure({ options: { captureContent: false } }) once at startup.
* **client:** createHandler returns a new wrapper function rather than adding providesFor to the function you pass and returning that same function. Use the handler createHandler returns; the function you passed in no longer carries providesFor.
* **client:** add result variant and value to the feature_flag span event ([#186](https://github.com/launchdarkly/js-ai-sdk/issues/186))
* **AIC-3687:** rename createOpenAIAgentHandler to createOpenAIAgentsHandler ([#174](https://github.com/launchdarkly/js-ai-sdk/issues/174))

### Features

* **AIC-3687:** rename createOpenAIAgentHandler to createOpenAIAgentsHandler ([#174](https://github.com/launchdarkly/js-ai-sdk/issues/174)) ([cfba4d2](https://github.com/launchdarkly/js-ai-sdk/commit/cfba4d206d0ce977ccbcc68f4e31c98b70a808e0))
* **client:** add result variant and value to the feature_flag span event ([#186](https://github.com/launchdarkly/js-ai-sdk/issues/186)) ([8dbe2ec](https://github.com/launchdarkly/js-ai-sdk/commit/8dbe2ec266d635464a41facfde924b0707f747aa))
* **client:** capture conversation content on spans by default and add configure() ([d9c7fc3](https://github.com/launchdarkly/js-ai-sdk/commit/d9c7fc3cb76d16b0973724725f4e9b6d06d6a052))


### Bug Fixes

* **AIC-3573:** never send a NativeTool to the model as a function tool ([#194](https://github.com/launchdarkly/js-ai-sdk/issues/194)) ([ec43b85](https://github.com/launchdarkly/js-ai-sdk/commit/ec43b85cbafd6ab446771ea7a92a29bba27208e0))
* **AIC-3726:** realign three usage IDs with the 1.0 factory names ([#197](https://github.com/launchdarkly/js-ai-sdk/issues/197)) ([fc83c7a](https://github.com/launchdarkly/js-ai-sdk/commit/fc83c7a0a4caab196aebd4402063794e4f0bc77b))
* **client:** return a new handler from createHandler instead of changing the function passed in ([d9c7fc3](https://github.com/launchdarkly/js-ai-sdk/commit/d9c7fc3cb76d16b0973724725f4e9b6d06d6a052))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @launchdarkly/ai-server bumped from ^0.5.0 to ^1.0.0

## [0.5.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-openai-agents-0.4.0...@launchdarkly/ai-openai-agents-0.5.0) (2026-10-26)


### ⚠ BREAKING CHANGES

* forward the same model.parameters keys as the Python SDK ([#118](https://github.com/launchdarkly/js-ai-sdk/issues/118))
* **client:** the client no longer loads .env. Add import 'dotenv/config' to your entrypoint (and install dotenv) if you relied on it.

### Features

* **AIC-3623:** evals from code ([#143](https://github.com/launchdarkly/js-ai-sdk/issues/143)) ([dc74b48](https://github.com/launchdarkly/js-ai-sdk/commit/dc74b488b5c4f9918650c92e86d4cf45742504c5))


### Bug Fixes

* **AIC-3571:** visit every child before its parent in reverseTraverse ([#147](https://github.com/launchdarkly/js-ai-sdk/issues/147)) ([a17a2ce](https://github.com/launchdarkly/js-ai-sdk/commit/a17a2cebb973586bdfc0fa3fc8d79c9838d9a395))
* **AIC-3577:** send object tool results to the model as JSON ([#146](https://github.com/launchdarkly/js-ai-sdk/issues/146)) ([be41d87](https://github.com/launchdarkly/js-ai-sdk/commit/be41d876056fe84883207cd3f3ca74f42aaa42a0))
* **AIC-3586:** propagate tool handler errors instead of sending them to the model ([#139](https://github.com/launchdarkly/js-ai-sdk/issues/139)) ([1f31e85](https://github.com/launchdarkly/js-ai-sdk/commit/1f31e853f04aa7a60f4f6ad82f29762042d78bd4))
* **client:** stop loading dotenv from library code ([#69](https://github.com/launchdarkly/js-ai-sdk/issues/69)) ([fea34f3](https://github.com/launchdarkly/js-ai-sdk/commit/fea34f309dba7f94264efaf0d065b9d80b29a8c2))
* forward the same model.parameters keys as the Python SDK ([#118](https://github.com/launchdarkly/js-ai-sdk/issues/118)) ([f7883ce](https://github.com/launchdarkly/js-ai-sdk/commit/f7883cec93b05824cf772a790eee2d93c2246a1e))
* give native graph spans their LaunchDarkly identity ([#101](https://github.com/launchdarkly/js-ai-sdk/issues/101)) ([4d97cfa](https://github.com/launchdarkly/js-ai-sdk/commit/4d97cfa4f81564f5389728dbd3e2d418e2f44f27))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @launchdarkly/ai-server bumped from ^0.4.0 to ^0.5.0

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
