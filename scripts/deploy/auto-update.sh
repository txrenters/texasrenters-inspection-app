#!/usr/bin/env bash
#
# Deploys the newest published release, and puts the previous one back if the
# new one does not come up healthy.
#
#   scripts/deploy/auto-update.sh            # deploy if a newer release exists
#   scripts/deploy/auto-update.sh --check    # report only, change nothing
#   scripts/deploy/auto-update.sh --force    # redeploy even if the tag matches
#
# Intended to run unattended from the systemd units beside this file: the timer
# every five minutes, and the path unit as soon as the image workflow says a
# release's images are published. It is safe to run by hand, and safe to run
# concurrently — a second invocation exits rather than racing the first.
#
# ---------------------------------------------------------------------------
# What this does NOT do, and why
# ---------------------------------------------------------------------------
#
# It does not roll the database back. `migrate` runs `prisma migrate deploy`,
# which is forward-only: there is no down-migration to apply. If a release adds
# a migration and then fails its health check, putting the old images back
# leaves the schema ahead of the code that is now running.
#
# Restoring a dump instead would discard every inspection, photograph and upload
# written since the deploy — losing a technician's morning to recover from a bad
# release is worse than the bad release. So a rollback here is images only, and
# a rollback that crossed a migration says so loudly and expects a human.
#
# The practical consequence: keep migrations backward compatible. Add columns,
# do not rename or drop them in the same release that starts using the new
# shape. Then the previous image keeps working against the newer schema and this
# rollback is complete rather than partial.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/texasrenters}"
ENV_FILE="${ENV_FILE:-${DEPLOY_DIR}/.env.production}"
STATE_DIR="${STATE_DIR:-/var/lib/texasrenters}"
STATE_FILE="${STATE_FILE:-${STATE_DIR}/deploy-state}"
LOCK_FILE="${LOCK_FILE:-/var/lock/texasrenters-update.lock}"
REPO="${GITHUB_REPOSITORY:-txrenters/texasrenters-inspection-app}"
HEALTH_URL="${HEALTH_URL:-https://inspection-api.texasrenters.com/api/v1/health/readiness}"

# How long to give a new release to become healthy before calling it a failure.
# The backend waits on the migrate one-shot, which waits on postgres, so a cold
# start is legitimately slow — but a release that has not answered in four
# minutes is not going to.
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-24}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-10}"

COMPOSE=(docker compose --env-file "${ENV_FILE}"
         -f "${DEPLOY_DIR}/compose.yaml"
         -f "${DEPLOY_DIR}/compose.production.yaml")

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "FATAL: $*" >&2; exit 1; }

CHECK_ONLY=0
FORCE=0
for arg in "$@"; do
  case "${arg}" in
    --check) CHECK_ONLY=1 ;;
    --force) FORCE=1 ;;
    *) die "Unknown argument: ${arg}" ;;
  esac
done

# ---------------------------------------------------------------------------
# One at a time
# ---------------------------------------------------------------------------
# Without this, a slow deploy still running when the timer next fires would have
# two runs rewriting IMAGE_TAG and calling `up -d` against the same project.
exec 9>"${LOCK_FILE}"
flock -n 9 || { log "Another update is already running; exiting."; exit 0; }

[ -f "${ENV_FILE}" ] || die "${ENV_FILE} does not exist."
mkdir -p "${STATE_DIR}"

# ---------------------------------------------------------------------------
# What is running, and what is published
# ---------------------------------------------------------------------------
read_env() { sed -n "s/^$1=//p" "${ENV_FILE}" | tail -1; }

CURRENT_TAG="$(read_env IMAGE_TAG)"
[ -n "${CURRENT_TAG}" ] || die "IMAGE_TAG is not set in ${ENV_FILE}."
REGISTRY="$(read_env IMAGE_REGISTRY)"
REGISTRY="${REGISTRY:-ghcr.io/txrenters/texasrenters-inspection-app}"

# The releases API first: a release is the thing a human decided to ship, and
# `latest` moves without saying to what. The repository is private, so an
# unauthenticated call returns 404 and is indistinguishable from "no releases".
[ -n "${GITHUB_TOKEN:-}" ] || die "GITHUB_TOKEN is not set — a private repository's releases cannot be read without it."

# The newest release whose images are in the registry, by its version tag.
#
# What to deploy when the releases API cannot be read. Since the repository went
# private (2026-10-16, and again 2026-10-19) this host's token -- a read:packages
# PAT, which reads the registry but not the repository -- has had a 404 from the
# API on every check, and no release deployed while it did.
#
# The registry is the next best word on what was shipped: an X.Y.Z tag is written
# only by *Publish images*, from a published release's tag (docker/metadata-action
# `type=semver`), and both images must carry it. Not the deploy request the
# workflow sends: the backend writes that file, and the backend must not be able
# to choose what this host deploys. Prints nothing when it cannot tell.
newest_registry_release() {
  local host="${REGISTRY%%/*}" path="${REGISTRY#*/}" image token tags common=""
  [ "${host}" = "ghcr.io" ] || return 1
  for image in backend web; do
    token="$(curl -fsS --max-time 30 -u "token:${GITHUB_TOKEN}" \
      "https://ghcr.io/token?service=ghcr.io&scope=repository:${path}/${image}:pull" 2>/dev/null \
      | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')" || return 1
    [ -n "${token}" ] || return 1
    tags="$(curl -fsS --max-time 30 -H "Authorization: Bearer ${token}" \
      "https://ghcr.io/v2/${path}/${image}/tags/list?n=10000" 2>/dev/null \
      | grep -oE '"[0-9]+\.[0-9]+\.[0-9]+"' | tr -d '"' | sort -u)" || return 1
    [ -n "${tags}" ] || return 1
    if [ "${image}" = backend ]; then common="${tags}"; else common="$(comm -12 <(printf '%s\n' "${common}") <(printf '%s\n' "${tags}"))"; fi
  done
  printf '%s\n' "${common}" | sort -V | tail -1
}

PUBLISHED_AT=""
if api_response="$(curl -fsS --max-time 30 \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null)"; then
  # `v1.0.0` in git, `1.0.0` in the registry — docker/metadata-action strips the
  # prefix, so IMAGE_TAG=v1.0.0 fails to pull with a message that reads like the
  # image was never published.
  LATEST_TAG="$(printf '%s' "${api_response}" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  LATEST_TAG="${LATEST_TAG#v}"
  [ -n "${LATEST_TAG}" ] || die "Could not read tag_name from the releases API response."
  PUBLISHED_AT="$(printf '%s' "${api_response}" | sed -n 's/.*"published_at"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
else
  log "Could not read the GitHub releases API; asking the registry for the newest release instead."
  LATEST_TAG="$(newest_registry_release || true)"
  [ -n "${LATEST_TAG}" ] || die "Could not reach the GitHub releases API or the registry. Leaving ${CURRENT_TAG} in place."
  # Never a step back on the registry's word: a release set here by hand, or one
  # whose tag the registry has lost, stays where it is.
  if [ "$(printf '%s\n%s\n' "${LATEST_TAG}" "${CURRENT_TAG}" | sort -V | tail -1)" != "${LATEST_TAG}" ]; then
    log "The registry's newest release, ${LATEST_TAG}, is older than ${CURRENT_TAG}; leaving ${CURRENT_TAG} in place."
    LATEST_TAG="${CURRENT_TAG}"
  fi
fi

log "running=${CURRENT_TAG} published=${LATEST_TAG}"

if [ "${CHECK_ONLY}" -eq 1 ]; then
  if [ "${CURRENT_TAG}" = "${LATEST_TAG}" ]; then
    log "Up to date."
  else
    log "Update available: ${CURRENT_TAG} -> ${LATEST_TAG}"
  fi
  exit 0
fi

if [ "${CURRENT_TAG}" = "${LATEST_TAG}" ] && [ "${FORCE}" -eq 0 ]; then
  log "Already on ${CURRENT_TAG}; nothing to do."
  exit 0
fi

# ---------------------------------------------------------------------------
# Pull before touching anything
# ---------------------------------------------------------------------------
# A registry that is unreachable, a tag that does not exist, or an expired
# docker login should all fail here — with the old release still serving —
# rather than half way through a restart.
#
# Except a release whose images are still being built. *Publish images* starts
# when the release is published and takes several minutes, so a check in that
# gap finds a release with no images yet. That is not a failure, and checking
# every five minutes it happens on nearly every release: this run leaves the
# running release alone, and the workflow's request (texasrenters-update.path)
# or the next check deploys it. It counts as a failure again once the release is
# older than any build takes, so a registry that never gets the images still
# says so. (2.5.73, 2026-09-17: FATAL "Could not pull backend:2.5.73" at 13:22,
# deployed at 13:39.)
IMAGE_WAIT_SECONDS="${IMAGE_WAIT_SECONDS:-2700}"
# No date reads as long ago, so a missing image is reported. `date -d ""` would
# answer midnight today instead. (A release found in the registry has no date,
# and needs none: its images are there.)
published_epoch=0
if [ -n "${PUBLISHED_AT}" ]; then
  published_epoch="$(date -u -d "${PUBLISHED_AT}" +%s 2>/dev/null || echo 0)"
fi
release_age=$(( $(date -u +%s) - published_epoch ))

log "Pulling ${REGISTRY}/{backend,web}:${LATEST_TAG}"
for image in backend web; do
  if ! pull_error="$(docker pull --quiet "${REGISTRY}/${image}:${LATEST_TAG}" 2>&1 >/dev/null)"; then
    case "${pull_error}" in
      *'not found'*|*'manifest unknown'*)
        if [ "${release_age}" -lt "${IMAGE_WAIT_SECONDS}" ]; then
          log "${image}:${LATEST_TAG} is not in the registry yet (released ${release_age}s ago, images still publishing). ${CURRENT_TAG} keeps serving."
          exit 0
        fi
        ;;
    esac
    die "Could not pull ${image}:${LATEST_TAG}: ${pull_error}. Nothing was changed; ${CURRENT_TAG} is still serving."
  fi
done

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
set_tag() {
  local tag="$1" tmp
  tmp="$(mktemp)"
  # Written whole and moved into place: a torn .env.production is a stack that
  # will not start at all, which is a much worse failure than the one being
  # recovered from.
  sed "s/^IMAGE_TAG=.*/IMAGE_TAG=${tag}/" "${ENV_FILE}" > "${tmp}"
  grep -q "^IMAGE_TAG=${tag}$" "${tmp}" || { rm -f "${tmp}"; die "Failed to rewrite IMAGE_TAG."; }
  chmod --reference="${ENV_FILE}" "${tmp}" 2>/dev/null || chmod 600 "${tmp}"
  mv "${tmp}" "${ENV_FILE}"
}

healthy() {
  local attempt=1 body
  while [ "${attempt}" -le "${HEALTH_ATTEMPTS}" ]; do
    body="$(curl -fsS --max-time 15 "${HEALTH_URL}" 2>/dev/null || true)"
    # Readiness, not liveness: liveness answers before the database does, and a
    # release whose migration failed would sail straight through it.
    case "${body}" in
      *'"status":"ready"'*)
        log "Healthy after ${attempt} attempt(s)."
        return 0
        ;;
    esac
    sleep "${HEALTH_INTERVAL}"
    attempt=$((attempt + 1))
  done
  return 1
}

log "Deploying ${LATEST_TAG}"
{
  printf 'previous=%s\n' "${CURRENT_TAG}"
  printf 'current=%s\n' "${LATEST_TAG}"
  printf 'at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "${STATE_FILE}"
set_tag "${LATEST_TAG}"

deploy_failed=0
"${COMPOSE[@]}" up -d --remove-orphans || deploy_failed=1

if [ "${deploy_failed}" -eq 0 ] && healthy; then
  log "Deployed ${LATEST_TAG} successfully."
  # Only once the new release is serving. Pruning earlier would delete the image
  # the rollback path depends on.
  docker image prune -f >/dev/null 2>&1 || true
  exit 0
fi

# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------
log "ERROR: ${LATEST_TAG} did not become healthy. Rolling back to ${CURRENT_TAG}."

# Whether the migration ran is the difference between a complete rollback and a
# partial one, and it is worth stating in the log rather than leaving someone to
# infer it at three in the morning.
if "${COMPOSE[@]}" logs --no-log-prefix --tail 200 migrate 2>/dev/null \
     | grep -qiE 'applying migration|migrations? applied'; then
  log "WARNING: this release applied a database migration. The schema is NOT being"
  log "WARNING: rolled back — only the images are. If ${CURRENT_TAG} cannot run"
  log "WARNING: against the newer schema, this host needs a human now."
fi

set_tag "${CURRENT_TAG}"
if ! "${COMPOSE[@]}" up -d --remove-orphans; then
  die "Rollback to ${CURRENT_TAG} failed to start. This host is down and needs a human."
fi

if healthy; then
  log "Rolled back to ${CURRENT_TAG}; the service is healthy again."
  exit 1
fi

die "Rolled back to ${CURRENT_TAG} but the service is still unhealthy. This host is down and needs a human."
