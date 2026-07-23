#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_PATH="$(bash "${SCRIPT_DIR}/cf-config.sh")"

cd "${REPO_ROOT}"

echo "==> using wrangler config: ${CONFIG_PATH}"
bash "${SCRIPT_DIR}/cf-validate-config.sh" "${CONFIG_PATH}"

rm -rf .next .open-next
npx opennextjs-cloudflare build

CANDIDATE_ID="${MIGRATION_CANDIDATE_ID:-$(git rev-parse HEAD)}"
echo "==> applying ledgered D1 migrations for candidate ${CANDIDATE_ID}"
node "${REPO_ROOT}/scripts/migrations.mjs" apply \
  --database DB \
  --remote \
  --config "${CONFIG_PATH}" \
  --candidate "${CANDIDATE_ID}"

npx opennextjs-cloudflare deploy -c "${CONFIG_PATH}"
