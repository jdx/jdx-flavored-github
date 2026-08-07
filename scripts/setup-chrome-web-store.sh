#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="jdx-flavored-github"
EXPECTED_PROJECT_NUMBER="419461346573"
REPOSITORY="jdx/jdx-flavored-github"

SERVICE_ACCOUNT_ID="chrome-web-store"
POOL_ID="github"
PROVIDER_ID="jdx-flavored-github"

SERVICE_ACCOUNT="${SERVICE_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Authenticating with Google Cloud…"
gcloud auth login

echo "Selecting project ${PROJECT_ID}…"
gcloud config set project "$PROJECT_ID"

PROJECT_NUMBER="$(
  gcloud projects describe "$PROJECT_ID" \
    --format="value(projectNumber)"
)"

if [[ "$PROJECT_NUMBER" != "$EXPECTED_PROJECT_NUMBER" ]]; then
  echo "Unexpected project number: ${PROJECT_NUMBER}" >&2
  echo "Expected: ${EXPECTED_PROJECT_NUMBER}" >&2
  exit 1
fi

echo "Enabling required APIs…"
gcloud services enable \
  chromewebstore.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  --project="$PROJECT_ID"

echo "Creating the service account if necessary…"
if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" >/dev/null 2>&1
then
  gcloud iam service-accounts create "$SERVICE_ACCOUNT_ID" \
    --project="$PROJECT_ID" \
    --display-name="Chrome Web Store publisher"
else
  echo "Service account already exists."
fi

echo "Creating the Workload Identity Pool if necessary…"
if ! gcloud iam workload-identity-pools describe "$POOL_ID" \
  --project="$PROJECT_ID" \
  --location="global" >/dev/null 2>&1
then
  gcloud iam workload-identity-pools create "$POOL_ID" \
    --project="$PROJECT_ID" \
    --location="global" \
    --display-name="GitHub Actions"
else
  echo "Workload Identity Pool already exists."
fi

echo "Creating the GitHub OIDC provider if necessary…"
if ! gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT_ID" \
  --location="global" \
  --workload-identity-pool="$POOL_ID" >/dev/null 2>&1
then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" \
    --location="global" \
    --workload-identity-pool="$POOL_ID" \
    --display-name="jdx-flavored-github releases" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository == '${REPOSITORY}' && assertion.ref == 'refs/heads/main'"
else
  echo "GitHub OIDC provider already exists."
fi

POOL_NAME="$(
  gcloud iam workload-identity-pools describe "$POOL_ID" \
    --project="$PROJECT_ID" \
    --location="global" \
    --format="value(name)"
)"

echo "Allowing this GitHub repository to impersonate the service account…"
gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository/${REPOSITORY}" \
  >/dev/null

PROVIDER_NAME="$(
  gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
    --project="$PROJECT_ID" \
    --location="global" \
    --workload-identity-pool="$POOL_ID" \
    --format="value(name)"
)"

cat <<EOF

Google Cloud setup completed.

1. Add this service account in the Chrome Web Store Developer Dashboard
   under Account:

   ${SERVICE_ACCOUNT}

2. Create a GitHub environment named:

   chrome-web-store

3. Add these GitHub environment variables:

   CWS_EXTENSION_ID=dmiieoopojnjepheeimdcdlhdhdfiija
   CWS_SERVICE_ACCOUNT=${SERVICE_ACCOUNT}
   CWS_WORKLOAD_IDENTITY_PROVIDER=${PROVIDER_NAME}
   CWS_PUBLISHER_ID=<copy from Chrome Publisher > Settings>

These are environment variables, not secrets.
EOF
