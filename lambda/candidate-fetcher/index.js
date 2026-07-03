/**
 * JobAdder OAuth on AWS — JobAdder Candidate Fetcher Lambda
 * 
 * Triggered by: SQS queue (jobadder-oauth-jobs)
 *               OR API Gateway POST /candidates/fetch (direct)
 * Purpose:      Authenticates with JobAdder Bearer token and fetches
 *               candidate data from GET /v2/candidates/{candidateId}
 * 
 * Supports:
 *   - Automatic 401 → token refresh → retry (single retry)
 *   - SQS partial batch failure (ReportBatchItemFailures)
 *   - X-Ray tracing
 */

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

const {
  LambdaClient,
  InvokeCommand,
} = require('@aws-sdk/client-lambda');

const https = require('https');
const { classifyApiStatus } = require('../../lib/token-logic');

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'eu-west-2' });
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'eu-west-2' });

const JOBADDER_API_BASE = process.env.JOBADDER_API_BASE || 'https://api.jobadder.com/v2';
const TOKEN_REFRESH_FUNCTION = process.env.TOKEN_REFRESH_FUNCTION;

// ─── helpers ────────────────────────────────────────────────────────────────

async function getTokens() {
  const cmd = new GetSecretValueCommand({ SecretId: process.env.TOKEN_SECRET_ARN });
  const res = await sm.send(cmd);
  return JSON.parse(res.SecretString);
}

/**
 * Force-invoke the token-refresh Lambda and wait for completion.
 * Used on 401 response before retrying the API call.
 */
async function forceTokenRefresh() {
  console.log('401 received — force-invoking token refresh Lambda');
  const cmd = new InvokeCommand({
    FunctionName: TOKEN_REFRESH_FUNCTION,
    InvocationType: 'RequestResponse',
    Payload: JSON.stringify({ force: true, source: 'candidate-fetcher-401' }),
  });
  const result = await lambda.send(cmd);
  const response = JSON.parse(Buffer.from(result.Payload).toString());
  console.log('Token refresh completed:', response);
  return response;
}

/**
 * GET a JobAdder API endpoint with Bearer token.
 * Returns { statusCode, data }.
 */
function apiGet(path, accessToken) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(`${JOBADDER_API_BASE}${path}`);

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'JobAdderOAuthDemo/1.0',
        'X-JobAdder-App': 'JobAdderOAuthDemo',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          data: res.statusCode !== 204 ? (() => { try { return JSON.parse(data); } catch { return data; } })() : null,
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetch a single candidate by ID, with one 401-triggered token refresh retry.
 */
async function fetchCandidate(candidateId) {
  let tokens = await getTokens();

  let response = await apiGet(`/candidates/${candidateId}`, tokens.access_token);

  if (response.statusCode === 401) {
    console.warn(`401 on candidate ${candidateId} — refreshing token and retrying`);
    await forceTokenRefresh();

    // Re-fetch tokens after refresh
    tokens = await getTokens();
    response = await apiGet(`/candidates/${candidateId}`, tokens.access_token);
  }

  switch (classifyApiStatus(response.statusCode)) {
    case 'ok':
      console.log(`Candidate ${candidateId} fetched successfully`);
      return { success: true, candidateId, data: response.data };
    case 'not_found':
      console.warn(`Candidate ${candidateId} not found (404) — removing from queue`);
      // Return success=true so SQS deletes the message (it's not retryable)
      return { success: true, candidateId, notFound: true };
    default:
      // Any other error — throw to let SQS retry / route to DLQ
      throw new Error(
        `JobAdder API error ${response.statusCode} for candidate ${candidateId}: ${JSON.stringify(response.data)}`
      );
  }
}

// ─── handler ────────────────────────────────────────────────────────────────

exports.handler = async (event) => {

  // ── Direct API Gateway invocation ──────────────────────────────────────
  if (event.requestContext?.http) {
    const body = JSON.parse(event.body || '{}');
    const candidateId = body.candidateId;

    if (!candidateId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'candidateId is required' }),
      };
    }

    try {
      const result = await fetchCandidate(String(candidateId));
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      };
    } catch (err) {
      console.error('Candidate fetch failed:', err.message);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: err.message }),
      };
    }
  }

  // ── SQS batch invocation ────────────────────────────────────────────────
  // 
  // Each SQS message body should be JSON like:
  //   { "candidateId": "12345678", "requestedBy": "JobAdderOAuthDemo", "jobId": "optional" }
  //
  const batchItemFailures = [];

  for (const record of event.Records) {
    let candidateId;
    try {
      const messageBody = JSON.parse(record.body);
      candidateId = messageBody.candidateId;

      if (!candidateId) {
        console.error('SQS message missing candidateId, skipping:', record.messageId);
        continue; // Don't DLQ malformed messages — just drop them
      }

      const result = await fetchCandidate(String(candidateId));

      if (result.notFound) {
        console.warn(`Candidate ${candidateId} not found, message discarded`);
      } else {
        // ── Process result ──────────────────────────────────────────────────
        // This is where you'd write to DynamoDB, trigger downstream processing,
        // emit to EventBridge, format the CV, etc.
        // For now, we log the candidate summary.
        console.log('Candidate data received:', JSON.stringify({
          candidateId,
          firstName: result.data?.firstName,
          lastName: result.data?.lastName,
          email: result.data?.email,
          status: result.data?.status?.name,
          // Add your processing logic here
        }));
      }
    } catch (err) {
      console.error(`Failed to process candidate ${candidateId}:`, err.message);
      // Report this message as failed — SQS will retry up to maxReceiveCount (3),
      // then route to DLQ
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

// ─── send a candidate fetch job to SQS (utility — run from your app) ────────
//
// To queue candidate 12345678 for fetching:
//
// const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
// const sqsClient = new SQSClient({ region: 'eu-west-2' });
//
// await sqsClient.send(new SendMessageCommand({
//   QueueUrl: process.env.CANDIDATE_JOB_QUEUE_URL,
//   MessageBody: JSON.stringify({
//     candidateId: '12345678',
//     requestedBy: 'JobAdderOAuthDemo',
//     requestedAt: new Date().toISOString(),
//   }),
// }));
