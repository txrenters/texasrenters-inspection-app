# Viewing the console with a copy of production

For the `console-development` redesign: look at the new screens with real data, without any
chance of the copy acting on the real systems.

1. **Dump production** (from the repo root; PowerShell; `<production-host>` is the VPS). The dump lands in `data\`, which git
   ignores, because it holds tenant names and addresses and this repository is public.

   ```
   ssh root@<production-host> "docker exec texasrenters-prod-postgres-1 pg_dump -U texasrenters -d texasrenters -Fc -f /tmp/mirror.dump && docker cp texasrenters-prod-postgres-1:/tmp/mirror.dump /root/mirror.dump && docker exec texasrenters-prod-postgres-1 rm /tmp/mirror.dump"
   scp root@<production-host>:/root/mirror.dump data/prod-mirror.dump
   ssh root@<production-host> "rm /root/mirror.dump"
   ```

2. **Restore it into its own database**: `scripts\console-dev\restore-mirror.ps1`.
   A separate container, `texasrenters-mirror-db` on `127.0.0.1:55434`; the dev stack's
   database is never touched. Re-running replaces the copy. Afterwards `scrub-mirror.sql` removes:
   - Jobber tokens. A refresh from the copy would retire production's token.
   - Queued Jobber changes.
   - Phone push registrations.
   - Sign-in sessions and password-reset links.
   - Stored AI keys.

   It prints what is left of each, which should be all zeros.

3. **Run a backend on it**: `scripts\console-dev\start-mirror-backend.ps1`, on port 3005.
   - It runs from `backend\dist-mirror`, where there is no `.env.local`, so it holds no live
     credentials at all. Every scheduler is also switched off.
   - Sign in with your normal production password. The copy carries the password hashes, and
     the copy signs its own sessions.
   - Photos only show if you add the R2 keys to `data\mirror.env` yourself. Then do not upload
     from the copy.

4. **The console**: the `console-dev-mirror` entry in `.claude/launch.json` serves this branch's
   console on `http://127.0.0.1:5458` against port 3005.

Passwords and the copy's signing key are generated into `data\mirror.env` (gitignored).
