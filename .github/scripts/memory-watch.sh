#!/usr/bin/env bash
#
# Run a command while sampling system memory, so a corpus-wide rebuild that dies
# with exit 137 leaves evidence of how close it was rather than an opaque kill.
#
#   memory-watch.sh <label> -- <command> [args...]
#
# Every sample is echoed to *stderr* (the job log, never the piped stdout the
# build steps tee into their artifact logs), so a run the kernel kills still has
# its memory trace in the log. A summary line lands on stderr and, when
# GITHUB_STEP_SUMMARY is set, in the step summary.
#
# The command's exit status is forwarded unchanged: these steps read it (the
# fulltext build inspects PIPESTATUS[0] to decide whether to upload a
# checkpoint), so the wrapper must be transparent.
#
# MEMORY_WATCH_INTERVAL overrides the 30s sampling interval (used by the test).

set -uo pipefail

# `selftest` (with no `--`) checks the three properties the build steps rely on,
# so CI catches a regression here without waiting for a four-hour rebuild.
if [ "${1:-}" = selftest ] && [ "${2:-}" != "--" ]; then
  self="${BASH_SOURCE[0]}"
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  fail=0
  check() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1: expected '$3', got '$2'" >&2; fail=1; fi; }

  # 1. stdout passes through untouched and the exit status is forwarded, both
  #    read via PIPESTATUS exactly as the fulltext build step reads them.
  MEMORY_WATCH_INTERVAL=1 "$self" probe -- bash -c 'echo payload; exit 7' \
    2>"$work/err" | tee "$work/out" >/dev/null
  check "forwards the command's exit status" "${PIPESTATUS[0]}" 7
  check "passes stdout through unchanged" "$(cat "$work/out")" payload

  # 2. The summary reaches GITHUB_STEP_SUMMARY when the runner sets it.
  GITHUB_STEP_SUMMARY="$work/summary" MEMORY_WATCH_INTERVAL=1 \
    "$self" probe -- true >/dev/null 2>&1
  check "writes a step summary" \
    "$(grep -c '^probe: peak memory use' "$work/summary")" 1

  # 3. No sampler outlives the command. The sampler is a fork of this script, so
  #    a leaked one carries this argv and would keep writing for the whole job.
  MEMORY_WATCH_INTERVAL=1 "$self" leakprobe -- sleep 1 >/dev/null 2>&1
  sleep 2
  check "leaves no sampler behind" \
    "$(ps -eo args | grep -c "[m]emory-watch.sh leakprobe")" 0

  check "rejects a call with no command" \
    "$( "$self" nocommand >/dev/null 2>&1; echo $? )" 2

  [ "$fail" -eq 0 ] && echo "memory-watch.sh selftest passed"
  exit "$fail"
fi

label="${1:-command}"
shift || true
if [ "${1:-}" != "--" ] || [ "$#" -lt 2 ]; then
  echo "usage: memory-watch.sh <label> -- <command> [args...]" >&2
  exit 2
fi
shift

samples=$(mktemp)
# Guard the cleanup on being the top-level shell. Subshells inherit this trap,
# and the sampler below is killed while it may still be inside bash code rather
# than blocked in `sleep` -- bash then handles the signal and runs the inherited
# EXIT trap, removing the samples file before the summary awk reads it. The
# summary comes out empty and the trace this wrapper exists to leave is lost.
# The race needs the watched command to exit almost immediately, which is why
# the selftest (`-- true`) hit it perceptibly and long rebuilds did not; a
# command that dies fast is exactly the OOM case worth having a trace for.
trap 'if [ "$BASHPID" = "$$" ]; then rm -f "$samples"; fi' EXIT

interval="${MEMORY_WATCH_INTERVAL:-30}"

# One line per sample, human-readable up front and the raw kB triple in the last
# three fields so the summary below can read it back positionally.
# MemAvailable is the honest headroom figure -- it accounts for reclaimable page
# cache, which "used" does not -- and swap-in-use is what precedes a thrash.
sample_once() {
  awk -v label="$label" -v stamp="$(date -u +%H:%M:%SZ)" '
    /^MemTotal:/ { total = $2 }
    /^MemAvailable:/ { available = $2 }
    /^SwapTotal:/ { swap_total = $2 }
    /^SwapFree:/ { swap_free = $2 }
    END {
      printf "[memory-watch %s] %s used %.2f GiB / %.2f GiB, available %.2f GiB, swap %.2f GiB raw_kb %d %d %d\n",
        label, stamp, (total - available) / 1048576, total / 1048576,
        available / 1048576, (swap_total - swap_free) / 1048576,
        total, available, swap_total - swap_free
    }
  ' /proc/meminfo
}

# One synchronous baseline sample, so even a command that exits before the
# background sampler is first scheduled still reports a real figure.
baseline=$(sample_once)
printf '%s\n' "$baseline" >> "$samples"
printf '%s\n' "$baseline" >&2

# No pipeline inside the loop: a `... | tee` here forks children that outlive the
# kill below -- they inherit this script's argv, so they are invisible as a
# "stray tee" and keep sampling for the rest of the job.
( while :; do
    line=$(sample_once)
    printf '%s\n' "$line" >> "$samples"
    printf '%s\n' "$line" >&2
    sleep "$interval"
  done ) &
sampler=$!

"$@"
status=$?

kill "$sampler" 2>/dev/null || true
wait "$sampler" 2>/dev/null || true

summary=$(awk -v label="$label" -v status="$status" '
  { total = $(NF - 2); available = $(NF - 1); swap = $NF }
  NR == 1 { min_available = available; max_swap = swap }
  { if (available < min_available) min_available = available; if (swap > max_swap) max_swap = swap }
  END {
    if (NR == 0) { printf "%s: no memory samples collected (exit status %s).", label, status; exit }
    printf "%s: peak memory use %.2f GiB of %.2f GiB (min available %.2f GiB), peak swap %.2f GiB, over %d samples; exit status %s.",
      label, (total - min_available) / 1048576, total / 1048576,
      min_available / 1048576, max_swap / 1048576, NR, status
  }
' "$samples")

echo "$summary" >&2
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "$summary" >> "$GITHUB_STEP_SUMMARY"
fi

exit "$status"
