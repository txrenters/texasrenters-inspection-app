<#
.SYNOPSIS
  Runs the backend from this branch's source against the LOCAL production
  copy (restore-mirror.ps1), on port 3005, holding no live credentials at all.

.DESCRIPTION
  Built into backend\dist-mirror, never backend\dist, so it cannot collide with
  your own `nest start --watch` on port 3000.

  It runs from backend\dist-mirror, where there is no .env.local, so none of
  the backend's live keys are loaded: no Jobber, Propertyware, email, AI,
  Cloudflare Stream, R2 or Redis credentials exist in this process. Whatever it
  tries to reach outside, it cannot authenticate to. (Setting a variable to an
  empty string is not a way to switch one off on Windows: .NET deletes the
  variable instead, and the loader would then fill it from .env.local.)
  On top of that, the schedulers are switched off below, and the scrub deleted
  every phone push registration and every queued Jobber change.

  The copy's database, password and sign-in signing key come from
  data\mirror.env (written by restore-mirror.ps1, gitignored). Any other
  KEY=value line you add there is passed through as-is, for example photo
  storage keys if you want photos to show:
    INSPECTION_MEDIA_STORAGE_PROVIDER=r2  (plus its R2_* keys)
  Viewing is fine with those; do not UPLOAD from the copy.

  Windows PowerShell 5.1. From the repo root:
    powershell -ExecutionPolicy Bypass -File scripts\console-dev\start-mirror-backend.ps1
  Ctrl+C stops it.
#>
param(
  [int]$Port = 3005,
  [int]$DatabasePort = 55434,
  [int]$ConsolePort = 5458,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$backend = Join-Path $repo 'backend'
$envFile = Join-Path $repo 'data\mirror.env'
if (-not (Test-Path $envFile)) { throw 'No data\mirror.env. Run restore-mirror.ps1 first.' }
$config = [ordered]@{}
Get-Content $envFile | ForEach-Object { if ($_ -match '^([A-Z0-9_]+)=(.*)$') { $config[$Matches[1]] = $Matches[2] } }
if (-not $config.MIRROR_JWT_SECRET) { throw 'data\mirror.env has no MIRROR_JWT_SECRET. Run restore-mirror.ps1 again.' }

$held = netstat -ano | Select-String -Pattern ":$Port\s" | Select-String 'LISTENING'
if ($held) { throw "Port $Port is already in use." }

$settings = [ordered]@{
  PORT = "$Port"
  NODE_ENV = 'development'
  APP_ENV = 'console-mirror'
  DATABASE_URL = "postgresql://texasrenters_app:$($config.MIRROR_APP_PASSWORD)@127.0.0.1:$DatabasePort/texasrenters_mirror?schema=public"
  DIRECT_URL = "postgresql://postgres:$($config.MIRROR_OWNER_PASSWORD)@127.0.0.1:$DatabasePort/texasrenters_mirror?schema=public"
  AUTH_JWT_SECRET = $config.MIRROR_JWT_SECRET
  # Signing needs an issuer as well as a key, or every sign-in is refused with
  # "Authentication is not configured". The copy's own, so its tokens can never
  # pass for production's.
  AUTH_JWT_ISSUER = "http://127.0.0.1:$Port/console-mirror"
  CORS_ALLOWED_ORIGINS = "http://127.0.0.1:$ConsolePort,http://localhost:$ConsolePort"
  JOBBER_SYNC_ENABLED = 'false'
  JOBBER_BOOKING_ENABLED = 'false'
  JOBBER_PUSH_EDITS_ENABLED = 'false'
  JOBBER_TBP_WRITE_ENABLED = 'false'
  PROPERTYWARE_SYNC_ENABLED = 'false'
  LEASE_INSPECTIONS_ENABLED = 'false'
  TBP_PLANNING_ENABLED = 'false'
  TIME_TRACKING_SWEEP_ENABLED = 'false'
  PROPERTY_GEOCODING_ENABLED = 'false'
  FLOOR_PLAN_EXTRACTION_PROVIDER = 'disabled'
  CACHE_ENABLED = 'false'
  JOB_QUEUE_PROVIDER = 'memory'
}
# Extra lines from data\mirror.env (not the MIRROR_* ones) pass through.
foreach ($key in $config.Keys) { if ($key -notlike 'MIRROR_*') { $settings[$key] = $config[$key] } }
foreach ($key in $settings.Keys) { [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process') }

if (-not $SkipBuild) {
  Push-Location $backend
  try {
    Write-Host 'Building the backend into backend\dist-mirror ...'
    npx nest build --path tsconfig.mirror.json
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
  } finally { Pop-Location }
}

# From dist-mirror: no .env.local here, so nothing live is loaded.
Push-Location (Join-Path $backend 'dist-mirror')
try {
  Write-Host "Backend on http://127.0.0.1:$Port against the local copy. Ctrl+C to stop."
  node main.js
} finally {
  Pop-Location
}
