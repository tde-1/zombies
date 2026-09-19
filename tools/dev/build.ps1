<#
.SYNOPSIS
  Configure and build enw_t4.dll (32-bit, MSVC).

.DESCRIPTION
  Uses the cmake.exe that ships inside VS BuildTools, so nothing has to be on PATH.
  Builds into build\<Name> (dev-box.md rule 11: never a shared build dir) and copies
  the result to build\<Name>\enw_t4.dll whatever generator put it where.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\dev\build.ps1
  powershell -ExecutionPolicy Bypass -File tools\dev\build.ps1 -Name dedi -Config Debug -Clean
#>
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_-]+$')]
    [string]$Name = 'foundation',

    [ValidateSet('Debug', 'Release', 'RelWithDebInfo')]
    [string]$Config = 'RelWithDebInfo',

    [switch]$Clean,

    # Skip other agents' components if one of them is breaking the build.
    [switch]$CoreOnly,

    [string]$BuildTools = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools'
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$cmake = Join-Path $BuildTools 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (-not (Test-Path -LiteralPath $cmake)) { throw "cmake.exe not found at $cmake" }

$buildDir = Join-Path $repo "build\$Name"
if ($Clean -and (Test-Path -LiteralPath $buildDir)) {
    Write-Host "Cleaning $buildDir" -ForegroundColor DarkGray
    Remove-Item -LiteralPath $buildDir -Recurse -Force
}

$cfgArgs = @(
    '-S', $repo,
    '-B', $buildDir,
    '-G', 'Visual Studio 18 2026',
    '-A', 'Win32'                      # CoDWaW.exe is x86. Non-negotiable.
)
if ($CoreOnly) {
    $cfgArgs += @('-DENW_WITH_SERVER_COMPONENTS=OFF', '-DENW_WITH_CLIENT_COMPONENTS=OFF')
}

Write-Host "Configuring ($Config, Win32) -> $buildDir" -ForegroundColor Cyan
& $cmake @cfgArgs
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed ($LASTEXITCODE)" }

Write-Host "Building" -ForegroundColor Cyan
& $cmake --build $buildDir --config $Config --parallel
if ($LASTEXITCODE -ne 0) { throw "cmake build failed ($LASTEXITCODE)" }

# Normalise the output location across generators.
$built = Get-ChildItem -LiteralPath $buildDir -Recurse -Filter 'enw_t4.dll' -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $built) { throw "build succeeded but enw_t4.dll was not found under $buildDir" }

$final = Join-Path $buildDir 'enw_t4.dll'
if ($built.FullName -ne $final) {
    Copy-Item -LiteralPath $built.FullName -Destination $final -Force
    $pdb = [IO.Path]::ChangeExtension($built.FullName, '.pdb')
    if (Test-Path -LiteralPath $pdb) {
        Copy-Item -LiteralPath $pdb -Destination (Join-Path $buildDir 'enw_t4.pdb') -Force
    }
}

$info = Get-Item -LiteralPath $final
Write-Host ("OK  {0}  ({1:N0} bytes, {2})" -f $final, $info.Length, $info.LastWriteTime) -ForegroundColor Green
Write-Output $final
