$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$ollama = Join-Path $root 'runtime\ollama\ollama.exe'
$node = Join-Path $root 'runtime\node\node.exe'
$tavern = Join-Path $root 'SillyTavern'
$logs = Join-Path $root 'logs'

$env:OLLAMA_HOST = '127.0.0.1:11435'
# The Windows inference library opens model paths using a narrow file API.
$env:OLLAMA_MODELS = 'models'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_CONTEXT_LENGTH = '4096'
$env:OLLAMA_NOHISTORY = '1'
$env:SILLYTAVERN_LISTEN = 'false'
$env:SILLYTAVERN_PORT = '8000'

if (-not (Test-Path (Join-Path $tavern 'node_modules'))) {
    throw 'SillyTavern source or dependencies are missing.'
}

New-Item -ItemType Directory -Path $logs -Force | Out-Null
$engine = $null
try {
    $listener = Get-NetTCPConnection -LocalPort 11435 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $owner = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
        if ($owner.Path -ne $ollama -or $listener.LocalAddress -ne '127.0.0.1') {
            throw 'Port 11435 is in use by another service. Close it before starting the workspace.'
        }
    } else {
        $engine = Start-Process -FilePath $ollama -ArgumentList 'serve' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'ollama.out.log') -RedirectStandardError (Join-Path $logs 'ollama.err.log')
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($engine -and $engine.HasExited) { throw 'Ollama failed to start. Check logs/ollama.err.log.' }
        try {
            Invoke-RestMethod -Uri 'http://127.0.0.1:11435/api/version' -TimeoutSec 1 | Out-Null
            $ready = $true
            break
        } catch {
            Start-Sleep -Milliseconds 300
        }
    }
    if (-not $ready) { throw 'Ollama did not become ready.' }
    Write-Host 'SillyTavern: http://127.0.0.1:8000'
    Push-Location -LiteralPath $tavern
    try {
        & $node server.js
        if ($LASTEXITCODE -ne 0) { throw "SillyTavern exited with code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
} finally {
    if ($engine -and -not $engine.HasExited) { Stop-Process -Id $engine.Id }
}
