# Phase 13 production-ish signaling image (multi-stage).
#
# Scope (plan §Phase 13 + §Non-Goals): local-dev packaging target,
# not a cloud-deploy artifact. Intentionally minimal — no shell, no
# package manager, no build toolchain in the final image.
#
# Runtime choice: gcr.io/distroless/static-debian12:nonroot.
#   - Why distroless: smallest attack surface, no shell, binary runs
#     as uid 65532 (nonroot) with no writable paths beyond /tmp.
#   - Consequence: the compose healthcheck cannot call wget / curl.
#     Solution: ship a second stdlib-only Go binary at /healthprobe
#     that does GET /healthz and exits 0/1. See cmd/healthprobe/.
#     Tradeoff considered & rejected: "use a sidecar with a shell"
#     (doubles container count for localhost dev), "skip healthcheck"
#     (violates T090 DoD — compose depends_on needs service_healthy).
#
# Binary flags:
#   CGO_ENABLED=0  → fully static, runs on distroless/static.
#   -trimpath      → drop build-host absolute paths from the binary
#                    (reproducible builds; also avoids leaking local
#                    user directory names into the image).
#   -ldflags='-s -w' → strip symbol + debug tables; ~30% smaller.

# -----------------------------------------------------------------
# Stage 1 — build: compile both binaries with identical toolchain.
# -----------------------------------------------------------------
FROM golang:1.23 AS build

ENV CGO_ENABLED=0 \
    GOOS=linux

WORKDIR /src

# Module cache priming — lockfile-only copy so unchanged deps
# reuse the module-download layer.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN go build -trimpath -ldflags='-s -w' -o /out/signaling ./cmd/signaling
RUN go build -trimpath -ldflags='-s -w' -o /out/healthprobe ./cmd/healthprobe

# -----------------------------------------------------------------
# Stage 2 — runtime: distroless/static, nonroot.
# -----------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot

# distroless images preserve the nonroot user from the tag suffix
# (uid/gid 65532:65532). Make it explicit so a future retag cannot
# silently drop us to root.
USER 65532:65532

COPY --from=build /out/signaling /signaling
COPY --from=build /out/healthprobe /healthprobe

EXPOSE 8080

ENTRYPOINT ["/signaling"]
