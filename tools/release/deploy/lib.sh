#!/usr/bin/env bash
# Shared by the deploy workflow's scripts (T-0050). Source it; it sets no shell options.

# ssm_call <get-parameter|get-parameter-history> <profile> <name>
# Prints the JSON answer on stdout and returns 0. Returns 3 when the parameter does not exist (ParameterNotFound, and nothing else), and 1 for
# every other failure (AccessDenied, throttling, no network...) after copying the CLI's message to stderr. stderr is never mixed into stdout,
# so the caller can hand stdout to jq.
ssm_call() {
  local sub="$1" profile="$2" name="$3" err out rc=0
  err="$(mktemp)"
  out="$(aws ssm "$sub" --profile "$profile" --name "$name" --output json 2>"$err")" || rc=$?
  if [ "$rc" -eq 0 ]; then
    rm -f "$err"
    printf '%s\n' "$out"
    return 0
  fi
  if grep -q ParameterNotFound "$err"; then
    rm -f "$err"
    return 3
  fi
  cat "$err" >&2
  rm -f "$err"
  return 1
}
