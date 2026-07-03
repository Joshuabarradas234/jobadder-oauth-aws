/**
 * JobAdder OAuth on AWS — JobAdder Token Refresh Lambda
 * 
 * Triggered by: EventBridge schedule (every 50 minutes)
 *               OR invoked directly by candidate-fetcher on 401 response
 * Purpose:      Exchanges the refresh token for a new access token and
 *               stores it encrypted in Secrets Manager.
 * 
 * JobAdder tokens expire after 60 minutes.
 * Refresh tokens are long-lived (until explicitly revoked).
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

async function getSecret(secretArn) {
  const cmd = new GetSecretValueCommand({ SecretId: secretArn });
  const res = await sm.send(cmd);
  return JSON.parse(res.SecretString);
}

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
          reject(new Error(`Token refresh failed ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ─── handler ────────────────────────────────────────────────────────────────

exports.handler = async (event = {}) => {
  const source = event.source || 'direct-invoke';
  console.log(`Token refresh triggered by: ${source}`);

  // 1. Load current tokens from Secrets Manager
  let currentTokens;
  try {
    currentTokens = await getSecret(process.env.TOKEN_SECRET_ARN);
  } catch (err) {
    console.error('Failed to retrieve current tokens:', err.message);
    throw err;
  }

  if (!currentTokens.refresh_token) {
    const msg = 'No refresh token found in Secrets Manager. Re-run the OAuth flow to obtain one.';
    console.error(msg);
    throw new Error(msg);
  }

  // 2. Check if token is actually near expiry (skip if plenty of time left)
  //    Unless triggered by a 401, in which case force-refresh.
  const forced = event.force === true || source === 'candidate-fetcher-401';
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = currentTokens.expires_at || 0;
  const minutesRemaining = (expiresAt - nowSeconds) / 60;

  if (!forced && minutesRemaining > 15) {
    console.log(`Token still valid for ~${Math.round(minutesRemaining)} minutes. Skipping refresh.`);
    return { refreshed: false, minutesRemaining: Math.round(minutesRemaining) };
  }

  console.log(`Refreshing token. Minutes remaining: ${Math.round(minutesRemaining)}. Forced: ${forced}`);

  // 3. Load client credentials
  let credentials;
  try {
    credentials = await getSecret(process.env.CLIENT_SECRET_ARN);
  } catch (err) {
    console.error('Failed to retrieve client credentials:', err.message);
    throw err;
  }

  // 4. Call JobAdder token endpoint with refresh_token grant
  let tokenResponse;
  try {
    tokenResponse = await postForm(process.env.JOBADDER_TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: currentTokens.refresh_token,
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
    });
  } catch (err) {
    console.error('Token refresh HTTP call failed:', err.message);
    throw err;
  }

  console.log('New token obtained', {
    token_type: tokenResponse.token_type,
    expires_in: tokenResponse.expires_in,
    has_refresh_token: !!tokenResponse.refresh_token,
  });

  // 5. Store new tokens — refresh_token may rotate, always update both
  const newExpiresAt = nowSeconds + (tokenResponse.expires_in || 3600);

  await sm.send(new PutSecretValueCommand({
    SecretId: process.env.TOKEN_SECRET_ARN,
    SecretString: JSON.stringify({
      access_token: tokenResponse.access_token,
      // Some providers rotate the refresh token; fall back to existing if not
      refresh_token: tokenResponse.refresh_token || currentTokens.refresh_token,
      token_type: tokenResponse.token_type || 'Bearer',
      expires_at: newExpiresAt,
      scope: tokenResponse.scope || currentTokens.scope || '',
      refreshed_at: new Date().toISOString(),
    }),
  }));

  console.log(`Token refreshed and stored. New expiry: ${new Date(newExpiresAt * 1000).toISOString()}`);

  return {
    refreshed: true,
    expiresAt: new Date(newExpiresAt * 1000).toISOString(),
    minutesValid: Math.round(tokenResponse.expires_in / 60),
  };
};
