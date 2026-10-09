<#
.SYNOPSIS
  Restores a production dump into a SEPARATE local database for viewing the
  console redesign, then removes every credential that would let it act
  outward (see scrub-mirror.sql).

.DESCRIPTION
  - Its own container, texasrenters-mirror-db, on 127.0.0.1:55434. The dev
    stack's texasrenters-postgres-1 is never touched.
  - Passwords are generated once into data\mirror.env (gitignored, like the
    dump itself). Nothing secret is printed.
  - Safe to re-run: the mirror database is dropped and restored fresh.

  Windows PowerShell 5.1. From the repo root:
    powershell -ExecutionPolicy Bypass -File scripts\console-dev\restore-mirror.ps1
#>
param(
  [string]$DumpPath = (Join-Path $PSScriptRoot '..\..\data\prod-mirror.dump'),
  [string]$Container = 'texasrenters-mirror-db',
  [int]$Port = 55434
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$envFile = Join-Path $repo 'data\mirror.env'
$scrubFile = Join-Path $PSScriptRoot 'scrub-mirror.sql'
$database = 'texasrenters_mirror'
$appRole = 'texasrenters_app'

function New-Secret {
  $bytes = New-Object byte[] 18
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return ([Convert]::ToBase64String($bytes)).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function Invoke-Sql([string]$Sql, [string]$Db = 'postgres') {
  # Through stdin: Windows PowerShell mangles double quotes in native
  # arguments, and the table names here are quoted identifiers.
  $Sql | docker exec -i $Container psql -U postgres -d $Db -v ON_ERROR_STOP=1 -q -X
  if ($LASTEXITCODE -ne 0) { throw "SQL failed against $Db (exit $LASTEXITCODE)." }
}

if (-not (Test-Path $DumpPath)) { throw "No dump at $DumpPath. Run the pg_dump + scp steps first." }
$DumpPath = (Resolve-Path $DumpPath).Path

if (-not (Test-Path $envFile)) {
  "MIRROR_OWNER_PASSWORD=$(New-Secret)`r`nMIRROR_APP_PASSWORD=$(New-Secret)`r`n" | Out-File -Encoding ascii $envFile
  Write-Host "Generated passwords in data\mirror.env (gitignored)."
}
$config = @{}
Get-Content $envFile | ForEach-Object { if ($_ -match '^([A-Z_]+)=(.*)$') { $config[$Matches[1]] = $Matches[2] } }
if (-not $config.MIRROR_JWT_SECRET) {
  # The copy's backend signs its own sign-in tokens; production's key never
  # leaves production.
  "MIRROR_JWT_SECRET=$(New-Secret)$(New-Secret)" | Out-File -Encoding ascii -Append $envFile
}

$existing = docker ps -a --filter "name=^$Container$" --format '{{.Names}}'
if (-not $existing) {
  Write-Host "Creating $Container on 127.0.0.1:$Port ..."
  docker run -d --name $Container `
    -e "POSTGRES_PASSWORD=$($config.MIRROR_OWNER_PASSWORD)" `
    -p "127.0.0.1:${Port}:5432" `
    -v texasrenters-mirror-data:/var/lib/postgresql/data `
    postgres:17-alpine | Out-Null
} else {
  docker start $Container | Out-Null
}

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  docker exec $Container pg_isready -U postgres -q
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { throw "$Container did not become ready." }

Write-Host "Recreating database $database ..."
Invoke-Sql "DROP DATABASE IF EXISTS $database WITH (FORCE);"
Invoke-Sql "CREATE DATABASE $database;"

# The app's least-privilege role must exist BEFORE the restore, so the dump's
# grants land on it. Same shape as backend/scripts/setup-app-database-role.mjs:
# no superuser, no BYPASSRLS, or row-level security silently stops applying.
$roleSql = @'
DO $$BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '__ROLE__') THEN
    CREATE ROLE __ROLE__ LOGIN;
  END IF;
END$$;
ALTER ROLE __ROLE__ LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '__PASSWORD__';
'@
Invoke-Sql ($roleSql.Replace('__ROLE__', $appRole).Replace('__PASSWORD__', $config.MIRROR_APP_PASSWORD))

Write-Host "Restoring the dump (a minute or two) ..."
docker cp $DumpPath "${Container}:/tmp/mirror.dump" | Out-Null
# --no-owner: objects belong to the local superuser. Ownership statements for
# production's own role names are skipped rather than failing.
docker exec $Container pg_restore -U postgres -d $database --no-owner /tmp/mirror.dump
$restoreExit = $LASTEXITCODE
docker exec $Container rm -f /tmp/mirror.dump
if ($restoreExit -ne 0) {
  Write-Warning "pg_restore reported problems (exit $restoreExit). Usually these are grants for roles that exist only in production; the grants below cover the app role."
}

$grantSql = @'
GRANT USAGE ON SCHEMA public TO __ROLE__;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO __ROLE__;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO __ROLE__;
'@
Invoke-Sql ($grantSql.Replace('__ROLE__', $appRole)) $database

Write-Host "Removing credentials that could act outward (scrub-mirror.sql) ..."
Invoke-Sql (Get-Content $scrubFile -Raw) $database

Write-Host "Row counts in the copy:"
Invoke-Sql @'
SELECT
  (SELECT count(*) FROM "Inspection") AS inspections,
  (SELECT count(*) FROM "InspectionAssignment") AS assignments,
  (SELECT count(*) FROM propertyware_buildings) AS properties,
  (SELECT count(*) FROM "JobberVisitImport") AS jobber_visits,
  (SELECT count(*) FROM "UserProfile") AS people;
'@ $database

Write-Host ""
Write-Host "Done. The copy is in $Container ($database on 127.0.0.1:$Port)."
Write-Host "Next: scripts\console-dev\start-mirror-backend.ps1"
