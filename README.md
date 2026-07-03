# JobAdder OAuth 2.0 Integration on AWS

[![CI](https://github.com/Joshuabarradas234/jobadder-oauth-aws/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Joshuabarradas234/jobadder-oauth-aws/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

**▶ [Live interactive demo](https://joshuabarradas234.github.io/jobadder-oauth-aws/docs/demo.html)** — watch the full pipeline run end-to-end in your browser (no setup, no backend).

A serverless AWS integration that connects to the [JobAdder](https://developers.jobadder.com)
recruitment API using the OAuth 2.0 authorization-code flow, with **automatic
token refresh** so the access token never lapses. Built entirely with native
AWS services — no third-party automation platform.

> **Background:** this is a sanitised reference version of a production
> integration I built for a recruitment startup, replacing a Make.com webhook
> with a native AWS stack. All client identifiers, secrets, endpoints and
> company-specific details have been removed and replaced with placeholders.

---

## The problem it solves

JobAdder issues OAuth access tokens that **expire after 60 minutes**. A naive
integration breaks every hour and needs a human to re-authorise. This stack
handles the full token lifecycle automatically: it completes the one-time OAuth
handshake, stores the tokens encrypted, and refreshes them on a schedule (and
on-demand if a call ever returns `401`) so downstream API calls keep working
indefinitely without manual intervention.

## Architecture

Open [`docs/architecture.html`](docs/architecture.html) in a browser for the
full interactive diagram, or [`docs/demo.html`](docs/demo.html) for an **animated
walkthrough** that visualises the whole pipeline running end-to-end (SQS → API
Gateway → Secrets Manager/KMS → Lambda → JobAdder → refresh), with a live event
log. In summary:

```
                    ┌──────────────────────────────────────────┐
   Browser  ──▶ API Gateway ──▶  OAuth Callback Lambda          │
 (one-time)                       └─ exchanges code for tokens  │
                                  └─ stores them (KMS-encrypted) │
                                                                 │
   EventBridge (rate: 50 min) ──▶ Token Refresh Lambda          │
                                  └─ refreshes before expiry     │
                                                                 │
   SQS queue ──▶ Candidate Fetcher Lambda ──▶ JobAdder API       │
                 └─ on 401: force-refresh, retry once            │
                 └─ failures ──▶ Dead-Letter Queue ──▶ SNS alert │
                    (all secrets in Secrets Manager + KMS)       │
```

### AWS services used

| Service | Role |
|---|---|
| **API Gateway (HTTP API)** | Receives the OAuth redirect callback and direct fetch requests |
| **Lambda** ×3 | OAuth callback, scheduled token refresh, candidate fetcher |
| **Secrets Manager** | Stores client credentials and the live access/refresh tokens |
| **KMS** | Customer-managed key encrypting all secrets, with rotation enabled |
| **EventBridge** | Triggers the token refresh every 50 minutes |
| **SQS + DLQ** | Queues candidate-fetch jobs; failures route to a dead-letter queue |
| **SNS** | Emails an alert on refresh failure or DLQ activity |
| **CloudWatch** | Logs and alarms (token-refresh errors, DLQ depth) |

## The three Lambdas

- **`oauth-callback`** — receives the authorization code from JobAdder after the
  user consents, exchanges it for access + refresh tokens, and stores them
  encrypted in Secrets Manager.
- **`token-refresh`** — invoked by EventBridge every 50 minutes (or directly on a
  `401`). Uses the refresh token to obtain a new access token before the old one
  expires. Handles refresh-token rotation.
- **`candidate-fetcher`** — reads the current token, calls the JobAdder API, and
  on a `401` force-refreshes the token and retries once. Runs from SQS (with
  partial-batch-failure reporting) or via direct API Gateway invocation.

## Security posture

- **No secrets in code.** The client secret is supplied at deploy time as a
  `NoEcho` CloudFormation parameter and stored in Secrets Manager. The repo
  contains only placeholders (`YOUR_JOBADDER_CLIENT_ID`).
- **Encryption at rest** via a customer-managed KMS key with rotation enabled.
- **Least-privilege IAM** — each Lambda has its own role scoped to the specific
  secret and key it needs.
- **No token values or PII in logs** — the code logs metadata (expiry, scope)
  but never the tokens or candidate data themselves.

## Deploy

```bash
export JOBADDER_CLIENT_SECRET="your-secret"     # never hard-coded
./scripts/deploy.sh
```

The script packages the Lambdas, deploys the CloudFormation stack, and prints
the OAuth redirect URI to register in the JobAdder developer portal. Then run
the one-time authorisation:

```bash
node scripts/generate-auth-url.js
```

Open the printed URL, approve access, and AWS handles every refresh from then on.

## Designed evolution: multi-tenant

The version here is **single-tenant** — one connected JobAdder account, tokens in
Secrets Manager. [`docs/multi-tenant-design.html`](docs/multi-tenant-design.html)
documents the **multi-tenant design** I proposed as the next step: one app,
many customers, one KMS-encrypted token **row per customer in DynamoDB** keyed by
account id, with per-tenant refresh and isolation — so onboarding a customer adds
a row, never new infrastructure. That document describes the design; the code in
this repo implements the single-tenant version it evolves from.

## What this demonstrates

- OAuth 2.0 authorization-code flow implemented end-to-end on AWS
- Automatic credential lifecycle management (scheduled + reactive refresh)
- Event-driven, serverless architecture with proper failure handling (DLQ, alarms)
- Secrets management and encryption done correctly (KMS, least privilege, no secrets in code)
- Infrastructure as code (single CloudFormation template, repeatable deploy)
- Tested decision logic (`node:test`) and CI on every push — ESLint, unit tests, and `cfn-lint` validation of the CloudFormation template

## Tests & CI

The token-refresh and API-status decision logic lives in [`lib/token-logic.js`](lib/token-logic.js)
as pure functions the Lambdas import, so it can be unit-tested without AWS, the
network, or the clock:

```bash
npm install
npm test      # node:test unit tests
npm run lint  # ESLint
```

GitHub Actions runs the lint + tests and validates `cloudformation.yaml` with
`cfn-lint` on every push.

## Repo layout

```
lambda/
  oauth-callback/      # code → tokens, stored encrypted
  token-refresh/       # scheduled + on-401 refresh
  candidate-fetcher/   # calls JobAdder API, 401→refresh→retry
lib/
  token-logic.js       # pure, unit-tested decision logic (shared by the Lambdas)
test/
  token-logic.test.js  # node:test unit tests
scripts/
  deploy.sh            # package + deploy + print redirect URI
  generate-auth-url.js # one-time OAuth kickoff
cloudformation.yaml    # the whole stack as IaC
.github/workflows/
  ci.yml               # ESLint + unit tests + cfn-lint on every push
docs/
  architecture.html         # interactive architecture diagram
  demo.html                 # animated end-to-end pipeline walkthrough
  multi-tenant-design.html  # proposed multi-tenant evolution
```
