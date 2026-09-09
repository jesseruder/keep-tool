#!/bin/sh
set -eu
patch_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cache_dir=${1:-"$HOME/.claude/plugins/cache/openai-codex/codex/1.0.6"}
patch_file="$patch_dir/1.0.6-broker-ownership.patch"
cd -- "$cache_dir"
# --force disables automatic reversal: only a genuinely applied patch may skip.
if patch -p1 --force --dry-run -R < "$patch_file" >/dev/null 2>&1; then
  echo 'Codex broker ownership patch already applied.'
elif patch -p1 --batch --forward --dry-run < "$patch_file"; then
  patch -p1 --batch --forward < "$patch_file"
else
  echo 'ERROR: Codex broker ownership patch applies neither forward nor in reverse; inspect the cache version/local edits.' >&2
  exit 1
fi
