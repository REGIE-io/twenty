# Dev ECS Deployment

This directory contains the task definition templates used by
`.github/workflows/cd-deploy-main.yaml` for the `twenty-dev` GitHub
environment.

The workflow builds `packages/twenty-docker/twenty/Dockerfile` with target
`twenty` for `linux/arm64`, tags the image with the full commit SHA and
`dev-latest`, registers server and worker task definition revisions, deploys
the server first, then deploys the worker after the server service is stable.

## Runtime Secret

Create one Secrets Manager JSON secret:

`twenty-crm-dev/twenty-runtime-env`

Required JSON keys:

- `PG_DATABASE_URL`
- `REDIS_URL`
- `APP_SECRET`
- `ENCRYPTION_KEY`
- `TWENTY_INTERNAL_METADATA_TOKEN`
- `SENTRY_DSN`
- `SENTRY_FRONT_DSN`

Copy the WREN CRM DSN from `twenty-crm-dev/crm-api-sentry-key` into both
`SENTRY_DSN` and `SENTRY_FRONT_DSN`. Do not put these values in GitHub secrets.

## GitHub Environment

Environment: `twenty-dev`

Vars:

- `AWS_ACCOUNT_ID=841229410010`
- `AWS_REGION=us-east-1`
- `AWS_ROLE_TO_ASSUME=arn:aws:iam::841229410010:role/github-actions-twenty-dev-deploy`
- `ECR_REPOSITORY=twenty-crm-dev/twenty`
- `ECS_CLUSTER=twenty-crm-dev`
- `ECS_SERVER_SERVICE=twenty-crm-dev-server`
- `ECS_WORKER_SERVICE=twenty-crm-dev-worker`
- `SERVER_CONTAINER_NAME=server`
- `WORKER_CONTAINER_NAME=worker`
- `SENTRY_ORG=regieai`
- `SENTRY_PROJECT=wren-crm`
- `TWENTY_DEV_BASE_URL=https://twenty-dev.regieai.com`
- `TWENTY_RUNTIME_ENV_SECRET_NAME=twenty-crm-dev/twenty-runtime-env`
- `DOCKER_PLATFORM=linux/arm64`

Optional secret:

- `SENTRY_AUTH_TOKEN` for release/source-map upload to `regieai/wren-crm`.

## Deploy Role

The deploy role should trust GitHub OIDC for this repository and environment.
Because the workflow job uses `environment: twenty-dev`, GitHub's default OIDC
subject is:

`repo:REGIE-io/twenty:environment:twenty-dev`

Restrict deployment to `main` with GitHub environment protection rules, or use
a customized OIDC subject template if AWS must also match `ref:refs/heads/main`
directly.

Allow:

- ECR auth and push for `twenty-crm-dev/twenty`
- `secretsmanager:DescribeSecret` for
  `twenty-crm-dev/twenty-runtime-env`
- `ecs:RegisterTaskDefinition`
- `ecs:DescribeServices`, `ecs:DescribeTaskDefinition`, `ecs:UpdateService`
  for `twenty-crm-dev-server` and `twenty-crm-dev-worker`
- `ecs:ListTasks`, `ecs:DescribeTasks`
- `iam:PassRole` for `twenty-crm-dev-execution` and `twenty-crm-dev-task`
- `elasticloadbalancing:DescribeTargetHealth`
- `logs:DescribeLogStreams`, `logs:GetLogEvents`, `logs:FilterLogEvents`
  for `/ecs/twenty-crm-dev-server` and `/ecs/twenty-crm-dev-worker`

The ECS task execution role also needs `secretsmanager:GetSecretValue` for
`twenty-crm-dev/twenty-runtime-env`; the deploy role only reads metadata so it
can render the full ARN in task definitions.
