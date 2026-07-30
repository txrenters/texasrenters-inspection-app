# Remote iOS Beta - Implementation Status

Last verified: 2026-07-30.

This is a temporary Expo Go beta environment for remote technicians. It is not a production
deployment and it does not replace a signed development or TestFlight build.

## Active client

- `mobile-app-v2` is the default technician client.
- Root mobile scripts (`dev:mobile`, `lint:mobile`, `typecheck:mobile`, `test:mobile`, and
  `build:mobile`) target V2.
- `mobile-app` remains available only through explicit `:v1` scripts.
- Expo SDK: 54.0.36.

## Remote topology

The beta uses one authenticated, Docker-managed ngrok session and one stable ngrok domain:

```text
Expo Go
   |
   v
ngrok HTTPS domain
   |
   v
Docker Nginx gateway
   |-- /api/* and /socket.io/* --> NestJS backend
   `-- all other paths ---------> V2 Metro on host port 8082
```

Expo starts in LAN server mode with `EXPO_PACKAGER_PROXY_URL` set to the live ngrok origin.
This makes the manifest and QR advertise the public ngrok URL without asking Expo CLI to start
a second ngrok agent. Cloudflare Tunnel is not used by this workflow.

## Live verification

The following checks passed on 2026-07-30:

- `pnpm remote-beta -- --clear` cold-started Docker, the gateway, ngrok, and V2 Metro.
- Backend container reached `healthy`.
- The ngrok agent reported `http://gateway:80` as its upstream.
- Public `GET /api/v1/health` returned HTTP 200.
- Local `GET http://127.0.0.1:8082/status` returned `packager-status:running`.
- The public Expo request returned an `application/expo+json` manifest.
- The manifest launch asset used the same public ngrok origin.
- The complete iOS JavaScript bundle was generated and fetched through ngrok with HTTP 200.
- The terminal QR advertised the public ngrok origin and did not emit `remote gone away`.
- `cd mobile-app-v2 && pnpm start:tunnel --check` passed against the running stack.

The first cold bundle was approximately 16.6 MB and took about one minute to generate and
transfer. Subsequent requests use Metro's cache.

## Quality checks

| Check                            | Result                     |
| -------------------------------- | -------------------------- |
| V2 lint                          | pass                       |
| V2 typecheck                     | pass                       |
| V2 tests                         | pass - 4 suites / 11 tests |
| V2 web export                    | pass                       |
| Expo Doctor                      | pass - 18/18 checks        |
| Compose config                   | pass                       |
| Backend Docker image and startup | pass                       |

## Expo Go limitation

Remote push notifications are not supported in Expo Go on current Expo SDKs. Camera,
recording, secure storage, local persistence, and the application REST workflow remain usable.
A signed development build is still required to validate production remote push behavior.

## Remaining physical-device check

Repository and host-side checks cannot prove that a particular iPhone opened the project.
Before calling the beta device-verified, scan the QR on a physical iPhone outside the developer
LAN and confirm:

1. the V2 login screen opens;
2. technician authentication succeeds;
3. an assigned inspection loads;
4. a test recording queues and uploads;
5. the Metro terminal shows no runtime or bundle error.

Record those results in this file after the device test.

## Commands

Cold start from the repository root:

```powershell
pnpm remote-beta -- --clear
```

When the Docker stack is already current:

```powershell
cd mobile-app-v2
pnpm start:tunnel --clear
```

Status:

```powershell
pnpm remote-beta:status
```

Stop Docker beta services after testers have finished and pending uploads are zero:

```powershell
pnpm remote-beta:stop
```
