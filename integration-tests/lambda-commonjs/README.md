# Published-artifact Lambda release canary

Owner: the LaunchDarkly AI SDK team (maintainers of `launchdarkly/js-ai-sdk`).

This fixture is the post-publish half of the [AIC-3370](https://launchdarkly.atlassian.net/browse/AIC-3370)
CommonJS work. The `integration-tests/commonjs-webpack` suite proves that *packed* artifacts load from a
Webpack CommonJS bundle; this canary proves the same thing for the artifacts that actually reached npm,
running inside a real Node 22 AWS Lambda.

It installs **exact published versions** — never workspace links, never a dist-tag — bundles them with
Serverless Framework 3, Webpack 5 and `webpack-node-externals` 3 (so the LaunchDarkly packages stay
external and are resolved by Node at runtime, the AIC-3370 failure path), deploys an ephemeral function,
invokes it once, asserts the capability payload, and removes the function and its log group.

The canary loads packages only. It uses **no SDK key, evaluates no flag, and makes no model call**, so it
costs nothing beyond a single Lambda invocation.

## What runs

`canary.mjs` is the whole driver. It takes one exact version per package, either as flags or as
`LD_AI_CANARY_VERSIONS='ai-node=0.3.0,openai-messages=0.3.0,ai-otel=0.2.0'`, and refuses anything that is
not an exact semver.

| Command | What it does |
| --- | --- |
| `wait` | Polls `npm view` until all three versions are visible (npm publishes are not immediately readable). |
| `build` | Stages `.canary/app` from `fixture/`, installs the exact versions with `--save-exact`, verifies the resolved tree, and optionally runs `serverless package`. |
| `assert` | Validates an invoke payload: `ok`, a `v22.x` runtime, the expected capability symbols, and the exact versions the Lambda loaded. |

The deployed function is `ld-ai-canary-<stage>`, where the workflow uses a stage unique to the run.

## Local dry run (no AWS credentials needed)

```bash
cd integration-tests/lambda-commonjs
node canary.mjs build --ai-node=0.2.0 --openai-messages=0.2.0 --ai-otel=0.1.1 --package --stage=local
unzip -l .canary/app/.serverless/ld-ai-canary.zip | grep '@launchdarkly'
```

Serverless 3 does not know the `nodejs22.x` runtime in its config schema, so packaging prints an
`Invalid configuration encountered` warning for `provider.runtime`. The fixture sets
`configValidationMode: warn` so this stays a warning; CloudFormation accepts the runtime and the deployed
function is Node 22 (the canary asserts `process.version` to prove it).

`yarn test:integration` runs `canary.test.ts`, which covers the assertion logic and the exact-version
guard without touching the network or AWS.

## AWS prerequisite

The workflow job authenticates with GitHub OIDC only — **there are no long-lived AWS keys in this repo and
none may be added.** It stays skipped until these repository variables exist:

| Variable | Purpose |
| --- | --- |
| `AWS_LAMBDA_CANARY_ROLE_ARN` | Role assumed via OIDC. Required; the job is skipped while unset. |
| `AWS_LAMBDA_CANARY_REGION` | Optional, defaults to `us-east-1`. |

The role's trust policy should allow `token.actions.githubusercontent.com` with
`sub` restricted to `repo:launchdarkly/js-ai-sdk:*` and `aud` of `https://github.com/launchdarkly`.

Least-privilege permissions needed by deploy, invoke and cleanup, all scoped to the canary's own
resources (`ld-ai-canary-*`):

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
  `AttachRolePolicy`, `DetachRolePolicy` for the function's execution role

## When it fails

A failure means a published artifact cannot be loaded from a CommonJS Lambda bundle — the AIC-3370 bug,
reintroduced. Reproduce locally with the dry run above against the published versions, then invoke the
generated bundle directly:

```bash
cd integration-tests/lambda-commonjs/.canary/app
node -e "require('./.webpack/service/handler.js').handler().then(console.log, console.error)"
```

Cleanup always runs. If it still fails, the workflow annotates the run with the leftover stage name; delete
the `ld-ai-canary-<stage>` CloudFormation stack and the `/aws/lambda/ld-ai-canary-<stage>` log group by hand.
