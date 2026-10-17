@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title KaiHei Launcher

rem ============================================================
rem  One-click launcher: build (only when needed) + start server
rem  + open the game in the default browser.
rem
rem  NOTE: this file is intentionally ASCII-only. Windows cmd.exe
rem  parses .bat files with the system ANSI code page, so non-ASCII
rem  text here would corrupt command parsing.
rem ============================================================

set "PORT=8080"

rem --- If the server is already listening, just open the browser ---
netstat -an | findstr /c:":%PORT%" | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo Server is already running on port %PORT%.
  echo Opening the game in your browser ...
  start "" "http://127.0.0.1:%PORT%/"
  exit /b 0
)

echo ============================================================
echo    KaiHei Launcher  -  LAN Multiplayer
echo ============================================================
echo.

rem --- Rebuild only if the jar is missing or older than the newest source file.
rem     NOTE: cmd's "dir /o-d file1 file2" sorts each file spec SEPARATELY and
rem     then concatenates, so the first entry is always from the first spec and
rem     timestamps cannot be compared across two locations. Use PowerShell.
rem     Exit code: 1 = needs rebuild, 3 = jar missing, 0 = up to date.
set "NEED_BUILD=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $j=Get-Item -LiteralPath 'lkserver2-game.jar'; if(-not $j){exit 3}; $s=Get-ChildItem -LiteralPath 'src\lkserver' -Filter '*.java' | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1; if($s -and ($s.LastWriteTimeUtc -gt $j.LastWriteTimeUtc)){exit 1}; exit 0" >nul 2>nul
rem Any non-zero code (1 = changed, 3 = missing, 9009 = no PowerShell) means build.
if errorlevel 1 set "NEED_BUILD=1"
if "%NEED_BUILD%"=="1" (
  echo [1/2] Sources changed, building ... please wait.
  call build.bat
  if errorlevel 1 (
    echo.
    echo Build failed. Press any key to exit.
    pause >nul
    exit /b 1
  )
) else (
  echo [1/2] Build is up to date.
)
echo.

echo [2/2] Starting the server in a separate window ...
echo     Keep THAT window open while playing.
echo     Close it (or press Ctrl+C in it) to stop the server.
echo.
start "KaiHei Game Server" cmd /k "run.bat %PORT% www"

echo Waiting for the server to come up ...
rem Use ping as a portable delay: 'timeout' may resolve to a non-Windows binary on some setups.
ping -n 4 127.0.0.1 >nul

echo Opening the game in your browser ...
start "" "http://127.0.0.1:%PORT%/"

echo.
echo If the browser did not open, just visit: http://127.0.0.1:%PORT%/
echo To invite friends on the same LAN, share the address shown in the server window.
echo.
ping -n 4 127.0.0.1 >nul
exit /b 0
