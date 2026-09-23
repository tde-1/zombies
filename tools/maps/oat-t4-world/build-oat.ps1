<#
.SYNOPSIS
  Build a private OpenAssetTools Unlinker that can dump a T4 (WaW) GfxWorld -- the world
  shell -- straight from a map fastfile, with no game launch.

.DESCRIPTION
  OAT (GPL-3.0, https://github.com/Laupetin/OpenAssetTools) reads T4 GfxWorld but has no
  writer for it. GfxWorldDumperT4.{h,cpp} beside this script is that writer (GPL-3.0, a
  derivative of OAT). This script:
    1. clones OAT at -Tag (default v0.33.0, the release tools\oat already carries) into
       -Src, with submodules, if it is not there;
    2. copies the dumper into src\ObjWriting\Game\T4\World\ and registers it in
       ObjWriterT4.cpp (idempotent);
    3. runs OAT's own generate.bat (premake5, downloaded and hash-checked by OAT's script);
    4. builds UnlinkerCli Release|x64 with MSBuild at -Jobs parallel compiles (a small
       number: B's PC froze on memory on 2026-09-23; the build is a heavy job, hold
       ZombiesDev\locks\heavy.lock around it);
    5. copies the resulting Unlinker.exe to -Dest (ZombiesDev\tools\oat-geo\Unlinker.exe).
  Nothing is written into the repo or into B's Steam install.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\maps\oat-t4-world\build-oat.ps1
#>
[CmdletBinding()]
param(
    [string]$Src = 'C:\Users\b\ZombiesDev\thirdparty\OpenAssetTools',
    [string]$Tag = 'v0.33.0',
    [string]$Dest = 'C:\Users\b\ZombiesDev\tools\oat-geo',
    [int]$Jobs = 3
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

if (-not (Test-Path -LiteralPath (Join-Path $Src '.git'))) {
    git clone --depth 1 --branch $Tag --recurse-submodules --shallow-submodules `
        https://github.com/Laupetin/OpenAssetTools.git $Src
    if ($LASTEXITCODE) { throw "git clone failed ($LASTEXITCODE)" }
}

# ---- 2. the dumper --------------------------------------------------------------------
$dst = Join-Path $Src 'src\ObjWriting\Game\T4\World'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -LiteralPath (Join-Path $here 'GfxWorldDumperT4.h'), (Join-Path $here 'GfxWorldDumperT4.cpp') -Destination $dst -Force
$ow = Join-Path $Src 'src\ObjWriting\Game\T4\ObjWriterT4.cpp'
$txt = [IO.File]::ReadAllText($ow)
if ($txt -notmatch 'GfxWorldDumperT4') {
    $txt = $txt.Replace('#include "Localize/LocalizeDumperT4.h"',
        "#include `"Localize/LocalizeDumperT4.h`"`r`n#include `"World/GfxWorldDumperT4.h`"")
    $txt = $txt.Replace('RegisterAssetDumper(std::make_unique<map_ents::DumperT4>());',
        "RegisterAssetDumper(std::make_unique<map_ents::DumperT4>());`r`n    RegisterAssetDumper(std::make_unique<gfx_world::DumperT4>());")
    if ($txt -notmatch 'gfx_world::DumperT4') { throw 'could not register the dumper in ObjWriterT4.cpp' }
    [IO.File]::WriteAllText($ow, $txt)
}

# ---- 3. premake ------------------------------------------------------------------------
Push-Location $Src
try {
    $env:PREMAKE_NO_PROMPT = '1'
    # Start-Process, not `cmd /c generate.bat`: under this shell the latter did not find
    # the batch file even with the location pushed (cmd's cwd is the process cwd).
    $p = Start-Process -FilePath $env:ComSpec -ArgumentList '/c', "`"$Src\generate.bat`"" `
        -WorkingDirectory $Src -NoNewWindow -Wait -PassThru
    if ($p.ExitCode) { throw "generate.bat failed ($($p.ExitCode))" }
    $sln = Get-ChildItem -LiteralPath (Join-Path $Src 'build') -Filter *.sln* | Select-Object -First 1
    if (-not $sln) { throw 'premake produced no solution under build\' }

    # ---- 4. build --------------------------------------------------------------------------
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $msbuild = & $vswhere -latest -prerelease -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
    if (-not $msbuild) { throw 'MSBuild not found' }
    # The project, not the .slnx: a solution-level /t:UnlinkerCli does not resolve (MSB4057).
    # Project references pull in everything it needs. x64: a big custom zone is >1 GB loaded.
    # Building a project alone leaves $(SolutionDir) empty, and the code-generation steps run
    # $(SolutionDir)\buildtools\Release_x64\{RawTemplater,ZoneCodeGenerator}.exe -- so pass it,
    # and build those two generators and the ZoneCode generation step first (the solution orders them; project refs do not).
    $solDir = (Join-Path $Src 'build') + '\'
    foreach ($p in 'src\RawTemplater\RawTemplater.vcxproj', 'src\ZoneCodeGenerator\ZoneCodeGenerator.vcxproj', 'src\ZoneCode\ZoneCode.vcxproj', 'src\UnlinkerCli\UnlinkerCli.vcxproj') {
        & $msbuild (Join-Path $Src "build\$p") /p:Configuration=Release /p:Platform=x64 "/p:SolutionDir=$solDir" /m:$Jobs /p:CL_MPCount=1 /nodeReuse:false /v:minimal /nologo
        if ($LASTEXITCODE) { throw "MSBuild $p failed ($LASTEXITCODE)" }
    }
}
finally { Pop-Location }

# ---- 5. install --------------------------------------------------------------------------
$exe = Get-ChildItem -LiteralPath (Join-Path $Src 'build\bin') -Recurse -Filter 'Unlinker.exe' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exe) { throw 'Unlinker.exe was not built' }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $Dest 'Unlinker.exe') -Force
Get-ChildItem -LiteralPath $exe.DirectoryName -Filter *.dll | Copy-Item -Destination $Dest -Force
Write-Host "installed $($exe.FullName) -> $Dest"
