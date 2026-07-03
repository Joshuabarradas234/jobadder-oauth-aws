#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# JobAdder OAuth on AWS — JobAdder AWS Stack Deployment Script
# 
# Prerequisites:
#   - AWS CLI v2 installed and configured (aws configure)
#   - Profile with permissions to create CloudFormation, Lambda, IAM, SQS,
#     Secrets Manager, KMS, API Gateway, EventBridge, CloudWatch
#   - zip installed (for Lambda packaging)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
STACK_NAME="jobadder-oauth"
ENVIRONMENT="${ENVIRONMENT:-production}"
REGION="eu-west-2"
AWS_PROFILE="${AWS_PROFILE:-default}"
S3_BUCKET="${S3_BUCKET:-}"       # Set this to your S3 bucket for Lambda uploads
ALERT_EMAIL="${ALERT_EMAIL:-alerts@example.com}"

CLIENT_ID="YOUR_JOBADDER_CLIENT_ID"
# Load from environment — NEVER hardcode the secret in scripts
CLIENT_SECRET="${JOBADDER_CLIENT_SECRET:?'Set JOBADDER_CLIENT_SECRET env var'}"

echo "═══════════════════════════════════════════════════════"
echo " JobAdder OAuth on AWS — JobAdder AWS Deployment"
echo " Stack:  ${STACK_NAME}-${ENVIRONMENT}"
echo " Region: ${REGION}"
echo "═══════════════════════════════════════════════════════"

# ── Step 1: Create S3 bucket for Lambda packages (if not set) ────────────────
if [ -z "$S3_BUCKET" ]; then
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile "$AWS_PROFILE")
  S3_BUCKET="jobadder-oauth-deployments-${ACCOUNT_ID}-${REGION}"
  
  echo "⟳ Creating S3 bucket: ${S3_BUCKET}"
  aws s3 mb "s3://${S3_BUCKET}" --region "$REGION" --profile "$AWS_PROFILE" 2>/dev/null || true
  aws s3api put-bucket-versioning \
    --bucket "$S3_BUCKET" \
    --versioning-configuration Status=Enabled \
    --profile "$AWS_PROFILE"
fi

# ── Step 2: Package Lambda functions ─────────────────────────────────────────
echo ""
echo "⟳ Packaging Lambda functions..."

LAMBDAS=("oauth-callback" "token-refresh" "candidate-fetcher")

for fn in "${LAMBDAS[@]}"; do
  echo "  Packaging: ${fn}"
  cd "lambda/${fn}"
  
  # Install production dependencies if package.json exists
  if [ -f package.json ]; then
    npm ci --only=production --silent
  fi
  
  # Create zip
  zip -r "../../dist/${fn}.zip" . --quiet
  cd ../..
  
  # Upload to S3
  aws s3 cp "dist/${fn}.zip" \
    "s3://${S3_BUCKET}/lambda/${STACK_NAME}/${fn}.zip" \
    --profile "$AWS_PROFILE" \
    --region "$REGION"
  
  echo "  ✓ ${fn} uploaded"
done

# ── Step 3: Deploy CloudFormation stack ──────────────────────────────────────
echo ""
echo "⟳ Deploying CloudFormation stack..."

aws cloudformation deploy \
  --stack-name "${STACK_NAME}-${ENVIRONMENT}" \
  --template-file cloudformation.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --region "$REGION" \
  --profile "$AWS_PROFILE" \
  --parameter-overrides \
    "Environment=${ENVIRONMENT}" \
    "JobAdderClientId=${CLIENT_ID}" \
    "JobAdderClientSecret=${CLIENT_SECRET}" \
    "AlertEmail=${ALERT_EMAIL}" \
  --tags \
    "Project=JobAdderOAuth" \
    "Integration=JobAdder" \
    "Environment=${ENVIRONMENT}"

echo "✓ Stack deployed"

# ── Step 4: Update Lambda code from S3 ───────────────────────────────────────
echo ""
echo "⟳ Updating Lambda function code..."

for fn in "${LAMBDAS[@]}"; do
  FN_NAME="jobadder-oauth-${fn}-${ENVIRONMENT}"
  aws lambda update-function-code \
    --function-name "$FN_NAME" \
    --s3-bucket "$S3_BUCKET" \
    --s3-key "lambda/${STACK_NAME}/${fn}.zip" \
    --region "$REGION" \
    --profile "$AWS_PROFILE" \
    --output text \
    --query 'FunctionName' > /dev/null
  echo "  ✓ ${FN_NAME} updated"
done

# ── Step 5: Get the new Redirect URI ─────────────────────────────────────────
echo ""
echo "⟳ Retrieving outputs..."

REDIRECT_URI=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}-${ENVIRONMENT}" \
  --region "$REGION" \
  --profile "$AWS_PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='OAuthCallbackURL'].OutputValue" \
  --output text)

CANDIDATE_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}-${ENVIRONMENT}" \
  --region "$REGION" \
  --profile "$AWS_PROFILE" \
  --query "Stacks[0].Outputs[?OutputKey=='CandidateFetchEndpoint'].OutputValue" \
  --output text)

echo ""
echo "═══════════════════════════════════════════════════════"
echo " ✅ DEPLOYMENT COMPLETE"
echo "═══════════════════════════════════════════════════════"
echo ""
echo " ⚠️  ACTION REQUIRED — Update JobAdder Developer Portal:"
echo ""
echo "  NEW (AWS):       ${REDIRECT_URI}"
echo ""
echo " Update at: https://developers.jobadder.com"
echo " Navigate to your app → Edit → Redirect URIs"
echo ""
echo "═══════════════════════════════════════════════════════"
echo ""
echo " Then run the OAuth flow to obtain your first token:"
echo ""
echo "  node generate-auth-url.js"
echo ""
echo " Candidate Fetch API:"
echo "  POST ${CANDIDATE_ENDPOINT}"
echo '  Body: {"candidateId": "12345678"}'
echo ""
echo "═══════════════════════════════════════════════════════"
