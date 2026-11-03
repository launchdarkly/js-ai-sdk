# Changelog

## [1.0.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-litellm-agents-0.2.0...@launchdarkly/ai-litellm-agents-1.0.0) (2026-10-30)


### ⚠ BREAKING CHANGES

* **client:** conversation content is now captured on spans by default. To keep it off, call configure({ options: { captureContent: false } }) once at startup.
* **client:** createHandler returns a new wrapper function rather than adding providesFor to the function you pass and returning that same function. Use the handler createHandler returns; the function you passed in no longer carries providesFor.

### Features

* **client:** capture conversation content on spans by default and add configure() ([d9c7fc3](https://github.com/launchdarkly/js-ai-sdk/commit/d9c7fc3cb76d16b0973724725f4e9b6d06d6a052))


### Bug Fixes

* **AIC-3573:** never send a NativeTool to the model as a function tool ([#194](https://github.com/launchdarkly/js-ai-sdk/issues/194)) ([ec43b85](https://github.com/launchdarkly/js-ai-sdk/commit/ec43b85cbafd6ab446771ea7a92a29bba27208e0))
* **client:** return a new handler from createHandler instead of changing the function passed in ([d9c7fc3](https://github.com/launchdarkly/js-ai-sdk/commit/d9c7fc3cb76d16b0973724725f4e9b6d06d6a052))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @launchdarkly/ai-server bumped from ^0.5.0 to ^1.0.0

## [0.2.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-litellm-agents-0.1.0...@launchdarkly/ai-litellm-agents-0.2.0) (2026-10-26)


### ⚠ BREAKING CHANGES

* forward the same model.parameters keys as the Python SDK ([#118](https://github.com/launchdarkly/js-ai-sdk/issues/118))

### Features

* add LiteLLM messages and agents integrations ([#75](https://github.com/launchdarkly/js-ai-sdk/issues/75)) ([127f156](https://github.com/launchdarkly/js-ai-sdk/commit/127f156bf38349ad86a2bb57144042d390fab5a9))


### Bug Fixes

* forward the same model.parameters keys as the Python SDK ([#118](https://github.com/launchdarkly/js-ai-sdk/issues/118)) ([f7883ce](https://github.com/launchdarkly/js-ai-sdk/commit/f7883cec93b05824cf772a790eee2d93c2246a1e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @launchdarkly/ai-server bumped from ^0.4.0 to ^0.5.0
