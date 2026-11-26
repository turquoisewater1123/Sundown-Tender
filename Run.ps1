param([string]$InterfaceAlias)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (!(Test-Path .env)) { Copy-Item .env.example .env }
if (!(Test-Path Novel/settings.json)) { Copy-Item Novel/settings.example.json Novel/settings.json }
$node = (Get-Command node).Source
& $node --env-file=.env -e "if(!process.env.MONGODB_URI)process.exit(1)"
if ($LASTEXITCODE) { throw 'Set MONGODB_URI in .env and install Node 22.15+.' }
foreach ($app in 'Novel','SillyTavern') {
    $stamp = "$app/node_modules/.nightread-lock"
    $lock = (Get-FileHash "$app/package-lock.json").Hash
    if (!(Test-Path $stamp) -or (Get-Content $stamp -Raw).Trim() -ne $lock) {
        & npm.cmd ci --prefix $app --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE) { throw "npm ci failed for $app" }
        Set-Content $stamp $lock
    }
}
& $node runtime/prepare-tavern.mjs
if ($LASTEXITCODE) { throw 'Tavern initialization failed.' }
$net = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address -and (!$InterfaceAlias -or $_.InterfaceAlias -eq $InterfaceAlias) } | Select-Object -First 1
if (!$net) { throw 'No active LAN adapter found.' }
$ip = $net.IPv4Address | Select-Object -First 1
$tavern = $null
try {
    if (!(Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue)) {
        $tavern = Start-Process $node -ArgumentList 'server.js' -WorkingDirectory (Resolve-Path SillyTavern) -WindowStyle Hidden -PassThru
    }
    Write-Host "Phone: http://$($ip.IPAddress):8001/novel/"
    & $node runtime/mobile-access.mjs $ip.IPAddress $ip.PrefixLength
    if ($LASTEXITCODE) { throw 'NightRead stopped with an error.' }
} finally {
    if ($tavern -and !$tavern.HasExited) { Stop-Process -Id $tavern.Id }
}
