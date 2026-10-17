@echo off
rem ============================================================
rem  Downloads a portable JDK (Eclipse Temurin 21 LTS,
rem  Windows x64, zip) and unpacks it into .\jdk so this
rem  folder runs on any PC without a pre-installed JDK.
rem
rem  WHAT IT DOES:
rem    0. Skips everything if .\jdk\bin\java.exe already exists
rem    1. Downloads the JDK zip into %TEMP%  (~200 MB)
rem    2. Extracts it with tar.exe (built into Windows 10 1803+)
rem    3. Renames the extracted folder to .\jdk
rem    4. Points JK_JDK_HOME in build.bat / run.bat at .\jdk
rem    5. Verifies: .\jdk\bin\java.exe -version
rem
rem  No administrator rights required. Internet access required.
rem
rem  NOTE: this file is intentionally ASCII-only. Windows cmd.exe
rem  parses .bat files with the system ANSI code page, so non-ASCII
rem  text here would corrupt command parsing.
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Portable JDK Downloader

set "JDK_DIR=jdk"
set "JDK_API_URL=https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse"
set "ZIP=%TEMP%\lkserver2-jdk-portable.zip"

rem --- 0. Already installed? ------------------------------------
if exist "%JDK_DIR%\bin\java.exe" (
  echo Portable JDK is already present at %CD%\%JDK_DIR%
  echo.
  echo Nothing to do. If you want a fresh copy, delete the
  echo "%JDK_DIR%" folder and run this script again.
  echo.
  pause
  exit /b 0
)

echo ============================================================
echo   Portable JDK downloader for lkserver2-game
echo   Source: Eclipse Temurin JDK 21 LTS ^(Windows x64, zip^)
echo   Target: %CD%\%JDK_DIR%
echo ============================================================
echo.

rem --- 1. Download ----------------------------------------------
echo [1/4] Downloading JDK 21 ... about 200 MB, please wait.
if exist "%ZIP%" del /q "%ZIP%"
where curl >nul 2>nul
if not errorlevel 1 (
  curl -L --fail --silent --show-error --output "%ZIP%" "%JDK_API_URL%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%JDK_API_URL%' -OutFile '%ZIP%'"
)
if errorlevel 1 goto :dl_failed
if not exist "%ZIP%" goto :dl_failed

rem --- 2. Extract ------------------------------------------------
echo [2/4] Extracting ...
if exist jdk-stage rmdir /s /q jdk-stage
mkdir jdk-stage
where tar >nul 2>nul
if not errorlevel 1 (
  tar -xf "%ZIP%" -C jdk-stage
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%ZIP%' -DestinationPath 'jdk-stage' -Force"
)
if errorlevel 1 goto :ex_failed
if not exist "jdk-stage" goto :ex_failed

rem The zip contains a single top-level folder like "jdk-21.0.12.1+1".
rem Move whatever it is called to .\jdk
set "INNER="
for /d %%D in ("jdk-stage\*") do set "INNER=%%~fD"
if not defined INNER goto :ex_failed
if exist "%JDK_DIR%" rmdir /s /q "%JDK_DIR%"
move "!INNER!" "%JDK_DIR%" >nul
if errorlevel 1 goto :ex_failed
rmdir /s /q jdk-stage

rem --- 3. Point the build/run scripts at the bundled JDK -------
echo [3/4] Updating JK_JDK_HOME in build.bat and run.bat ...
call :patch_script build.bat
call :patch_script run.bat

rem --- 4. Verify -------------------------------------------------
echo [4/4] Verifying ...
"%JDK_DIR%\bin\java.exe" -version 2>&1
if errorlevel 1 goto :verify_failed

del /q "%ZIP%" 2>nul
echo.
echo ============================================================
echo   Done. This folder now carries its own JDK:
echo     %CD%\%JDK_DIR%
echo   build.bat and run.bat will use it automatically.
echo.
echo   You can now copy this whole folder to any Windows PC
echo   and double-click the launcher - no JDK needed there.
echo ============================================================
echo.
pause
exit /b 0

rem ----------------------------------------------------------------
rem Rewrite the JK_JDK_HOME line of a .bat to point at .\jdk.
rem The replacement text is the literal "%~dp0jdk" (built with
rem [char]37 so cmd.exe does not expand it here) - it stays pure
rem ASCII and is expanded by the target script at ITS runtime,
rem keeping the folder portable even if moved to another path.
rem The PowerShell command avoids literal double quotes so that
rem cmd.exe passes it through unharmed.
rem ----------------------------------------------------------------
:patch_script
if not exist "%~1" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -Command "$q=[char]34; $p=[char]37; (Get-Content -LiteralPath '%~1') -replace '(?m)^set .JK_JDK_HOME=.*', ('set ' + $q + 'JK_JDK_HOME=' + $p + '~dp0jdk' + $q) | Set-Content -LiteralPath '%~1' -Encoding ASCII"
echo     %~1 updated.
exit /b 0

:dl_failed
echo.
echo [ERROR] Download failed. Possible causes:
echo   - No internet connection
echo   - A proxy or firewall blocked api.adoptium.net
echo.
echo Manual fallback: open this URL in a browser, download the
echo zip, extract it here, and rename the folder to "jdk":
echo   %JDK_API_URL%
if exist "%ZIP%" del /q "%ZIP%"
echo.
pause
exit /b 1

:ex_failed
echo.
echo [ERROR] Extraction failed. tar.exe needs Windows 10 version
echo 1803 or newer. The downloaded zip is kept at:
echo   %ZIP%
echo Extract it manually, then rename the "jdk-21..." folder
echo to "jdk".
echo.
pause
exit /b 1

:verify_failed
echo.
echo [ERROR] The downloaded JDK did not run.
echo Please report this together with your Windows version.
echo.
pause
exit /b 1
