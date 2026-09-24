#!/usr/bin/env bash
set -euo pipefail

test "$(uname -s)" = Darwin
test -n "${RUNNER_TEMP:-}"
test -n "${GITHUB_ENV:-}"

ruby_bin=/opt/homebrew/opt/ruby/bin
test -x "$ruby_bin/gem"
gem_home="$RUNNER_TEMP/bota-cocoapods-gems"
gem_bin="$RUNNER_TEMP/bota-cocoapods-bin"
"$ruby_bin/gem" install --no-document cocoapods -v 1.16.2 \
  --install-dir "$gem_home" --bindir "$gem_bin"

gem_path="$gem_home:$("$ruby_bin/gem" env path)"
pod_binary="$gem_bin/pod"
test -x "$pod_binary"
test "$(GEM_HOME="$gem_home" GEM_PATH="$gem_path" "$pod_binary" --version)" = 1.16.2

{
  printf 'GEM_HOME=%s\n' "$gem_home"
  printf 'GEM_PATH=%s\n' "$gem_path"
  printf 'POD_BINARY=%s\n' "$pod_binary"
} >> "$GITHUB_ENV"
