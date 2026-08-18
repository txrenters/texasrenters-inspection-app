#!/usr/bin/env bash
#
# Prepares a fresh Ubuntu VPS to run this stack. Read it before running it —
# it installs packages and changes the firewall.
#
#   scp scripts/deploy/provision-vps.sh root@<vps>:/tmp/
#   ssh root@<vps> 'bash /tmp/provision-vps.sh'
#
# Idempotent: every step checks first, so re-running after a partial failure
# resumes rather than duplicating. It installs Docker, opens the three ports the
# stack needs, and creates the deploy directory. It does NOT clone the
# repository, write any secret, or start anything — those need decisions this
# script has no business making unattended.
#
# What it deliberately leaves to you is listed at the end.
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/texasrenters}"

say() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root (or with sudo)." >&2; exit 1; }

# ---------------------------------------------------------------------------
say "Checking the host"
# ---------------------------------------------------------------------------
. /etc/os-release
note "${PRETTY_NAME}"
[ "${ID}" = "ubuntu" ] || note "WARNING: written for Ubuntu; ${ID} may differ."
note "$(nproc) vCPU, $(free -g | awk '/^Mem:/{print $2}') GB RAM, $(df -h / | awk 'NR==2{print $4}') free on /"

# The stack runs Postgres, Redis, a Nest API, a Next server and Caddy, and
# builds images on the box. Under 2 GB the web build is the first thing to be
# killed, and it fails as an unexplained exit rather than as an out-of-memory.
MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
if [ "${MEM_MB}" -lt 3800 ] && [ "${SWAP_MB}" -lt 1024 ]; then
  say "Adding 2 GB of swap"
  note "Only ${MEM_MB} MB RAM and no meaningful swap. The Next build needs the headroom."
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    note "created and enabled"
  else
    note "/swapfile already exists, left alone"
  fi
fi

# ---------------------------------------------------------------------------
say "Installing Docker Engine and the Compose plugin"
# ---------------------------------------------------------------------------
# Docker's own repository, not Ubuntu's `docker.io`: the distribution package
# lags and does not ship `docker compose` v2 as a plugin, which every command in
# this project uses.
if docker compose version >/dev/null 2>&1; then
  note "already present: $(docker --version), $(docker compose version --short)"
else
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin >/dev/null
  note "installed: $(docker --version), $(docker compose version --short)"
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
say "Creating the ${DEPLOY_USER} user"
# ---------------------------------------------------------------------------
# Membership of `docker` is root-equivalent — the daemon runs as root and will
# happily bind-mount /. Worth knowing rather than discovering.
if id "${DEPLOY_USER}" >/dev/null 2>&1; then
  note "already exists"
else
  adduser --disabled-password --gecos '' "${DEPLOY_USER}" >/dev/null
  note "created (no password; use SSH keys)"
fi
usermod -aG docker "${DEPLOY_USER}"
if [ -f /root/.ssh/authorized_keys ] && [ ! -s "/home/${DEPLOY_USER}/.ssh/authorized_keys" ]; then
  install -d -m 700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh"
  install -m 600 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" \
    /root/.ssh/authorized_keys "/home/${DEPLOY_USER}/.ssh/authorized_keys"
  note "copied root's authorized_keys so you are not locked out"
fi

# ---------------------------------------------------------------------------
say "Firewall"
# ---------------------------------------------------------------------------
# 80 as well as 443, and not only for redirects: Let's Encrypt validates over
# HTTP-01 on port 80. Closing it means certificates never issue and never renew.
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp  >/dev/null
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null   # HTTP/3
  ufw --force enable >/dev/null
  note "$(ufw status | tr '\n' ' ')"
else
  note "ufw not installed; open 22, 80, 443/tcp and 443/udp in Hostinger's panel."
fi
# Postgres and Redis publish no host ports at all in the production overlay, so
# there is nothing to close for them.

# ---------------------------------------------------------------------------
say "Deploy directory"
# ---------------------------------------------------------------------------
install -d -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${DEPLOY_DIR}"
note "${DEPLOY_DIR} owned by ${DEPLOY_USER}"

# ---------------------------------------------------------------------------
say "Done. What is left, and why it is not automated"
# ---------------------------------------------------------------------------
cat <<EOF
    1. Get the code onto the box, as ${DEPLOY_USER}:
         git clone <repo> ${DEPLOY_DIR}
       Only the compose files and .env.production are read from this checkout.
       The images themselves come from the registry — nothing here is built.

    2. Authenticate to the registry, as ${DEPLOY_USER}:
         docker login ghcr.io -u <github-user>
       The repository is private, so its packages are too. A pull without this
       fails with 'denied', which reads like the image does not exist rather
       than like a login problem. The token needs read:packages.

    3. Write ${DEPLOY_DIR}/.env.production from .env.production.example.
       Every secret is empty on purpose; the stack refuses to start rather than
       boot on a development value. Not scripted because this file is the one
       place the real credentials live.

       Set IMAGE_TAG to the release being deployed — 1.0.0, with no leading v,
       because docker/metadata-action strips it and IMAGE_TAG=v1.0.0 fails to
       pull. It defaults to 'latest', which a release does publish, but 'latest'
       moves under you at the next release and a server should be able to say
       what it is running.

    4. Point DNS at $(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<this server>') with A records — not CNAMEs, which
       cannot hold an IP — before starting, or Caddy cannot complete the
       HTTP-01 challenge and no certificate is issued. Both WEB_HOST and
       API_HOST need one.

       If the zone is on Cloudflare, both records must be DNS-only (grey
       cloud). Proxying them terminates port 80 at Cloudflare, the challenge
       never reaches this server, and the failure looks like a Caddy problem.

    5. Start it:
         cd ${DEPLOY_DIR}
         docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml pull
         docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml up -d

       Note there is no --build. CI publishes both images on release, so this
       host only pulls; building here would compile the Next bundle on a box
       provisioned to run it, which is what the swap check above exists to
       survive. Never a bare 'docker compose up' — without the two -f flags it
       loads the development overlay, publishes Postgres and forces
       NODE_ENV=development.

    6. Create the first administrator, once:
         docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml run --rm bootstrap-admin

    Log out and back in before running docker as ${DEPLOY_USER}; group
    membership is only picked up by a new login session.
EOF
