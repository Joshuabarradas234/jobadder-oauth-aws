/**
 * JobAdder OAuth on AWS — Generate JobAdder OAuth Auth URL
 * 
 * Run this ONCE locally after deployment to obtain your first token.
 * After you complete the flow, AWS handles all future token refreshes automatically.
 * 
 * Usage:
 *   REDIRECT_URI=https://xxx.execute-api.eu-west-2.amazonaws.com/production/oauth/callback \
 *   node generate-auth-url.js
 */

const CLIENT_ID = 'YOUR_JOBADDER_CLIENT_ID';

// Your new AWS Redirect URI — get this from CloudFormation output
// after running deploy.sh (the OAuthCallbackURL output)
const REDIRECT_URI = process.env.REDIRECT_URI || 
  'https://YOUR-API-ID.execute-api.eu-west-2.amazonaws.com/production/oauth/callback';

// JobAdder scopes — request what your integration needs
// Common scopes: read write offline_access
// offline_access is CRITICAL — gives you the refresh_token
const SCOPES = [
  'read',
  'write', 
  'offline_access',  // ← Required for refresh token
].join(' ');

// Build the authorisation URL
const authUrl = new URL('https://id.jobadder.com/connect/authorize');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('scope', SCOPES);

// Optional: add a state param to prevent CSRF (recommended for production)
const state = Math.random().toString(36).substring(2, 15);
authUrl.searchParams.set('state', state);

console.log('\n═══════════════════════════════════════════════════════');
console.log(' JobAdder OAuth on AWS — JobAdder OAuth Authorisation');
console.log('═══════════════════════════════════════════════════════');
console.log('\n 1. Open this URL in your browser:\n');
console.log(` ${authUrl.toString()}`);
console.log('\n 2. Log in to JobAdder and approve the integration');
console.log('\n 3. You\'ll be redirected to your AWS API Gateway endpoint');
console.log('    which will exchange the code for tokens and store them');
console.log('    in Secrets Manager automatically.');
console.log('\n 4. After this, EventBridge will refresh tokens every 50 min.');
console.log('\n Your state value (save this for CSRF validation):');
console.log(` ${state}`);
console.log('\n═══════════════════════════════════════════════════════\n');
