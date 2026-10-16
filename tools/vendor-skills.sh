#!/usr/bin/env bash
# Re-vendor pinned third-party skills into .claude/skills.
# Usage: tools/vendor-skills.sh [tob_sha] [speckit_sha]
set -euo pipefail
TOB_SHA="${1:-5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0}"
SK_SHA="${2:-f6e72bc8523de8ec8368129cbdea78d45f27cef8}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.claude/skills"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT

fetch() {
  git init -q "$TMP/$1"
  git -C "$TMP/$1" remote add origin "$2"
  git -C "$TMP/$1" fetch -q --depth 1 origin "$3"
  git -C "$TMP/$1" checkout -q --detach FETCH_HEAD
  [ "$(git -C "$TMP/$1" rev-parse HEAD)" = "$3" ] || { echo "$1: wrong commit" >&2; exit 1; }
}
fetch tob https://github.com/trailofbits/skills.git "$TOB_SHA"
fetch speckit https://github.com/github/spec-kit.git "$SK_SHA"

# Plain skills
for s in property-based-testing supply-chain-risk-auditor; do
  rm -rf "${DEST:?}/${s:?}"
  cp -r "$TMP/tob/plugins/$s/skills/$s" "$DEST/$s"
  cp "$TMP/tob/LICENSE" "$DEST/$s/LICENSE"
done

# Workflow plugins (loaded as project plugins); evals and tests left out
for p in insecure-defaults spec-to-code-compliance; do
  rm -rf "${DEST:?}/${p:?}"
  mkdir -p "$DEST/$p"
  (cd "$TMP/tob/plugins/$p" && tar cf - --exclude=./evals --exclude=./tests --exclude=./evals-extra .) | (cd "$DEST/$p" && tar xf -)
  cp "$TMP/tob/LICENSE" "$DEST/$p/LICENSE"
done

# Spec Kit templates only (no commands or scripts)
mkdir -p "$DEST/spec-kit/templates"
cp "$TMP/speckit/templates/"{spec,plan,tasks,constitution,checklist}-template.md "$DEST/spec-kit/templates/"
cp "$TMP/speckit/LICENSE" "$DEST/spec-kit/LICENSE"

find "$DEST" -name __pycache__ -prune -exec rm -rf {} +
echo "Vendored trailofbits/skills@$TOB_SHA and github/spec-kit@$SK_SHA. Review: git diff -- .claude/skills"
