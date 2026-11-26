param([string]$InterfaceAlias = 'WLAN')

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = Join-Path $root 'runtime\node\node.exe'
$config = Get-NetIPConfiguration -InterfaceAlias $InterfaceAlias
$ip = $config.IPv4Address | Select-Object -First 1
if (-not $ip -or -not $config.IPv4DefaultGateway) {
    throw "Connect the computer to Wi-Fi before starting mobile access."
}

try {
    Invoke-WebRequest -Uri 'http://127.0.0.1:8000/' -UseBasicParsing -TimeoutSec 2 | Out-Null
} catch {
    Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','Start-Tavern.ps1' -WorkingDirectory $root -WindowStyle Hidden
}

& $node (Join-Path $root 'runtime\mobile-access.mjs') $ip.IPAddress $ip.PrefixLength
exit $LASTEXITCODE
