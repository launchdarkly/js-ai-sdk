# Changelog

## [1.0.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-claude-agents-0.5.0...@launchdarkly/ai-claude-agents-1.0.0) (2026-10-30)


### ⚠ BREAKING CHANGES

* **client:** conversation content is now captured on spans by default. To keep it off, call configure({ options: { captureContent: false } }) once at startup.
* **client:** createHandler returns a new wrapper function rather than adding providesFor to the function you pass and returning that same function. Use the handler createHandler returns; the function you passed in no longer carries providesFor.
* **client:** add result variant and value to the feature_flag span event ([#186](https://github.com/launchdarkly/js-ai-sdk/issues/186))
* **SEC-9507:** enable Claude native tools only when the active variation attaches them
* **claude-agents:** honour the config's max_tokens and disable thinking unless the config asks ([#183](https://github.com/launchdarkly/js-ai-sdk/issues/183))
* **skills:** rename FDv2SkillStore to LaunchDarklySkillStore ([#172](https://github.com/launchdarkly/js-ai-sdk/issues/172))
* **AIC-3598:** type toolHandlers on the handler contract; declare @langchain/anthropic ([#170](https://github.com/launchdarkly/js-ai-sdk/issues/170))

### Features

* **client:** add result variant and value to the feature_flag span event ([#186](https://github.com/launchdarkly/js-ai-sdk/issues/186)) ([8dbe2ec](https://github.com/launchdarkly/js-ai-sdk/commit/8dbe2ec266d635464a41facfde924b0707f747aa))
* **client:** capture conversation content on spans by default and add configure() ([d9c7fc3](https://github.com/launchdarkly/js-ai-sdk/commit/d9c7fc3cb76d16b0973724725f4e9b6d06d6a052))
* **skills:** give Claude Agents runs the skills attached to their variation ([#136](https://github.com/launchdarkly/js-ai-sdk/issues/136)) ([df16ba0](https://github.com/launchdarkly/js-ai-sdk/commit/df16ba0823d093231e523a95c1c7180cc5de805f))
* **skills:** rename FDv2SkillStore to LaunchDarklySkillStore ([#172](https://github.com/launchdarkly/js-ai-sdk/issues/172)) ([d3e7c5f](https://github.com/launchdarkly/js-ai-sdk/commit/d3e7c5f88ae000da3a40be7eb97bac1f98169db2))


### Bug Fixes

* **AIC-3598:** type toolHandlers on the handler contract; declare @langchain/anthropic ([#170](https://github.com/launchdarkly/js-ai-sdk/issues/170)) ([c6c00fc](https://github.com/launchdarkly/js-ai-sdk/commit/c6c00fcbc31c62aad7aeefcadaaf1a1274d14207))
* **claude-agents:** honour the config's max_tokens and disable thinking unless the config asks ([#183](https://github.com/launchdarkly/js-ai-sdk/issues/183)) ([f58ce21](https://github.com/launchdarkly/js-ai-sdk/commit/f58ce2173daef438c34e436a56b0e9521fa39db1))
* **client:** return a new handler from createHandler instead of changing the function passed in ([d9c7fc3](https://github.com/launchdarkly/js-ai-sdk/commit/d9c7fc3cb76d16b0973724725f4e9b6d06d6a052))
* **SEC-9507:** dispatch litellm-messages tool calls only to tools offered for the request ([6926e8a](https://github.com/launchdarkly/js-ai-sdk/commit/6926e8a67f684bc4c40796392bb0d088e71e728e))
* **SEC-9507:** enable Claude native tools only when the active variation attaches them ([6926e8a](https://github.com/launchdarkly/js-ai-sdk/commit/6926e8a67f684bc4c40796392bb0d088e71e728e))
* **SEC-9507:** pass handlers only the tools attached to the active variation ([6926e8a](https://github.com/launchdarkly/js-ai-sdk/commit/6926e8a67f684bc4c40796392bb0d088e71e728e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @launchdarkly/ai-server bumped from ^0.5.0 to ^1.0.0

## [0.5.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-claude-agents-0.4.0...@launchdarkly/ai-claude-agents-0.5.0) (2026-10-26)


### ⚠ BREAKING CHANGES

* forward the same model.parameters keys as the Python SDK ([#118](https://github.com/launchdarkly/js-ai-sdk/issues/118))
* **claude-agents:** accept trusted cwd and settingSources options, and load no host settings by default ([#135](https://github.com/launchdarkly/js-ai-sdk/issues/135))
* **client:** the client no longer loads .env. Add import 'dotenv/config' to your entrypoint (and install dotenv) if you relied on it.

### Features

* **AIC-3623:** evals from code ([#143](https://github.com/launchdarkly/js-ai-sdk/issues/143)) ([dc74b48](https://github.com/launchdarkly/js-ai-sdk/commit/dc74b488b5c4f9918650c92e86d4cf45742504c5))
* **claude-agents:** accept trusted cwd and settingSources options, and load no host settings by default ([#135](https://github.com/launchdarkly/js-ai-sdk/issues/135)) ([6acd53d](https://github.com/launchdarkly/js-ai-sdk/commit/6acd53d892710ed0c8d404698e71729ab462369e))


### Bug Fixes

* **AIC-3571:** visit every child before its parent in reverseTraverse ([#147](https://github.com/launchdarkly/js-ai-sdk/issues/147)) ([a17a2ce](https://github.com/launchdarkly/js-ai-sdk/commit/a17a2cebb973586bdfc0fa3fc8d79c9838d9a395))
* **AIC-3577:** send object tool results to the model as JSON ([#146](https://github.com/launchdarkly/js-ai-sdk/issues/146)) ([be41d87](https://github.com/launchdarkly/js-ai-sdk/commit/be41d876056fe84883207cd3f3ca74f42aaa42a0))
* **claude-agents:** fail the run when the CLI reports an API error as success ([#138](https://github.com/launchdarkly/js-ai-sdk/issues/138)) ([4637958](https://github.com/launchdarkly/js-ai-sdk/commit/463795828c0347f3f328a0135785fc62d9dabfd5))
* **client:** stop loading dotenv from library code ([#69](https://github.com/launchdarkly/js-ai-sdk/issues/69)) ([fea34f3](https://github.com/launchdarkly/js-ai-sdk/commit/fea34f309dba7f94264efaf0d065b9d80b29a8c2))
* forward the same model.parameters keys as the Python SDK ([#118](https://github.com/launchdarkly/js-ai-sdk/issues/118)) ([f7883ce](https://github.com/launchdarkly/js-ai-sdk/commit/f7883cec93b05824cf772a790eee2d93c2246a1e))
* give native graph spans their LaunchDarkly identity ([#101](https://github.com/launchdarkly/js-ai-sdk/issues/101)) ([4d97cfa](https://github.com/launchdarkly/js-ai-sdk/commit/4d97cfa4f81564f5389728dbd3e2d418e2f44f27))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @launchdarkly/ai-server bumped from ^0.4.0 to ^0.5.0

## [0.4.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-claude-agents-0.3.0...@launchdarkly/ai-claude-agents-0.4.0) (2026-10-09)


### Features

* **AIC-3211:** record each graph node as its own tracking event ([#91](https://github.com/launchdarkly/js-ai-sdk/issues/91)) ([2df2923](https://github.com/launchdarkly/js-ai-sdk/commit/2df2923cd6f831a6583c9747b0d17626189d292c))
* **AIC-3495:** record which public helpers an application calls ([#115](https://github.com/launchdarkly/js-ai-sdk/issues/115)) ([aeb4019](https://github.com/launchdarkly/js-ai-sdk/commit/aeb40190b237bb75f788c4c925008c2a9a856ab4))
* **build:** build the AI SDK like the other LaunchDarkly JS SDKs so CommonJS apps can load it (2/4) ([#77](https://github.com/launchdarkly/js-ai-sdk/issues/77)) ([2cda755](https://github.com/launchdarkly/js-ai-sdk/commit/2cda7551c8feb7e352040384befea2cd76cb5d94))


### Bug Fixes

* **claude-agents:** forward only an allowlist of query() options from model.parameters ([37bd8a7](https://github.com/launchdarkly/js-ai-sdk/commit/37bd8a769c92dcc7edef9ed5bc520dd2f92e225c))
* **deps:** depend on the @launchdarkly/ai-server release each package needs ([#119](https://github.com/launchdarkly/js-ai-sdk/issues/119)) ([9c2a56b](https://github.com/launchdarkly/js-ai-sdk/commit/9c2a56b27a309515032758f64c9c2c7c21477f33))
* **handlers:** camelize snake_case model.parameters for framework handlers ([75c6287](https://github.com/launchdarkly/js-ai-sdk/commit/75c6287ebdc4098df6722dfc76656b068e9a3985))
* **langchain:** stop forwarding additionalModelRequestFields to ChatBedrockConverse ([f6268fd](https://github.com/launchdarkly/js-ai-sdk/commit/f6268fdc2c186efd68f91831afba8224974b6bee))
* pass AI Config model parameters through to every provider handler ([#73](https://github.com/launchdarkly/js-ai-sdk/issues/73)) ([993225f](https://github.com/launchdarkly/js-ai-sdk/commit/993225f3d1cb46016d5f2a21394d5dd505e27e4a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @launchdarkly/ai-server bumped from ^0.3.0 to ^0.4.0

## [0.3.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-claude-agents-0.2.0...@launchdarkly/ai-claude-agents-0.3.0) (2026-09-18)


### Features

* **AIC-3106:** add multimodal history support to graph().invoke() ([#18](https://github.com/launchdarkly/js-ai-sdk/issues/18)) ([9737530](https://github.com/launchdarkly/js-ai-sdk/commit/9737530fbd0610fbaebf3f36e3f0c5b2e7c5c834))
* **client:** stamp modelKey and modelVersion from _ldMeta on tracking events ([758fe7c](https://github.com/launchdarkly/js-ai-sdk/commit/758fe7c0730f8f285a28ea702a6e4c8d87033312))
* **client:** stamp modelKey and modelVersion from _ldMeta on tracking events ([#66](https://github.com/launchdarkly/js-ai-sdk/issues/66)) ([89e4f0e](https://github.com/launchdarkly/js-ai-sdk/commit/89e4f0e45570ccfc4606deb3284dbaa343481bbe))


### Bug Fixes

* **client:** harden model stamps, share node trackData builder, keep judge results from inheriting parent model identity ([d374962](https://github.com/launchdarkly/js-ai-sdk/commit/d374962bf01024d5e2a6f1f2c3f11aaaea7ee75e))

## [0.2.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-claude-agents-0.1.1...@launchdarkly/ai-claude-agents-0.2.0) (2026-09-08)


### Features

* **AIC-3230:** emit evaluation context identity ([#47](https://github.com/launchdarkly/js-ai-sdk/issues/47)) ([45f585f](https://github.com/launchdarkly/js-ai-sdk/commit/45f585fd25d7ee0dc6ad58c55424b3835f98f693))
* emit $ld:ai:sdk:info event per AI package ([#43](https://github.com/launchdarkly/js-ai-sdk/issues/43)) ([ba09c09](https://github.com/launchdarkly/js-ai-sdk/commit/ba09c09590a00042cf2435debafac6d2f87ee1b2))
* emit conversation id and judge evals ([d359c0b](https://github.com/launchdarkly/js-ai-sdk/commit/d359c0b6a6fdb3193e5596c5401a167f049890ff))
* emit evaluation context identity on feature_flag spans ([85fcae5](https://github.com/launchdarkly/js-ai-sdk/commit/85fcae5ace01b3c5de164600ccdffbadace10802))
* emit gen_ai.conversation.id ([#25](https://github.com/launchdarkly/js-ai-sdk/issues/25)) ([0c64af9](https://github.com/launchdarkly/js-ai-sdk/commit/0c64af9bbdc8978662ba57af30aaa939c4a841f2))
* gate the judge explanation on captureContent ([e820247](https://github.com/launchdarkly/js-ai-sdk/commit/e82024744ec8eff0f9f41f8aededb5d97f3ba8e2))
* record judge scores as gen_ai.evaluation.result ([#27](https://github.com/launchdarkly/js-ai-sdk/issues/27)) ([a8d3bd5](https://github.com/launchdarkly/js-ai-sdk/commit/a8d3bd5b43da38696ea0c516ba26c8e760a4aab7))


### Bug Fixes

* use tool keys in tool call telemetry ([e55c010](https://github.com/launchdarkly/js-ai-sdk/commit/e55c010fba80eb0748a1be74e35b4fc3a8b99456))
* use tool keys in tool call telemetry ([#38](https://github.com/launchdarkly/js-ai-sdk/issues/38)) ([7b28715](https://github.com/launchdarkly/js-ai-sdk/commit/7b28715e41ad7cd4977df753fd1dd447be1e884a))

## [0.1.1](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-claude-agents-0.1.0...@launchdarkly/ai-claude-agents-0.1.1) (2026-08-07)


### Bug Fixes

* add module docstrings to all packages ([b913a06](https://github.com/launchdarkly/js-ai-sdk/commit/b913a06101a4bbd857a59babab852ca6944d3dca))
* add module docstrings to all packages ([#14](https://github.com/launchdarkly/js-ai-sdk/issues/14)) ([56fec00](https://github.com/launchdarkly/js-ai-sdk/commit/56fec00c42c6f1586cec6a9683f038e52eade2a2))

## [0.1.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-claude-agents-0.0.1...@launchdarkly/ai-claude-agents-0.1.0) (2026-08-05)


### Features

* initial commit — LaunchDarkly AI SDK for TypeScript ([977dba8](https://github.com/launchdarkly/js-ai-sdk/commit/977dba849cf8d9636030b664f99c0a86da74c0d2))
* initial commit — LaunchDarkly AI SDK for TypeScript ([#1](https://github.com/launchdarkly/js-ai-sdk/issues/1)) ([947f5bb](https://github.com/launchdarkly/js-ai-sdk/commit/947f5bb0c79d64f7e36985e4501bfdcee25c0a48))

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
