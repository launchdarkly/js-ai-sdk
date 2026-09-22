# Published-artifact Lambda release canary

Owner: the LaunchDarkly AI SDK team. The team maintains `launchdarkly/js-ai-sdk`.

## Plain version

We publish packages to npm. A customer then installs them and runs them on AWS Lambda.

This test does the same thing after each release. It installs the published packages.
It runs them in a real AWS Lambda function. It then deletes that function.

If the test fails, the packages are broken for customers. We learn this in minutes, not weeks.

The test only loads the packages. It uses no SDK key. It evaluates no flag. It calls no model.
So the test costs almost nothing.

## What it means for the code (junior eng)

A canary is a small test that runs against production artifacts after a release.
This canary is the second half of the work in
[AIC-3370](https://launchdarkly.atlassian.net/browse/AIC-3370).

The suite in `integration-tests/commonjs-webpack` packs the workspace with `npm pack`.
That suite tests the tarball that we plan to publish.
This canary tests the artifact that npm actually serves.

The canary installs exact published versions. It never uses a workspace link.
It never uses a dist-tag such as `latest`.

The fixture bundles the app with Serverless Framework 3 and Webpack 5.
It also uses `webpack-node-externals` 3 with no allowlist.
So Node resolves the LaunchDarkly packages at runtime.
That path is the exact path that failed in AIC-3370.

The workflow then deploys one function. It invokes the function one time.
It checks the JSON answer. It then deletes the function and the log group.

### The driver

`canary.mjs` holds all of the logic. It takes one exact version for each package.
You pass the versions as flags. You can also set
`LD_AI_CANARY_VERSIONS='ai-node=0.3.0,openai-messages=0.3.0,ai-otel=0.2.0'`.
The driver rejects a version that is not an exact semver.

| Command | What it does |
| --- | --- |
| `wait` | Calls `npm view` until npm serves all three versions. A new publish is not readable at once. |
| `build` | Copies `fixture/` into `.canary/app`. Installs the exact versions with `--save-exact`. Checks the installed tree. Runs `serverless package` when you pass `--package`. |
| `assert` | Reads the invoke payload. Checks `ok`, a `v22.x` runtime, the capability names, and the loaded versions. |

The function name is `ld-ai-canary-<stage>`. The workflow gives each run a unique stage.

### Local dry run

This run needs no AWS credentials.

```bash
cd integration-tests/lambda-commonjs
node canary.mjs build --ai-node=0.2.0 --openai-messages=0.2.0 --ai-otel=0.1.1 --package --stage=local
unzip -l .canary/app/.serverless/ld-ai-canary.zip | grep '@launchdarkly'
```

The config schema of Serverless 3 does not know the `nodejs22.x` runtime.
So the package step prints an `Invalid configuration encountered` warning for `provider.runtime`.
The fixture sets `configValidationMode: warn`, and the message stays a warning.
CloudFormation accepts the runtime. The function runs on Node 22.
The canary reads `process.version` and fails on any other runtime.

`yarn test:integration` runs `canary.test.ts`.
That file tests the assert logic and the exact-version guard.
It uses no network and no AWS account.

### AWS prerequisite

The workflow job uses GitHub OIDC only.
OIDC lets the job get short-lived AWS credentials from a role.
This repository holds no long-lived AWS keys. Please do not add any.

The job stays skipped until these repository variables exist.

| Variable | Purpose |
| --- | --- |
| `AWS_LAMBDA_CANARY_ROLE_ARN` | The role that the job assumes. The job is skipped while this variable is empty. |
| `AWS_LAMBDA_CANARY_REGION` | Optional. The default is `us-east-1`. |

The trust policy of the role must allow `token.actions.githubusercontent.com`.
Limit `sub` to `repo:launchdarkly/js-ai-sdk:*`.
Set `aud` to `https://github.com/launchdarkly`.

The role needs these permissions. Scope each one to the `ld-ai-canary-*` resources.

- `cloudformation:CreateStack`, `UpdateStack`, `DeleteStack`, `DescribeStacks`, `DescribeStackEvents`,
  `DescribeStackResource(s)`, `ValidateTemplate`, `GetTemplate`, `ListStackResources`
- `s3:CreateBucket`, `DeleteBucket`, `ListBucket`, `GetObject`, `PutObject`, `DeleteObject`,
  `GetBucketLocation`, `GetBucketPolicy`, `PutBucketPolicy`, `PutEncryptionConfiguration` on the
  Serverless deployment bucket
- `lambda:CreateFunction`, `DeleteFunction`, `GetFunction`, `GetFunctionConfiguration`,
  `UpdateFunctionCode`, `UpdateFunctionConfiguration`, `InvokeFunction`, `ListVersionsByFunction`,
  `TagResource`
- `logs:CreateLogGroup`, `DeleteLogGroup`, `DescribeLogGroups`, `PutRetentionPolicy`
- `iam:CreateRole`, `DeleteRole`, `GetRole`, `PassRole`, `PutRolePolicy`, `DeleteRolePolicy`,
  `AttachRolePolicy`, `DetachRolePolicy` for the execution role of the function

### When the canary fails

A failure means that a published package does not load from a CommonJS Lambda bundle.
That is the AIC-3370 bug again.

Run the local dry run above with the published versions.
Then invoke the generated bundle directly.

```bash
cd integration-tests/lambda-commonjs/.canary/app
node -e "require('./.webpack/service/handler.js').handler().then(console.log, console.error)"
```

The cleanup step always runs. The step prints an error when it cannot delete the stack.
Then you delete the `ld-ai-canary-<stage>` CloudFormation stack by hand.
You also delete the `/aws/lambda/ld-ai-canary-<stage>` log group by hand.
