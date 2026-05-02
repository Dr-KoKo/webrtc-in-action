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

# Per-mode ring rules (specs/signaling-architecture.md §2.4). Each
# mode's three sub-packages must respect the dependency direction:
#
#   protocol/    pure schema — imports neither room/ nor signaling/
#   room/        pure state  — imports neither protocol/ nor signaling/
#   signaling/   verbs       — imports protocol/ + room/, NOT mode root,
#                              NOT shared/wsserver
#   mode root    only package wiring shared/wsserver to signaling.Service
#
# 3a. protocol/ must not import room/ or signaling/.
(
  cd signaling
  for m in "${BACK_MODES[@]}"; do
    if go list -deps "./internal/modes/$m/protocol/..." 2>/dev/null \
      | grep -E "/internal/modes/$m/(room|signaling)$" >/dev/null; then
      echo "VIOLATION: backend mode $m protocol/ imports room/ or signaling/" >&2
      go list -deps "./internal/modes/$m/protocol/..." 2>/dev/null \
        | grep -E "/internal/modes/$m/(room|signaling)$" >&2 || true
      exit 1
    fi
  done
)

# 3b. room/ must not import protocol/ or signaling/.
(
  cd signaling
  for m in "${BACK_MODES[@]}"; do
    if go list -deps "./internal/modes/$m/room/..." 2>/dev/null \
      | grep -E "/internal/modes/$m/(protocol|signaling)$" >/dev/null; then
      echo "VIOLATION: backend mode $m room/ imports protocol/ or signaling/" >&2
      go list -deps "./internal/modes/$m/room/..." 2>/dev/null \
        | grep -E "/internal/modes/$m/(protocol|signaling)$" >&2 || true
      exit 1
    fi
  done
)

# 3c. signaling/ must not import the mode root or shared/wsserver.
#     Use {{.Imports}} (direct only) — signaling/ legitimately
#     transitively reaches shared/wsserver via the mode-root types it
#     does NOT import; we want to catch only direct imports.
(
  cd signaling
  for m in "${BACK_MODES[@]}"; do
    bad=$(go list -f '{{range .Imports}}{{println .}}{{end}}' "./internal/modes/$m/signaling/..." 2>/dev/null \
      | grep -E "(/internal/modes/$m\$|/internal/shared/wsserver\$)" || true)
    if [ -n "$bad" ]; then
      echo "VIOLATION: backend mode $m signaling/ imports mode root or shared/wsserver" >&2
      echo "$bad" >&2
      exit 1
    fi
  done
)

# 3d. The mode root is the only package importing shared/wsserver.
#     {{.Imports}} catches direct imports only. Walk every backend
#     package; flag any package outside cmd/ + internal/app/ +
#     internal/modes/<m>/ (mode root file) that imports wsserver.
(
  cd signaling
  while IFS= read -r line; do
    pkg=${line%% *}
    imports=${line#* }
    case "$pkg" in
      webrtc-lab/signaling/cmd/*) ;;        # cmd/ uses wsserver via internal/app, not directly
      webrtc-lab/signaling/internal/shared/wsserver) ;;  # wsserver itself
      webrtc-lab/signaling/internal/modes/onetoone) ;;   # 1:1 mode root — allowed
      webrtc-lab/signaling/internal/modes/mesh) ;;       # mesh mode root — allowed
      *)
        if echo "$imports" | grep -qE 'internal/shared/wsserver'; then
          echo "VIOLATION: package $pkg directly imports shared/wsserver — only mode roots may" >&2
          echo "  imports: $imports" >&2
          exit 1
        fi
        ;;
    esac
  done < <(go list -f '{{.ImportPath}} {{join .Imports " "}}' ./... 2>/dev/null)
)

echo "Boundary audit clean."
