[CmdletBinding()]
param(
  [switch]$Remove,
  [ValidateRange(1, 65535)]
  [int]$Port = 8081
)

$ErrorActionPreference = 'Stop'
$ruleName = "TexasRenters Expo Metro LAN $Port"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdministrator) {
  throw "Administrator privileges are required. Open PowerShell as Administrator and rerun the pnpm firewall command."
}

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($Remove) {
  if ($existing) {
    $existing | Remove-NetFirewallRule
    Write-Output "Removed firewall rule: $ruleName"
  } else {
    Write-Output "Firewall rule is already absent: $ruleName"
  }
  exit 0
}

$nodePath = (Get-Command node -ErrorAction Stop).Source
if ($existing) {
  $existing | Remove-NetFirewallRule
}

New-NetFirewallRule `
  -DisplayName $ruleName `
  -Description "Allow the TexasRenters Expo Metro server on trusted Private networks only." `
  -Direction Inbound `
  -Action Allow `
  -Enabled True `
  -Profile Private `
  -Protocol TCP `
  -LocalPort $Port `
  -Program $nodePath | Out-Null

Write-Output "Created Private-profile TCP firewall rule for $nodePath on port $Port."
Write-Output "Remove it later with: pnpm windows:mobile:lan:firewall:remove"
