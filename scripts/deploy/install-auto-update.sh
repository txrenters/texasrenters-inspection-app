#!/usr/bin/env bash
#
# Installs the auto-update timer on the production host. Run as root, on the
# VPS, from the deployment checkout:
#
#   sudo GITHUB_TOKEN=ghp_xxx /opt/texasrenters/scripts/deploy/install-auto-update.sh
#
# Idempotent: re-running it re-checks every precondition, refreshes the units and
# leaves an already-correct host unchanged. Safe to run after every `git pull`.
#
# The token needs `read:packages` (to pull the images) and `repo` (to read
# releases from a private repository). Omit GITHUB_TOKEN to keep the one already
# in /etc/texasrenters/update.env — that is the normal case when re-running.
#
# ---------------------------------------------------------------------------
# Why this is a script and not a paragraph in the README
# ---------------------------------------------------------------------------
#
# Every step below is one that fails silently or confusingly when done by hand:
# a unit installed but not enabled runs never, a token without `repo` scope makes
# the releases API return 404 that reads as "no releases", and a checkout without
# the executable bit gives systemd a 203/EXEC that says nothing about why. Doing
# them in order, with the check afterwards, is the difference between believing
# this is installed and knowing it.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/texasrenters}"
ENV_FILE="${ENV_FILE:-${DEPLOY_DIR}/.env.production}"
UPDATE_ENV="${UPDATE_ENV:-/etc/texasrenters/update.env}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
SRC="${DEPLOY_DIR}/scripts/deploy"
REPO="${GITHUB_REPOSITORY:-txrenters/texasrenters-inspection-app}"

log()  { printf '  %s\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
die()  { printf '\nFATAL: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "Run this as root — it writes to ${UNIT_DIR} and ${UPDATE_ENV}."

step "Checking the host"
command -v docker >/dev/null || die "docker is not installed."
docker compose version >/dev/null 2>&1 || die "The docker compose plugin is not available."
command -v flock >/dev/null || die "flock is missing; auto-update.sh uses it to avoid concurrent deploys."
command -v curl  >/dev/null || die "curl is missing; the health check and releases API both need it."
ok "docker, compose, flock, curl"

step "Checking the deployment"
[ -d "${DEPLOY_DIR}" ] || die "${DEPLOY_DIR} does not exist. This installs onto a host that is already serving."
for f in compose.yaml compose.production.yaml; do
  [ -f "${DEPLOY_DIR}/${f}" ] || die "${DEPLOY_DIR}/${f} is missing — is this the deployment checkout?"
done
[ -f "${ENV_FILE}" ] || die "${ENV_FILE} does not exist."
CURRENT_TAG="$(sed -n 's/^IMAGE_TAG=//p' "${ENV_FILE}" | tail -1)"
[ -n "${CURRENT_TAG}" ] || die "IMAGE_TAG is not set in ${ENV_FILE}; auto-update.sh has nothing to compare against."
ok "${DEPLOY_DIR} is serving IMAGE_TAG=${CURRENT_TAG}"

# A checkout that predates the auto-update commit is the likeliest reason to be
# here twice. Say so plainly rather than failing later on a missing ExecStart.
[ -f "${SRC}/auto-update.sh" ] || die "${SRC}/auto-update.sh is missing. Run 'git pull' in ${DEPLOY_DIR} first — this host's checkout predates the auto-update commit."
chmod 0755 "${SRC}/auto-update.sh"
bash -n "${SRC}/auto-update.sh" || die "auto-update.sh does not parse."
ok "auto-update.sh present, executable and parses"

step "Writing ${UPDATE_ENV}"
# The registry credential belongs to the host that deploys, not to the
# application: .env.production is mounted into every container, this file is not.
install -d -m 0700 "$(dirname "${UPDATE_ENV}")"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  umask 077
  printf 'GITHUB_TOKEN=%s\n' "${GITHUB_TOKEN}" > "${UPDATE_ENV}"
  chmod 0600 "${UPDATE_ENV}"
  ok "token written (mode 600, root-owned)"
else
  [ -f "${UPDATE_ENV}" ] || die "GITHUB_TOKEN was not passed and ${UPDATE_ENV} does not exist yet."
  chmod 0600 "${UPDATE_ENV}"
  ok "keeping the existing token"
fi

step "Checking the token actually works"
# Both scopes get exercised here rather than at 3am from the timer. A private
# repo returns 404 to an unauthenticated or under-scoped call, which is
# indistinguishable from "this project has no releases" — so check it now.
TOKEN="$(sed -n 's/^GITHUB_TOKEN=//p' "${UPDATE_ENV}" | tail -1)"
[ -n "${TOKEN}" ] || die "${UPDATE_ENV} exists but contains no GITHUB_TOKEN."
LATEST="$(curl -fsS --max-time 30 -H "Authorization: Bearer ${TOKEN}" \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
  | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)" || true
[ -n "${LATEST}" ] || die "Could not read the newest release of ${REPO}. The token needs 'repo' scope for a private repository."
ok "releases API reachable; newest release is ${LATEST}"

# `docker login` is separate from the API call above and fails separately: an
# expired login is the one failure that leaves the deploy dead at the pull step.
echo "${TOKEN}" | docker login ghcr.io -u x-access-token --password-stdin >/dev/null 2>&1 \
  && ok "docker login ghcr.io succeeded" \
  || die "docker login ghcr.io failed. The token needs 'read:packages' — the images are private."

step "Installing the systemd units"
install -m 0644 "${SRC}/systemd/texasrenters-update.service" "${UNIT_DIR}/texasrenters-update.service"
install -m 0644 "${SRC}/systemd/texasrenters-update.timer"   "${UNIT_DIR}/texasrenters-update.timer"
systemctl daemon-reload
# The timer is enabled, not the service: enabling the service would run a deploy
# at every boot instead of on a schedule.
systemctl enable --now texasrenters-update.timer >/dev/null
ok "texasrenters-update.timer enabled and started"

step "Verifying, without deploying anything"
# --check compares the running tag to the newest release and changes nothing, so
# this proves the whole chain — env file, token, API, tag parsing — while the
# current release keeps serving.
GITHUB_TOKEN="${TOKEN}" "${SRC}/auto-update.sh" --check   || die "The --check run failed; see the output above."

printf '\n== Installed\n'
systemctl list-timers texasrenters-update.timer --no-pager 2>/dev/null | sed -n '1,3p'
cat <<'NEXT'

  Next release published on GitHub deploys within ~15 minutes, and rolls back
  automatically if readiness does not come up.

    systemctl list-timers texasrenters-update.timer   # when it next fires
    journalctl -u texasrenters-update.service -n 50   # what the last run did
    /opt/texasrenters/scripts/deploy/auto-update.sh --check   # report only
    /opt/texasrenters/scripts/deploy/auto-update.sh --force   # redeploy now

  Exit codes: 0 deployed or already current, 1 rolled back or still broken.
NEXT
