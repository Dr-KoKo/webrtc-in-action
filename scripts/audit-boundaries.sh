#!/usr/bin/env bash
# Boundary-rule enforcement for the per-mode layout (specs/architecture.md).
#
# Three rules:
#   1. shared/ must NEVER import a mode (frontend + backend).
#   2. one mode must NEVER import another mode (frontend + backend).
#   3. relative imports must NEVER escape a mode subdir or shared subdir
#      (forces all cross-tree imports through aliases / Go module paths).
#
# Run as part of the validation gate. The mode list is enumerated inline
# below — adding a new mode requires updating both the frontend
# (`for m in one-to-one mesh ...`) and backend (`for m in onetoone mesh ...`)
# loops.
#
# Uses grep -E (POSIX) so it works in any shell environment without
# requiring ripgrep.
set -euo pipefail
cd "$(dirname "$0")/.."

FRONT_MODES=(one-to-one mesh)
BACK_MODES=(onetoone mesh)

fail() {
  echo "VIOLATION: $1" >&2
  shift
  if [ "$#" -gt 0 ]; then
    "$@" >&2 || true
  fi
  exit 1
}

# 1a. Frontend shared/ MUST NOT import @/modes/*. Match
#     `from "@/modes/...` so comment mentions don't trigger the gate.
if grep -RInE 'from[[:space:]]+"@/modes/' frontend/src/shared/ >/dev/null; then
  fail "frontend src/shared/ imports @/modes/" \
    grep -RInE 'from[[:space:]]+"@/modes/' frontend/src/shared/
fi

# 1b. Frontend cross-mode imports forbidden.
for m in "${FRONT_MODES[@]}"; do
  for other in "${FRONT_MODES[@]}"; do
    [ "$m" = "$other" ] && continue
    if grep -RInE "from[[:space:]]+\"@/modes/$other" "frontend/src/modes/$m/" >/dev/null; then
      fail "frontend mode $m imports @/modes/$other" \
        grep -RInE "from[[:space:]]+\"@/modes/$other" "frontend/src/modes/$m/"
    fi
  done
done

# 1c. Frontend app/ MUST NOT import a mode entry component except
#     through the modes.tsx registry. Only modes.tsx is allowed to
#     import from @/modes/<id>/... directly. Match `from "@/modes/...`
#     so comment-text mentions of @/modes/* don't trigger the gate.
while IFS= read -r f; do
  base=$(basename "$f")
  [ "$base" = "modes.tsx" ] && continue
  if grep -E 'from[[:space:]]+"@/modes/' "$f" >/dev/null; then
    fail "frontend app/$base imports @/modes/* (only modes.tsx may)" \
      grep -nE 'from[[:space:]]+"@/modes/' "$f"
  fi
done < <(find frontend/src/app -type f \( -name '*.ts' -o -name '*.tsx' \))

# 1d. Frontend: relative imports must not escape a mode/shared subdir.
#     Inside src/modes/<m>/, any `from "(../){3,}"` is leaving the mode.
#     Inside src/shared/, any `from "(../){2,}"` is leaving shared.
if grep -RInE 'from "(\.\./){3,}' frontend/src/modes/ >/dev/null; then
  fail "frontend relative import escapes mode subdir (use @/-alias)" \
    grep -RInE 'from "(\.\./){3,}' frontend/src/modes/
fi
if grep -RInE 'from "(\.\./){2,}' frontend/src/shared/ >/dev/null; then
  fail "frontend relative import escapes shared subdir (use @/-alias)" \
    grep -RInE 'from "(\.\./){2,}' frontend/src/shared/
fi

# 1e. Frontend per-mode ring rules (specs/frontend-architecture.md §2.4).
#     Skips modes whose ring sub-dirs are not present yet, so a mode mid-
#     migration does not fail the gate; once a sub-dir exists, the rules
#     for it are enforced.
#
#       protocol/  must not import state/ or webrtc/ or components/ or route/
#       state/     must not import webrtc/ or components/ or route/
#       webrtc/    must not import components/ or route/
#       only route/ and mode/ may construct <StoreProvider>
for m in "${FRONT_MODES[@]}"; do
  base="frontend/src/modes/$m"

  if [ -d "$base/protocol" ]; then
    if grep -RInE 'from[[:space:]]+"(\.\./)+(state|webrtc|components|route)(/|")' "$base/protocol" >/dev/null 2>&1; then
      fail "frontend $m/protocol/ imports state|webrtc|components|route (Ring 2 schema isolation)" \
        grep -RInE 'from[[:space:]]+"(\.\./)+(state|webrtc|components|route)(/|")' "$base/protocol"
    fi
  fi

  if [ -d "$base/state" ]; then
    if grep -RInE 'from[[:space:]]+"(\.\./)+(webrtc|components|route)(/|")' "$base/state" >/dev/null 2>&1; then
      fail "frontend $m/state/ imports webrtc|components|route (Ring 2 store isolation)" \
        grep -RInE 'from[[:space:]]+"(\.\./)+(webrtc|components|route)(/|")' "$base/state"
    fi
  fi

  if [ -d "$base/webrtc" ]; then
    if grep -RInE 'from[[:space:]]+"(\.\./)+(components|route)(/|")' "$base/webrtc" >/dev/null 2>&1; then
      fail "frontend $m/webrtc/ imports components|route (Ring 3 verb isolation)" \
        grep -RInE 'from[[:space:]]+"(\.\./)+(components|route)(/|")' "$base/webrtc"
    fi
  fi

  # <StoreProvider> may only be constructed by route/ or mode/. Scan
  # JSX-style usage; the export itself lives in state/index.tsx and is
  # exempted explicitly. Tests/ are exempted because spec files
  # legitimately mount the provider in custom render rigs.
  while IFS= read -r f; do
    case "$f" in
      "$base"/route/*|"$base"/mode/*|"$base"/state/index.tsx|"$base"/tests/*)
        continue
        ;;
    esac
    if grep -nE '<StoreProvider' "$f" >/dev/null 2>&1; then
      fail "frontend $m: <StoreProvider> constructed outside route/ or mode/ ($f)" \
        grep -nE '<StoreProvider' "$f"
    fi
  done < <(find "$base" -type f \( -name '*.ts' -o -name '*.tsx' \))
done

# 2a. Backend shared/ MUST NOT depend on internal/modes/*.
(
  cd signaling
  if go list -deps ./internal/shared/... 2>/dev/null | grep -E '/internal/modes/' >/dev/null; then
    echo "VIOLATION: signaling internal/shared/ depends on internal/modes/" >&2
    go list -deps ./internal/shared/... 2>/dev/null | grep -E '/internal/modes/' >&2 || true
    exit 1
  fi
)

# 2b. Backend cross-mode dependencies forbidden.
(
  cd signaling
  for m in "${BACK_MODES[@]}"; do
    for other in "${BACK_MODES[@]}"; do
      [ "$m" = "$other" ] && continue
      if go list -deps "./internal/modes/$m/..." 2>/dev/null | grep -E "/internal/modes/$other" >/dev/null; then
        echo "VIOLATION: backend mode $m depends on internal/modes/$other" >&2
        exit 1
      fi
    done
  done
)

# 2c. Backend cmd/ MUST NOT import internal/modes/* directly.
#     cmd/signaling/main.go uses internal/app to wire mode handlers;
#     internal/app is the ONLY package allowed to import a mode pkg.
#     Use {{.Imports}} (direct only), not -deps (transitive — would
#     pick up modes via internal/app and false-positive).
(
  cd signaling
  if go list -f '{{range .Imports}}{{println .}}{{end}}' ./cmd/... 2>/dev/null \
    | grep -E '/internal/modes/' >/dev/null; then
    echo "VIOLATION: signaling cmd/ directly imports internal/modes/" >&2
    go list -f '{{.ImportPath}}: {{range .Imports}}{{println .}}{{end}}' ./cmd/... 2>/dev/null \
      | grep -E '/internal/modes/' >&2 || true
    exit 1
  fi
)

echo "Boundary audit clean."
