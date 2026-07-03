/**
 * JobAdder OAuth on AWS — JobAdder OAuth Callback Lambda
 * 
 * Triggered by: API Gateway GET /oauth/callback
 * Purpose:      Receives the auth code from JobAdder after user consent,
 *               exchanges it for access + refresh tokens, stores encrypted
 *               in Secrets Manager via KMS.
 * 
 * JobAdder Auth URL:  https://id.jobadder.com/connect/authorize
 * JobAdder Token URL: https://id.jobadder.com/connect/token
 */

const {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

const https = require('https');
const querystring = require('querystring');

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION || 'eu-west-2' });

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Fetch a secret from Secrets Manager (KMS decryption happens automatically).
 */
async function getSecret(secretArn) {
  const cmd = new GetSecretValueCommand({ SecretId: secretArn });
  const res = await sm.send(cmd);
  return JSON.parse(res.SecretString);
}

/**
 * POST to JobAdder token endpoint using Node's built-in https (no extra deps).
 */
function postForm(url, body) {
  return new Promise((resolve, reject) => {
    const postData = querystring.stringify(body);
    const urlObj = new URL(url);

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Token endpoint returned ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ─── handler ────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  console.log('OAuth callback received', JSON.stringify({
    queryParams: event.queryStringParameters,
    // Never log the actual code value in production
    hasCode: !!event.queryStringParameters?.code,
    hasError: !!event.queryStringParameters?.error,
  }));

  const params = event.queryStringParameters || {};

  // ── Error from JobAdder (user denied, etc.) ──────────────────────────────
  if (params.error) {
    console.error('JobAdder OAuth error:', params.error, params.error_description);
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html' },
      body: `<h2>Authorisation Failed</h2><p>${params.error_description || params.error}</p>`,
    };
  }

  const { code } = params;
  if (!code) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/html' },
      body: '<h2>Missing authorisation code</h2>',
    };
  }

  try {
    // 1. Retrieve client credentials from Secrets Manager (KMS-decrypted)
    const credentials = await getSecret(process.env.CLIENT_SECRET_ARN);

    // 2. Exchange auth code for tokens
    const tokenResponse = await postForm(process.env.JOBADDER_TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.REDIRECT_URI,
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
    });

    console.log('Token exchange successful', {
      token_type: tokenResponse.token_type,
      expires_in: tokenResponse.expires_in,
      scope: tokenResponse.scope,
      // Never log actual token values
    });

    // 3. Calculate absolute expiry timestamp
    const expiresAt = Math.floor(Date.now() / 1000) + (tokenResponse.expires_in || 3600);

    // 4. Store tokens in Secrets Manager (encrypted via KMS automatically)
    await sm.send(new PutSecretValueCommand({
      SecretId: process.env.TOKEN_SECRET_ARN,
      SecretString: JSON.stringify({
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        token_type: tokenResponse.token_type || 'Bearer',
        expires_at: expiresAt,
        scope: tokenResponse.scope || '',
        obtained_at: new Date().toISOString(),
      }),
    }));

    console.log('Tokens stored in Secrets Manager successfully');

    // 5. Return success page (or redirect to your app)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `
        <!DOCTYPE html>
        <html>
        <head>
          <title>JobAdder OAuth on AWS — Connected</title>
          <style>
            body { font-family: system-ui; display: flex; align-items: center; justify-content: center; 
                   min-height: 100vh; margin: 0; background: #0d1117; color: #e6edf3; }
            .card { background: #161b22; border: 1px solid #2ea043; border-radius: 12px;
                    padding: 40px; text-align: center; max-width: 400px; }
            h2 { color: #3fb950; margin-bottom: 8px; }
            p  { color: #8b949e; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>✅ JobAdder Connected</h2>
            <p>OAuth authorisation complete. JobAdder integration is now active.</p>
            <p style="margin-top:16px;font-size:12px;color:#484f58;">You can close this window.</p>
          </div>
        </body>
        </html>
      `,
    };
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'text/html' },
      body: `<h2>Internal Error</h2><p>Check CloudWatch logs for details.</p>`,
    };
  }
};

// ─── one-time: generate the auth URL (run locally to kick off OAuth) ────────
// 
// Use this to generate the URL you open in a browser to start the OAuth flow.
// 
// const CLIENT_ID = 'YOUR_JOBADDER_CLIENT_ID';
// const REDIRECT_URI = 'https://<api-id>.execute-api.eu-west-2.amazonaws.com/production/oauth/callback';
// const SCOPES = 'read write offline_access';  // adjust to your approved scopes
// 
// const authUrl = `https://id.jobadder.com/connect/authorize?` +
//   `response_type=code` +
//   `&client_id=${CLIENT_ID}` +
//   `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
//   `&scope=${encodeURIComponent(SCOPES)}`;
// 
// console.log('Open this URL in your browser:\n', authUrl);
