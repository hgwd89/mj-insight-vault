$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not $env:DIFY_LOG_TOKEN) {
    Write-Host "DIFY_LOG_TOKEN is not set. This is OK for local-only testing, but set it before using a public tunnel."
}

python .\server.py
