# Changelog

## [0.2.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-vercel-agents-0.1.0...@launchdarkly/ai-vercel-agents-0.2.0) (2026-10-09)


### Features

* **AIC-3408:** add Vercel AI SDK messages and agents adapters ([#83](https://github.com/launchdarkly/js-ai-sdk/issues/83)) ([7d08c9c](https://github.com/launchdarkly/js-ai-sdk/commit/7d08c9c955b1d6320effce74153d4185d6cfc9c9))
* **AIC-3495:** record which public helpers an application calls ([#115](https://github.com/launchdarkly/js-ai-sdk/issues/115)) ([aeb4019](https://github.com/launchdarkly/js-ai-sdk/commit/aeb40190b237bb75f788c4c925008c2a9a856ab4))


### Bug Fixes

* **deps:** depend on the @launchdarkly/ai-server release each package needs ([#119](https://github.com/launchdarkly/js-ai-sdk/issues/119)) ([9c2a56b](https://github.com/launchdarkly/js-ai-sdk/commit/9c2a56b27a309515032758f64c9c2c7c21477f33))
* **langchain:** stop forwarding additionalModelRequestFields to ChatBedrockConverse ([f6268fd](https://github.com/launchdarkly/js-ai-sdk/commit/f6268fdc2c186efd68f91831afba8224974b6bee))
* pass AI Config model parameters through to every provider handler ([#73](https://github.com/launchdarkly/js-ai-sdk/issues/73)) ([993225f](https://github.com/launchdarkly/js-ai-sdk/commit/993225f3d1cb46016d5f2a21394d5dd505e27e4a))
* **vercel-agents:** map model.parameters onto ToolLoopAgent call settings ([4241d75](https://github.com/launchdarkly/js-ai-sdk/commit/4241d754d5caedf51f8eb2b2fc2301ad678c61eb))
* **vercel:** never forward headers, providerOptions, maxRetries or timeout from model.parameters ([0a616fb](https://github.com/launchdarkly/js-ai-sdk/commit/0a616fbfe6b7fcd3600f71da60959db935dca104))
* **vercel:** send image content as AI SDK file parts ([#99](https://github.com/launchdarkly/js-ai-sdk/issues/99)) ([2856abc](https://github.com/launchdarkly/js-ai-sdk/commit/2856abc20fbc86b5e1b97656f587dc15e485a907))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @launchdarkly/ai-server bumped from ^0.3.0 to ^0.4.0
