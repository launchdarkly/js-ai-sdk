# Changelog

## [1.0.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-typesafe-0.2.0...@launchdarkly/ai-typesafe-1.0.0) (2026-10-30)


### ⚠ BREAKING CHANGES

* **client:** conversation content is now captured on spans by default. To keep it off, call configure({ options: { captureContent: false } }) once at startup.
* **client:** createHandler returns a new wrapper function rather than adding providesFor to the function you pass and returning that same function. Use the handler createHandler returns; the function you passed in no longer carries providesFor.

### Features

* **client:** capture conversation content on spans by default and add configure() ([d9c7fc3](https://github.com/launchdarkly/js-ai-sdk/commit/d9c7fc3cb76d16b0973724725f4e9b6d06d6a052))


### Bug Fixes

* **client:** return a new handler from createHandler instead of changing the function passed in ([d9c7fc3](https://github.com/launchdarkly/js-ai-sdk/commit/d9c7fc3cb76d16b0973724725f4e9b6d06d6a052))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @launchdarkly/ai-server bumped from ^0.5.0 to ^1.0.0

## [0.2.0](https://github.com/launchdarkly/js-ai-sdk/compare/@launchdarkly/ai-typesafe-0.1.0...@launchdarkly/ai-typesafe-0.2.0) (2026-10-26)


### ⚠ BREAKING CHANGES

* forward the same model.parameters keys as the Python SDK ([#118](https://github.com/launchdarkly/js-ai-sdk/issues/118))

### Features

* **AIC-3534:** add a TypeSafe Jev judge handler ([#122](https://github.com/launchdarkly/js-ai-sdk/issues/122)) ([0c1d6b7](https://github.com/launchdarkly/js-ai-sdk/commit/0c1d6b73261a17b83d11d29a28fcaa8facc11fc6))
* **AIC-3623:** evals from code ([#143](https://github.com/launchdarkly/js-ai-sdk/issues/143)) ([dc74b48](https://github.com/launchdarkly/js-ai-sdk/commit/dc74b488b5c4f9918650c92e86d4cf45742504c5))


### Bug Fixes

* forward the same model.parameters keys as the Python SDK ([#118](https://github.com/launchdarkly/js-ai-sdk/issues/118)) ([f7883ce](https://github.com/launchdarkly/js-ai-sdk/commit/f7883cec93b05824cf772a790eee2d93c2246a1e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @launchdarkly/ai-server bumped from ^0.4.0 to ^0.5.0

## 0.1.0

* add a TypeSafe Jev handler for judge configs
