#!/usr/bin/env bash

set -euo pipefail

MODE="${1:-full}"
LONG_MIGRATION_TEST="tests/migrations/migration-runner.test.ts"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

echo "==> clean build artifacts"
rm -rf .next .open-next

echo "==> npm run lint"
npm run lint

if [[ "${MODE}" == "quick" ]]; then
  echo "==> npm run test:run (excluding ${LONG_MIGRATION_TEST})"
  npm run test:run -- --exclude "${LONG_MIGRATION_TEST}"
else
  echo "==> npm run test:run"
  npm run test:run
fi

if [[ "${MODE}" == "full" ]]; then
  echo "==> npx opennextjs-cloudflare build"
  npx opennextjs-cloudflare build
else
  echo "==> npm run build"
  npm run build
fi

echo "Verification complete (${MODE})."
