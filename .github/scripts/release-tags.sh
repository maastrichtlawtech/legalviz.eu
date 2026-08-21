#!/usr/bin/env bash
#
# Shared release-tag grammar for the three refresh workflows (data, fulltext,
# corpus). Every release tag this repository mints is dated:
#
#   <prefix>-YYYY-MM-DD.NN     e.g. data-2026-08-21.01
#
# The date is the UTC day of the release and NN is a zero-padded same-day
# sequence starting at 01, so two runs on the same day can never collide on a
# tag. The older `<prefix>-vN` grammar is still *accepted* wherever an existing
# tag is read (the Dockerfile pins, the "latest corpus" lookup) but is never
# minted again; it always sorts below any dated tag.
#
# Subcommands:
#   validate <prefix> <tag>   accept a dated or legacy tag, else exit 1
#   latest <prefix>           highest published, non-prerelease tag for prefix
#   resolve <prefix>          mint or resume today's tag; prints tag=/state=
#   selftest                  exercise the pure helpers with fixtures, offline
#
# `resolve` reads the current tag list and is therefore not atomic: two runs of
# the same workflow resolving at the same instant would pick the same counter.
# Each refresh workflow serialises itself with a `concurrency:` group that does
# not cancel in progress, which is what makes that safe.
#
# `resolve` prints GITHUB_OUTPUT-shaped lines:
#   tag=data-2026-08-21.02
#   state=absent            (no release for that tag yet)
#   state=draft             (an interrupted run left a draft to resume)
set -euo pipefail

dated_pattern() { printf '^%s-[0-9]{4}-[0-9]{2}-[0-9]{2}[.][0-9]{2}$' "$1"; }
legacy_pattern() { printf '^%s-v[0-9]+$' "$1"; }

# Sort key that keeps legacy tags below dated ones: jq's default string order
# would rank "data-2026-…" before "data-v13" because '2' < 'v'.
_sort_key_jq() {
  cat <<JQ
def sort_key(\$prefix):
  if test("^" + \$prefix + "-v[0-9]+$")
  then [0, (sub("^" + \$prefix + "-v"; "") | tonumber), ""]
  else [1, 0, .]
  end;
JQ
}

# stdin: JSON array of {tagName, isDraft, isPrerelease}
# stdout: highest published, non-prerelease tag for the prefix (empty if none).
_latest_from_json() {
  local prefix="$1"
  jq -r --arg prefix "$prefix" "$(_sort_key_jq)"'
    [ .[]
      | select(.isDraft == false and .isPrerelease == false)
      | .tagName
      | select(test("^" + $prefix + "-([0-9]{4}-[0-9]{2}-[0-9]{2}[.][0-9]{2}|v[0-9]+)$"))
    ]
    | sort_by(sort_key($prefix))
    | if length == 0 then "" else .[-1] end
  '
}

# stdin: candidate tag names, one per line (releases and plain git tags alike)
# stdout: the next free zero-padded counter for <prefix>-<day>.
_next_counter() {
  local prefix="$1" day="$2" highest
  highest=$(sed -n "s/^${prefix}-${day}\.\([0-9][0-9]\)$/\1/p" | sed 's/^0*//' | sort -n | tail -n 1)
  highest=${highest:-0}
  if [ "$highest" -ge 99 ]; then
    echo "Refusing to mint a 100th ${prefix} release for ${day}" >&2
    return 1
  fi
  printf '%02d\n' "$((highest + 1))"
}

_release_list_json() {
  gh release list --repo "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}" \
    --limit 200 --json tagName,isDraft,isPrerelease
}

cmd_validate() {
  local prefix="$1" tag="$2"
  if [[ "$tag" =~ $(dated_pattern "$prefix") ]] || [[ "$tag" =~ $(legacy_pattern "$prefix") ]]; then
    return 0
  fi
  echo "Not a valid ${prefix} release tag: ${tag}" >&2
  return 1
}

cmd_latest() {
  local prefix="$1" tag
  tag=$(_release_list_json | _latest_from_json "$prefix")
  if [ -z "$tag" ]; then
    echo "No published ${prefix} release found" >&2
    return 1
  fi
  printf '%s\n' "$tag"
}

cmd_resolve() {
  local prefix="$1" day releases candidates highest counter
  day=$(date -u +%Y-%m-%d)
  releases=$(_release_list_json)

  # Any state: a draft from an interrupted run still owns its tag, and a bare
  # git tag with no release behind it would still fail `gh release create`.
  candidates=$(jq -r '.[].tagName' <<< "$releases")
  candidates+=$'\n'$(git ls-remote --tags origin 2>/dev/null \
    | sed -n 's#.*refs/tags/\([^^]*\)$#\1#p' || true)

  highest=$(grep -E "^${prefix}-${day}[.][0-9]{2}$" <<< "$candidates" | sort | tail -n 1 || true)
  if [ -n "$highest" ] \
    && [ "$(jq -r --arg tag "$highest" '[.[] | select(.tagName == $tag) | .isDraft] | first // false' <<< "$releases")" = true ]; then
    printf 'tag=%s\nstate=draft\n' "$highest"
    return 0
  fi

  counter=$(printf '%s\n' "$candidates" | _next_counter "$prefix" "$day")
  printf 'tag=%s-%s.%s\nstate=absent\n' "$prefix" "$day" "$counter"
}

cmd_selftest() {
  local got want
  want='corpus-2026-08-21.02'
  got=$(printf '%s' '[
    {"tagName":"corpus-v1","isDraft":false,"isPrerelease":false},
    {"tagName":"corpus-v10","isDraft":false,"isPrerelease":false},
    {"tagName":"corpus-2026-08-21.02","isDraft":false,"isPrerelease":false},
    {"tagName":"corpus-2026-08-21.01","isDraft":false,"isPrerelease":false},
    {"tagName":"corpus-2026-08-22.01","isDraft":true,"isPrerelease":false},
    {"tagName":"corpus-2026-08-23.01","isDraft":false,"isPrerelease":true},
    {"tagName":"data-2026-09-01.01","isDraft":false,"isPrerelease":false}
  ]' | _latest_from_json corpus)
  test "$got" = "$want" || { echo "latest: got $got, want $want" >&2; return 1; }

  # Legacy-only history still resolves, and a dated tag outranks it.
  got=$(printf '%s' '[{"tagName":"data-v9","isDraft":false,"isPrerelease":false},
                      {"tagName":"data-v13","isDraft":false,"isPrerelease":false}]' \
    | _latest_from_json data)
  test "$got" = "data-v13" || { echo "latest legacy: got $got" >&2; return 1; }

  got=$(printf '%s\n' data-v13 data-2026-08-21.01 data-2026-08-21.09 data-2026-08-20.11 other \
    | _next_counter data 2026-08-21)
  test "$got" = "10" || { echo "next_counter: got $got, want 10" >&2; return 1; }

  got=$(printf '%s\n' data-v13 corpus-2026-08-21.04 | _next_counter data 2026-08-21)
  test "$got" = "01" || { echo "next_counter empty day: got $got, want 01" >&2; return 1; }

  got=$(printf '%s\n' data-2026-08-21.99 | _next_counter data 2026-08-21 2>/dev/null) && {
    echo "next_counter: expected failure past .99, got $got" >&2; return 1; }

  for tag in data-2026-08-21.01 data-v13; do
    cmd_validate data "$tag" || { echo "validate rejected $tag" >&2; return 1; }
  done
  for tag in data-2026-08-21.1 data-2026-8-21.01 data-2026-08-21 corpus-2026-08-21.01 data-v; do
    cmd_validate data "$tag" 2>/dev/null && { echo "validate accepted $tag" >&2; return 1; }
  done

  echo "release-tags.sh selftest passed"
}

case "${1:-}" in
  validate) shift; cmd_validate "$@" ;;
  latest) shift; cmd_latest "$@" ;;
  resolve) shift; cmd_resolve "$@" ;;
  selftest) shift; cmd_selftest "$@" ;;
  *) echo "usage: release-tags.sh {validate|latest|resolve|selftest} [args]" >&2; exit 2 ;;
esac
