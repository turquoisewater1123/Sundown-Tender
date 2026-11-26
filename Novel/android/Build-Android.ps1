$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$subst = Join-Path $env:SystemRoot 'System32/subst.exe'
$drive = $null
if ($workspace -match '[^\x00-\x7f]') {
    $drive = 'R:', 'S:', 'T:', 'U:', 'V:', 'W:', 'Y:' | Where-Object { -not (Test-Path "$_\") } | Select-Object -First 1
    if (-not $drive) { throw 'No drive letter is available for the Android SDK workspace.' }
    & $subst $drive $workspace
    if ($LASTEXITCODE -ne 0) { throw 'Cannot map the Android SDK workspace to an ASCII path.' }
    $workspace = "$drive\"
}
try {
$sourceRoot = Join-Path $workspace 'Novel/android'
$toolchain = Join-Path $workspace 'runtime/android-toolchain'
if ($env:NIGHTREAD_TOOLCHAIN) { $toolchain = $env:NIGHTREAD_TOOLCHAIN }
$jdk = Get-ChildItem -LiteralPath $toolchain -Directory -Filter 'jdk-17*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($env:JAVA_HOME) { $jdk = Get-Item $env:JAVA_HOME }
if (-not $jdk) { throw 'Install JDK 17 in runtime/android-toolchain.' }
$platform = Join-Path $toolchain 'android-35/android.jar'
$tools = Join-Path $toolchain 'android-15'
if ($env:ANDROID_HOME) {
    $platform = Join-Path $env:ANDROID_HOME 'platforms/android-35/android.jar'
    $tools = Join-Path $env:ANDROID_HOME 'build-tools/35.0.0'
}
$java = Join-Path $jdk.FullName 'bin/java.exe'
$javac = Join-Path $jdk.FullName 'bin/javac.exe'
$archiveTool = Join-Path $jdk.FullName 'bin/jar.exe'
$keytool = Join-Path $jdk.FullName 'bin/keytool.exe'
$aapt = Join-Path $tools 'aapt.exe'
$aapt2 = Join-Path $tools 'aapt2.exe'
$zipalign = Join-Path $tools 'zipalign.exe'
$d8 = Join-Path $tools 'lib/d8.jar'
$signer = Join-Path $tools 'lib/apksigner.jar'
$build = Join-Path $sourceRoot 'build'
$output = Join-Path $sourceRoot '../downloads'
$signing = Join-Path $sourceRoot 'signing'

function Invoke-BuildTool([string]$Binary, [string[]]$Arguments) {
    & $Binary @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Binary failed with exit code $LASTEXITCODE." }
}

$classDir = Join-Path $build 'classes'
$resourceDir = Join-Path $build 'res'
$launcherDir = Join-Path $resourceDir 'mipmap-xxxhdpi'
New-Item -ItemType Directory -Force -Path $classDir, $launcherDir, $output, $signing | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot '../public/icon-192.png') -Destination (Join-Path $launcherDir 'ic_launcher.png')

$manifest = Join-Path $sourceRoot 'AndroidManifest.xml'
$resources = Join-Path $build 'resources.zip'
$classes = Join-Path $build 'classes.jar'
$unsigned = Join-Path $build 'unsigned.apk'
$aligned = Join-Path $build 'aligned.apk'
$keystore = Join-Path $signing 'nightread.p12'
$passwordFile = Join-Path $signing 'password.dpapi'
$apk = Join-Path $output 'NightRead-Android.apk'

Invoke-BuildTool $aapt2 @('compile', '--dir', $resourceDir, '-o', $resources)
Invoke-BuildTool $aapt2 @('link', '-I', $platform, '--manifest', $manifest, '-o', $unsigned, $resources)
Invoke-BuildTool $javac @('--release', '8', '-encoding', 'UTF-8', '-classpath', $platform, '-d', $classDir, (Join-Path $sourceRoot 'MainActivity.java'))
Invoke-BuildTool $archiveTool @('cf', $classes, '-C', $classDir, '.')
Invoke-BuildTool $java @('-cp', $d8, 'com.android.tools.r8.D8', '--min-api', '24', '--lib', $platform, '--output', $build, $classes)
Push-Location -LiteralPath $build
try { Invoke-BuildTool $aapt @('add', 'unsigned.apk', 'classes.dex') } finally { Pop-Location }
Invoke-BuildTool $zipalign @('-f', '4', $unsigned, $aligned)

if ((Test-Path -LiteralPath $keystore) -ne (Test-Path -LiteralPath $passwordFile)) {
    throw 'APK signing files are incomplete. Restore both signing files from the same backup.'
}
try {
    if (-not (Test-Path -LiteralPath $keystore)) {
        $env:NIGHTREAD_LOCAL_KEY = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
        Invoke-BuildTool $keytool @('-genkeypair', '-alias', 'nightread', '-keystore', $keystore, '-storepass:env',
            'NIGHTREAD_LOCAL_KEY', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
            '-dname', 'CN=NightRead Local Android', '-storetype', 'PKCS12')
        ConvertFrom-SecureString (ConvertTo-SecureString $env:NIGHTREAD_LOCAL_KEY -AsPlainText -Force) |
            Set-Content -LiteralPath $passwordFile
    } else {
        $secureKey = Get-Content -LiteralPath $passwordFile | ConvertTo-SecureString
        $env:NIGHTREAD_LOCAL_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
    }
    Invoke-BuildTool $java @('-jar', $signer, 'sign', '--ks', $keystore, '--ks-key-alias', 'nightread', '--ks-pass',
        'env:NIGHTREAD_LOCAL_KEY', '--v4-signing-enabled', 'false', '--out', $apk, $aligned)
    Invoke-BuildTool $java @('-jar', $signer, 'verify', '--verbose', $apk)
} finally {
    Remove-Item Env:NIGHTREAD_LOCAL_KEY -ErrorAction SilentlyContinue
}
Get-FileHash -LiteralPath $apk -Algorithm SHA256
} finally {
    if ($drive) { & $subst $drive /d }
}
