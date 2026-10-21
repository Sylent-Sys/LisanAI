<#
.SYNOPSIS
  Build a self-contained LisanAI release zip for deploy.ps1.

.DESCRIPTION
  Run on a Windows x64 dev machine with Node.js 22 and network access:

    powershell -ExecutionPolicy Bypass -File .\deploy\windows\package.ps1

  Copies tracked and untracked (non-ignored) files into a staging folder,
  builds the frontend there, keeps only production node_modules, and writes
  dist\lisanai-<commit>.zip. The working tree is not modified. .env and data\
  are gitignored and therefore never packaged.
#>
param(
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot "dist" }

function Invoke-Native($file, [string[]]$arguments) {
  & $file @arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$file $($arguments -join ' ') gagal (exit $LASTEXITCODE)." }
}

Push-Location $RepoRoot
try {
  $sha = (git rev-parse --short HEAD).Trim()
  $dirty = [bool](git status --porcelain)
  $files = ((git ls-files -z --cached --others --exclude-standard) -join "") -split "`0" | Where-Object { $_ }
} finally { Pop-Location }

$name = if ($dirty) { "lisanai-$sha-dirty" } else { "lisanai-$sha" }
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "$name-staging"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

Write-Host "==> Menyalin $($files.Count) file ke staging"
foreach ($file in $files) {
  $source = Join-Path $RepoRoot $file
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
  $target = Join-Path $staging $file
  New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target
}

Push-Location $staging
try {
  Write-Host "==> npm ci + build frontend"
  $env:VERCEL_ENV = $null
  Invoke-Native "npm.cmd" @("ci", "--no-audit", "--no-fund")
  Invoke-Native "npm.cmd" @("run", "build")
  Write-Host "==> Membuang devDependencies"
  Invoke-Native "npm.cmd" @("prune", "--omit=dev", "--no-audit", "--no-fund")
} finally { Pop-Location }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$zip = Join-Path $OutDir "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host "==> Membuat $zip"
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $staging -Recurse -Force

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
Write-Host ""
Write-Host "Paket siap: $zip" -ForegroundColor Green
Write-Host "SHA256: $hash"
if ($dirty) { Write-Host "Catatan: dibuat dari working tree dengan perubahan yang belum di-commit." -ForegroundColor Yellow }
