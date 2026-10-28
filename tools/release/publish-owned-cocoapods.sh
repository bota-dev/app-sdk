#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${1:-}"
SPEC_JSON="${2:-}"
CHECKSUM="${3:-}"
if [[ $# -ne 3 || ! -f "$SPEC_JSON" || ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ || ! "$CHECKSUM" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'usage: publish-owned-cocoapods.sh <version> <approved-podspec.json> <archive-sha256>' >&2
  exit 2
fi

temporary="$(mktemp -d "${RUNNER_TEMP:-/tmp}/bota-specs-publish.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT
INDEX="$temporary/index"
# The public index is read without a credential. Only an absent, approved
# version needs a repository-scoped credential in the protected job.
git -c credential.helper= -c http.followRedirects=false clone --quiet --depth 1 --branch main \
  https://github.com/bota-dev/cocoapods-specs.git "$INDEX"
RESULT="$(node "$ROOT/tools/release/owned-cocoapods.mjs" stage "$VERSION" "$CHECKSUM" "$SPEC_JSON" "$INDEX")"
SPEC_PATH="$(node -e 'console.log(JSON.parse(process.argv[1]).path)' "$RESULT")"
CREATED="$(node -e 'console.log(JSON.parse(process.argv[1]).created)' "$RESULT")"
if [[ "$CREATED" == true ]]; then
  [[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ]] || {
    echo 'An exact approved GitHub run and attempt are required for a new Specs publication branch' >&2
    exit 1
  }
  test -n "${BOTA_COCOAPODS_SPECS_TOKEN:-}" || {
    echo 'BOTA_COCOAPODS_SPECS_TOKEN is required to append this version to the Bota Specs repository' >&2
    exit 1
  }
  command -v gh >/dev/null
  publish_push() {
    # No token in the remote URL, process argv, Git config or credential store.
    # The approved token is restricted to this repository's Contents and PRs.
    GH_HOST=github.com GH_TOKEN="$BOTA_COCOAPODS_SPECS_TOKEN" \
      git -c credential.helper= -c 'credential.helper=!gh auth git-credential' \
        -c credential.useHttpPath=true -c http.followRedirects=false -C "$INDEX" \
        push https://github.com/bota-dev/cocoapods-specs.git "$1"
  }
  git -C "$INDEX" add -- "$SPEC_PATH"
  test "$(git -C "$INDEX" diff --cached --name-only)" = "$SPEC_PATH"
  git -c core.hooksPath=/dev/null -C "$INDEX" \
    -c user.name='bota-sdk-release' -c user.email='noreply@bota.dev' \
    commit --quiet -m "Publish immutable CocoaPod $VERSION" \
    -m 'Co-Authored-By: OpenAI Codex <noreply@openai.com>'
  # Validate the exact immutable commit before submitting its protected PR.
  # Independent approval and merge follow the existing organization rules.
  publication_ref="refs/heads/publish/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
  publish_push "HEAD:$publication_ref"
  node "$ROOT/tools/release/wait-owned-spec-checks.mjs" "$(git -C "$INDEX" rev-parse HEAD)"
  node "$ROOT/tools/release/owned-specs-pull-request.mjs" \
    "$(git -C "$INDEX" rev-parse HEAD)" "${publication_ref#refs/heads/}"
  unset BOTA_COCOAPODS_SPECS_TOKEN
fi

# A new public raw path can take a short time to propagate. Every attempt
# checks the entire spec against the approved immutable archive identity.
for attempt in {1..12}; do
  if node "$ROOT/tools/release/owned-cocoapods.mjs" verify-public "$VERSION" "$CHECKSUM" "$SPEC_JSON"; then
    echo "Bota Specs published and verified $VERSION"
    exit 0
  fi
  if [[ "$attempt" -lt 12 ]]; then sleep 10; fi
done
echo 'Bota Specs readback failed; inspect the existing index commit before retrying publication' >&2
exit 1
