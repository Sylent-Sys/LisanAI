<#
.SYNOPSIS
  Issue and renew a Let's Encrypt certificate for a public IP address and hand
  it to the LisanAI Node server.

.DESCRIPTION
  Uses Posh-ACME with the "shortlived" profile (Let's Encrypt requires it for
  IP address certificates, which are valid for about 6 days) and the WebRoot
  HTTP-01 plugin. The Node server serves ACME_CHALLENGE_DIR on port 80 and
  reloads TLS_CERT_FILE when it changes (server/http/https-server.js).

  Run in an elevated Windows PowerShell 5.1+ on the web server:
    # 1. Dry run against Let's Encrypt staging (nothing is installed):
    powershell -ExecutionPolicy Bypass -File .\deploy\windows\tls-ip-cert.ps1 -IpAddress <ip> -Server LE_STAGE
    # 2. Real certificate, renewal task and firewall rule:
    powershell -ExecutionPolicy Bypass -File .\deploy\windows\tls-ip-cert.ps1 -IpAddress <ip> -Install

  Every run makes sure shared\.env has the HTTPS settings (restarting the app
  once if they were missing), then issues or renews the certificate. Only
  LE_PROD certificates are copied to shared\tls\.
#>
param(
  [Parameter(Mandatory = $true)][string]$IpAddress,
  [string]$InstallDir = "C:\apps\LisanAI",
  [ValidateSet("LE_PROD", "LE_STAGE")][string]$Server = "LE_PROD",
  [int]$HttpsPort = 443,
  [switch]$Install,
  [string]$AppTaskName = "LisanAI",
  [string]$RenewTaskName = "LisanAI-TLS-Renew"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$SharedDir = Join-Path $InstallDir "shared"
$AcmeDir = Join-Path $SharedDir "acme"
$WebRoot = Join-Path $AcmeDir "webroot"
$ChallengeDir = Join-Path $WebRoot ".well-known\acme-challenge"
$TlsDir = Join-Path $SharedDir "tls"
$CertFile = Join-Path $TlsDir "fullchain.pem"
$KeyFile = Join-Path $TlsDir "key.pem"
$EnvFile = Join-Path $SharedDir ".env"
$LogDir = Join-Path $InstallDir "logs"
$LogFile = Join-Path $LogDir "tls-renew.log"
$RenewScript = Join-Path $InstallDir "tls-renew.ps1"

# Posh-ACME state (ACME account key, orders) shared by the admin run and the
# SYSTEM renewal task.
$env:POSHACME_HOME = Join-Path $AcmeDir "posh-acme"

$SidNetworkService = "*S-1-5-20"
$SidAdministrators = "*S-1-5-32-544"
$SidSystem = "*S-1-5-18"

function Write-Log($message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
  Write-Host $line
  Add-Content -Path $LogFile -Value $line -Encoding ascii
}

function Invoke-Native($file, [string[]]$arguments) {
  & $file @arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "$file $($arguments -join ' ') gagal (exit $LASTEXITCODE)." }
}

function Assert-Admin {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Jalankan PowerShell sebagai Administrator."
  }
}

function Initialize-PoshAcme {
  if (-not (Get-Module -ListAvailable -Name Posh-ACME)) {
    Write-Log "Memasang modul Posh-ACME dari PowerShell Gallery"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if (-not (Get-PackageProvider -ListAvailable -Name NuGet -ErrorAction SilentlyContinue)) {
      Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope AllUsers | Out-Null
    }
    Install-Module -Name Posh-ACME -Scope AllUsers -Force -AllowClobber
  }
  Import-Module Posh-ACME
  Write-Log "Posh-ACME $((Get-Module Posh-ACME).Version)"
}

# Adds or replaces KEY=value lines; returns $true when the file changed.
function Set-EnvValues([hashtable]$values) {
  $lines = [System.Collections.Generic.List[string]]::new()
  if (Test-Path $EnvFile) { foreach ($line in Get-Content $EnvFile) { $lines.Add($line) } }
  $changed = $false
  foreach ($key in $values.Keys) {
    $wanted = "$key=$($values[$key])"
    $index = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^$key=") { $index = $i; break } }
    if ($index -ge 0) {
      if ($lines[$index] -ne $wanted) { $lines[$index] = $wanted; $changed = $true }
    } else {
      $lines.Add($wanted); $changed = $true
    }
  }
  if ($changed) {
    # WriteAllText on the existing file keeps its restricted ACL.
    [System.IO.File]::WriteAllText($EnvFile, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
  }
  return $changed
}

function Restart-App($httpPort) {
  Write-Log "Restart aplikasi agar pengaturan HTTPS dari .env terbaca"
  Stop-ScheduledTask -TaskName $AppTaskName
  $pattern = [regex]::Escape($InstallDir)
  foreach ($name in @("cmd.exe", "node.exe")) {
    Get-CimInstance Win32_Process -Filter "Name='$name'" |
      Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
  }
  Start-ScheduledTask -TaskName $AppTaskName
  for ($i = 0; $i -lt 30; $i++) {
    try {
      if ((Invoke-WebRequest -Uri "http://127.0.0.1:$httpPort/" -UseBasicParsing -TimeoutSec 5 -MaximumRedirection 0 -ErrorAction Stop).StatusCode -eq 200) { return }
    } catch {
      # 308 means HTTPS is already active, which is also healthy.
      if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 308) { return }
    }
    Start-Sleep -Seconds 2
  }
  throw "Aplikasi tidak merespons di port $httpPort setelah restart; lihat $LogDir\app.log"
}

# Atomic swap so the Node watcher never reads a half-written file.
function Install-File($source, $target) {
  $temp = "$target.new"
  [System.IO.File]::Copy($source, $temp, $true)
  if (Test-Path $target) { [System.IO.File]::Replace($temp, $target, $null) } else { [System.IO.File]::Move($temp, $target) }
}

$parsed = $null
if (-not [System.Net.IPAddress]::TryParse($IpAddress, [ref]$parsed)) { throw "IpAddress tidak valid: $IpAddress" }
if (-not (Test-Path $EnvFile)) { throw "$EnvFile belum ada; deploy aplikasi dengan deploy.ps1 dulu." }
Assert-Admin

foreach ($dir in @($LogDir, $ChallengeDir, $TlsDir, $env:POSHACME_HOME)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
# ACME account key: administrators and SYSTEM only.
Invoke-Native "icacls.exe" @($env:POSHACME_HOME, "/inheritance:r", "/grant:r", "${SidAdministrators}:(OI)(CI)F", "${SidSystem}:(OI)(CI)F")
# TLS private key: additionally readable by the app account.
Invoke-Native "icacls.exe" @($TlsDir, "/inheritance:r", "/grant:r", "${SidAdministrators}:(OI)(CI)F", "${SidSystem}:(OI)(CI)F", "${SidNetworkService}:(OI)(CI)R")

$envValues = @{
  HTTPS_PORT = $HttpsPort
  TLS_CERT_FILE = $CertFile -replace "\\", "/"
  TLS_KEY_FILE = $KeyFile -replace "\\", "/"
  ACME_CHALLENGE_DIR = $ChallengeDir -replace "\\", "/"
}
$httpPort = 80
$portLine = Get-Content $EnvFile | Where-Object { $_ -match '^PORT=(\d+)$' } | Select-Object -First 1
if ($portLine) { $httpPort = [int]($portLine -replace '^PORT=', '') }
if ($httpPort -ne 80) { Write-Log "PERINGATAN: PORT=$httpPort; validasi HTTP-01 Let's Encrypt selalu datang ke port 80." }
if (Set-EnvValues $envValues) { Restart-App $httpPort }

Initialize-PoshAcme
Set-PAServer $Server
if (-not (Get-PAAccount)) {
  New-PAAccount -AcceptTOS | Out-Null
  Write-Log "Akun ACME dibuat di $Server (tanpa email kontak)"
}

$order = Get-PAOrder -MainDomain $IpAddress -ErrorAction SilentlyContinue
if (-not $order) {
  Write-Log "Menerbitkan sertifikat untuk $IpAddress di $Server (profil shortlived, HTTP-01 WebRoot)"
  New-PACertificate $IpAddress -Plugin WebRoot -PluginArgs @{ WRPath = $WebRoot } -Profile shortlived | Out-Null
} else {
  $renewed = Submit-Renewal -MainDomain $IpAddress
  if (-not $renewed) { Write-Log "Belum waktunya diperpanjang (RenewAfter $($order.RenewAfter))" }
}

$current = Get-PACertificate -MainDomain $IpAddress
if (-not $current) { throw "Posh-ACME tidak mengembalikan sertifikat untuk $IpAddress." }
Write-Log "Sertifikat $Server untuk $IpAddress berlaku sampai $($current.NotAfter)"

if ($Server -ne "LE_PROD") {
  Write-Log "Staging: alur validasi berhasil; sertifikat TIDAK dipasang ke $TlsDir."
} elseif (-not (Test-Path $CertFile) -or (Get-FileHash $current.FullChainFile).Hash -ne (Get-FileHash $CertFile).Hash) {
  Install-File $current.KeyFile $KeyFile
  Install-File $current.FullChainFile $CertFile
  Write-Log "Sertifikat dipasang ke $TlsDir; Node memuatnya dalam 30 detik tanpa restart."
}

if ($Install) {
  if ($Server -ne "LE_PROD") { throw "-Install hanya untuk LE_PROD." }
  Copy-Item -LiteralPath $PSCommandPath -Destination $RenewScript -Force

  $rule = "LisanAI TCP $HttpsPort"
  Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $HttpsPort -Action Allow | Out-Null

  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$RenewScript`" -IpAddress $IpAddress -InstallDir `"$InstallDir`" -HttpsPort $HttpsPort"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
  $triggers = @((New-ScheduledTaskTrigger -Daily -At "03:17"), (New-ScheduledTaskTrigger -Daily -At "15:17"), (New-ScheduledTaskTrigger -AtStartup))
  $principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15)
  Register-ScheduledTask -TaskName $RenewTaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
  Write-Log "Task '$RenewTaskName' terdaftar (03:17, 15:17, dan saat boot); firewall TCP $HttpsPort dibuka."
}
