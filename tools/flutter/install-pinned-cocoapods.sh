#!/usr/bin/env bash
set -euo pipefail

test "$(uname -s)" = Darwin
test -n "${RUNNER_TEMP:-}"
test -n "${GITHUB_ENV:-}"

if [[ -x /opt/homebrew/opt/ruby/bin/gem ]]; then
  gem_binary=/opt/homebrew/opt/ruby/bin/gem
else
  gem_binary="$(command -v gem)"
fi
echo "Installing isolated CocoaPods with $gem_binary"
gem_home="$RUNNER_TEMP/bota-cocoapods-gems"
gem_bin="$RUNNER_TEMP/bota-cocoapods-bin"
"$gem_binary" install --no-document cocoapods -v 1.16.2 \
  --install-dir "$gem_home" --bindir "$gem_bin"

gem_path="$gem_home:$("$gem_binary" env path)"
pod_binary="$gem_bin/pod"
test -x "$pod_binary"
actual_version="$(GEM_HOME="$gem_home" GEM_PATH="$gem_path" "$pod_binary" _1.16.2_ --version)"
echo "Isolated CocoaPods version: $actual_version"
test "$actual_version" = 1.16.2

{
  printf 'GEM_HOME=%s\n' "$gem_home"
  printf 'GEM_PATH=%s\n' "$gem_path"
  printf 'POD_BINARY=%s\n' "$pod_binary"
} >> "$GITHUB_ENV"
