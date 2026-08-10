# Remote iOS Beta — Developer Runbook

Temporary environment for remote technicians while the signed beta is pending. The active
client is **`mobile`**. The legacy `mobile` is not launched by this workflow.

## Architecture

One stable ngrok dev domain and one authenticated ngrok agent session are used:

```text
iPhone / Expo Go
        │
        ▼
https://<NGROK_DOMAIN>
        │
        ▼
Docker remote-beta gateway
        ├── /api/*, /socket.io/* ──► NestJS backend
        └── every other path ──────► mobile Metro :8082
```

Expo uses its documented `EXPO_PACKAGER_PROXY_URL` override. It runs in LAN bind mode so the
Docker gateway can reach it, but it does **not** launch `@expo/ngrok` or a second tunnel.
Cloudflare Tunnel is not part of this workflow.

## Prerequisites

- Docker Desktop installed
- Node and pnpm versions accepted by the root workspace
- `backend/.env.local` present
- `NGROK_AUTHTOKEN` and `NGROK_DOMAIN` present in that ignored file
- Real backend provider credentials already configured there

Never put backend credentials in an `EXPO_PUBLIC_*` variable.

## Cold start (recommended)

From the repository root:

```bash
pnpm remote-beta
```

This command:

1. waits up to 60 seconds for Docker Desktop;
2. builds and starts the backend, routing gateway, and ngrok agent;
3. waits for backend health;
4. discovers the live Docker-managed ngrok gateway on `127.0.0.1:4041`;
5. verifies `https://<NGROK_DOMAIN>/api/v1/health`;
6. updates only the remote-beta routing keys in `mobile/.env.local`;
7. starts V2 Metro on port 8082 and prints the Expo Go QR code.

To clear Metro's cache during the same cold start:

```bash
pnpm remote-beta -- --clear
```

## Metro only

Use this only when the Docker remote-beta stack is already running with the current gateway:

```bash
cd mobile
pnpm start:clear
```

The script refuses to continue if the live ngrok agent still points directly at the backend,
because that old topology cannot carry Metro. Run `pnpm remote-beta` once to recreate it.

## Status

```bash
pnpm remote-beta:status
```

The status output reports Docker services, the public gateway, its internal upstream, REST
health, and whether V2 Metro is listening.

## Manual Docker inspection

```bash
docker compose --env-file backend/.env.local -f compose.yaml -f compose.remote-beta.yaml ps
docker compose --env-file backend/.env.local -f compose.yaml -f compose.remote-beta.yaml logs backend gateway tunnel
```

The ngrok inspection API is local only:

```text
http://127.0.0.1:4041
```

It can contain captured request payloads and must never be published.

## Required cellular validation

Before inviting remote testers:

1. Run `pnpm remote-beta`.
2. Confirm the printed public REST health result is successful.
3. On a physical iPhone, disable Wi-Fi and use cellular data.
4. Scan the V2 QR code in Expo Go.
5. Confirm the JavaScript bundle loads.
6. Sign in with a technician beta account.
7. Confirm assigned inspections load.
8. Open an area, record a short video, and capture the required snapshots.
9. Confirm the queue advances and uploads resume after a brief offline interruption.
10. Confirm the web app receives evidence under the correct inspection area.
11. Confirm pending uploads return to zero.

Repository and desktop checks cannot prove the final cellular/Expo Go step.

## Troubleshooting

| Symptom                                         | Cause                                           | Action                                                 |
| ----------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| Docker does not become ready                    | Docker Desktop is stopped or still starting     | Start Docker Desktop, wait for the engine, rerun       |
| `NGROK_AUTHTOKEN` or `NGROK_DOMAIN` missing     | Remote-beta environment is incomplete           | Add it to ignored `backend/.env.local`                 |
| Backend unhealthy                               | Backend dependency or environment failure       | Inspect `compose ... logs backend`                     |
| `remote gone away`                              | Old workflow launched a second Expo ngrok agent | Use the current scripts; do not add `--tunnel` to Expo |
| Tunnel points at `backend` instead of `gateway` | Existing containers predate the gateway change  | Run root `pnpm remote-beta` once                       |
| Public REST health is 502                       | Gateway or backend is not ready                 | Inspect gateway/backend logs and rerun                 |
| Public root is 502 while Metro is stopped       | Expected; the non-API route targets port 8082   | Start V2 Metro                                         |
| Port 8082 is occupied                           | Another V2 Metro process is still running       | Stop that process, then rerun                          |
| Expo Go loads but API calls fail                | Stale bundle/environment                        | Clear Metro and reload Expo Go                         |
| Push notifications do not arrive                | Expo Go limitation since SDK 53                 | Use a signed development build for remote push         |

## Shutdown

Confirm pending uploads are zero, stop Metro with Ctrl+C, then:

```bash
pnpm remote-beta:stop
```

The helper does not pass `-v`; it does not delete volumes or device evidence.
