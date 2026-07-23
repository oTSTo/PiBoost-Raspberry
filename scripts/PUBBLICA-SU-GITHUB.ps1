param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryUrl,

    [string]$CommitMessage = "Prima release pubblica di PiBoost"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git non è installato. Installa Git con: winget install --id Git.Git -e --source winget"
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

if (Test-Path ".env") {
    throw "Trovato .env nella radice: rimuovilo prima del push."
}
if (Test-Path "backend\.env") {
    throw "Trovato backend/.env: rimuovilo prima del push."
}

$RuntimeFiles = Get-ChildItem "backend\data" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne ".gitkeep" }
if ($RuntimeFiles) {
    throw "backend/data contiene dati runtime. Rimuovili prima del push."
}

if (-not (Test-Path ".git")) {
    git init
}

git branch -M main
git add -A

$staged = git diff --cached --name-only
if (-not $staged) {
    Write-Host "Nessuna modifica da pubblicare."
    exit 0
}

git commit -m $CommitMessage

$origin = git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0) {
    git remote set-url origin $RepositoryUrl
} else {
    git remote add origin $RepositoryUrl
}

git push -u origin main
Write-Host "Push completato: $RepositoryUrl" -ForegroundColor Green
