$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = Join-Path $root 'runtime\node\node.exe'
$ollama = Join-Path $root 'runtime\ollama\ollama.exe'
$logs = Join-Path $root 'logs'
$tavern = Join-Path $root 'SillyTavern'
$mobileScript = Join-Path $root 'runtime\mobile-access.mjs'

Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class TavernPower {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@

function Test-Http([string]$Uri, [int]$Expected) {
    try {
        return (Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 3).StatusCode -eq $Expected
    } catch {
        return $_.Exception.Response -and ([int]$_.Exception.Response.StatusCode -eq $Expected)
    }
}

function Write-WatchLog([string]$Message) {
    Add-Content -LiteralPath (Join-Path $logs 'watchdog.log') -Value "[$(Get-Date -Format s)] $Message"
}

function Ensure-Service($Service) {
    if (Test-Http $Service.Uri $Service.Expected) {
        $Service.Failures = 0
        return
    }
    if ((Get-Date) -lt $Service.RetryAfter) { return }

    $listener = Get-NetTCPConnection -LocalAddress $Service.Address -LocalPort $Service.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if ($owner.ExecutablePath -ne $Service.Executable -or $owner.CommandLine -notmatch $Service.CommandPattern) {
            Write-WatchLog "$($Service.Name) port occupied by another process."
            $Service.RetryAfter = (Get-Date).AddMinutes(1)
            return
        }
        $Service.Failures++
        if ($Service.Failures -lt 3) { return }
        Stop-Process -Id $owner.ProcessId -PassThru | Wait-Process -Timeout 10
    } elseif ($Service.Process -and -not $Service.Process.HasExited) {
        Stop-Process -Id $Service.Process.Id -PassThru | Wait-Process -Timeout 10
    }

    $Service.Process = Start-Process -FilePath $Service.Executable -ArgumentList $Service.Arguments -WorkingDirectory $Service.Directory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs "watch-$($Service.Name).out.log") -RedirectStandardError (Join-Path $logs "watch-$($Service.Name).err.log")
    $Service.Failures = 0
    $Service.RetryAfter = (Get-Date).AddSeconds($Service.Grace)
    Write-WatchLog "Started $($Service.Name) on $($Service.Address):$($Service.Port), PID $($Service.Process.Id)."
}

$env:OLLAMA_HOST = '127.0.0.1:11435'
$env:OLLAMA_MODELS = 'models'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_NOHISTORY = '1'
$env:OLLAMA_CONTEXT_LENGTH = '4096'
$env:SILLYTAVERN_LISTEN = 'false'
$env:SILLYTAVERN_PORT = '8000'
$start = Get-Date
$engine = @{
    Name='ollama'; Address='127.0.0.1'; Port=11435; Uri='http://127.0.0.1:11435/api/version'; Expected=200
    Executable=$ollama; CommandPattern='\bserve\b'; Arguments='serve'; Directory=$root
    Grace=45; RetryAfter=$start; Failures=0; Process=$null
}
$web = @{
    Name='tavern'; Address='127.0.0.1'; Port=8000; Uri='http://127.0.0.1:8000/'; Expected=200
    Executable=$node; CommandPattern='\bserver\.js\b'; Arguments='server.js'; Directory=$tavern
    Grace=120; RetryAfter=$start; Failures=0; Process=$null
}
$mobile = $null

New-Item -ItemType Directory -Path $logs -Force | Out-Null
Write-WatchLog "Watchdog started, PID $PID."
try {
    while ($true) {
        try {
            if ([TavernPower]::SetThreadExecutionState(2147483649) -eq 0) {
                Write-WatchLog 'Could not register the system-awake request.'
            }
            Ensure-Service $engine
            Ensure-Service $web
            $wifi = Get-NetIPConfiguration -InterfaceAlias 'WLAN' -ErrorAction SilentlyContinue
            $ip = $wifi.IPv4Address | Select-Object -First 1
            if ($ip -and $wifi.IPv4DefaultGateway) {
                if (-not $mobile -or $mobile.Address -ne $ip.IPAddress -or $mobile.Prefix -ne $ip.PrefixLength) {
                    if ($mobile -and $mobile.Process -and -not $mobile.Process.HasExited) {
                        Stop-Process -Id $mobile.Process.Id
                    }
                    $mobile = @{
                        Name='mobile'; Address=$ip.IPAddress; Prefix=$ip.PrefixLength; Port=8001
                        Uri="http://$($ip.IPAddress):8001/"; Expected=401
                        Executable=$node; CommandPattern='\bmobile-access\.mjs\b'
                        Arguments=('"{0}" {1} {2}' -f $mobileScript, $ip.IPAddress, $ip.PrefixLength); Directory=$root
                        Grace=20; RetryAfter=(Get-Date); Failures=0; Process=$null
                    }
                }
                Ensure-Service $mobile
            }
        } catch {
            Write-WatchLog $_.Exception.Message
        }
        Start-Sleep -Seconds 12
    }
} finally {
    [void][TavernPower]::SetThreadExecutionState(2147483648)
}
