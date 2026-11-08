#!/usr/bin/env bash
# Prod gate (T-0050). A tag may go to prod only if staging has run it, successfully and alone, for at least an hour:
#   - staging has no deploy-in-progress marker (a deploy that started and did not finish leaves it, so a record left by an earlier success
#     is not trusted while a later deploy is unsettled);
#   - staging's deployed-image-tag record names this tag;
#   - that record was last written at least MIN_AGE seconds ago (the parameter's own LastModifiedDate).
# The one other way in is a rollback: a tag in the history of prod's own deployed-image-tag parameter (written only after a deploy passed its
# smoke suite) is the way back and needs no staging soak.
# Any failure to READ a parameter other than ParameterNotFound (AccessDenied...) fails the gate.
# Env: TAG; profiles `staging` and `deploy` (prod). Optional MIN_AGE (default 3600).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools/release/deploy/lib.sh
. "$here/lib.sh"
min_age="${MIN_AGE:-3600}"

rc=0
history="$(ssm_call get-parameter-history deploy /kesher/prod/deployed-image-tag)" || rc=$?
if [ "$rc" -eq 0 ]; then
  if jq -e --arg tag "$TAG" '.Parameters | map(.Value) | index($tag) != null' <<<"$history" >/dev/null; then
    echo "::notice::${TAG} was deployed to prod before, so this is a rollback; the staging soak does not apply."
    exit 0
  fi
elif [ "$rc" -ne 3 ]; then
  echo "::error::Could not read prod's deployed-image-tag history."
  exit 1
fi

rc=0
marker="$(ssm_call get-parameter staging /kesher/staging/deploy-in-progress)" || rc=$?
if [ "$rc" -eq 0 ]; then
  echo "::error::A deploy of $(jq -r '.Parameter.Value' <<<"$marker") to staging started and has not finished (or failed). Staging's state is unsettled; finish a staging deploy of ${TAG} first."
  exit 1
elif [ "$rc" -ne 3 ]; then
  echo "::error::Could not read staging's deploy-in-progress marker."
  exit 1
fi

rc=0
record="$(ssm_call get-parameter staging /kesher/staging/deployed-image-tag)" || rc=$?
if [ "$rc" -eq 3 ]; then
  echo "::error::Staging has no deployed-image-tag record. Deploy ${TAG} to staging first and let it run for an hour."
  exit 1
elif [ "$rc" -ne 0 ]; then
  echo "::error::Could not read staging's deployed-image-tag record."
  exit 1
fi
staging_tag="$(jq -r '.Parameter.Value' <<<"$record")"
if [ "$staging_tag" != "$TAG" ]; then
  echo "::error::Staging runs ${staging_tag}, not ${TAG}. Deploy ${TAG} to staging first and let it run for an hour."
  exit 1
fi
modified="$(jq -r '.Parameter.LastModifiedDate' <<<"$record")"
if [[ "$modified" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  modified_epoch="${modified%%.*}"
else
  modified_epoch="$(date -u -d "$modified" +%s)"
fi
age=$(($(date -u +%s) - modified_epoch))
if [ "$age" -lt "$min_age" ]; then
  echo "::error::Staging has run ${TAG} for ${age} seconds; prod needs ${min_age}. Try again later."
  exit 1
fi
echo "Staging has run ${TAG} for ${age} seconds (at least ${min_age}); prod may take it."
