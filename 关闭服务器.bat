@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Tank Battle - Stop Server

rem ============================================================
rem  Stops the Tank Battle server: it kills whatever java.exe is
rem  LISTENING on the game port. Counterpart of "start game.bat".
rem
rem  HOW TO USE:
rem    Just double-click this file. No administrator rights needed.
rem    (You can only kill a process you own, and you own the one
rem     you started, so no elevation is required.)
rem
rem  NOTE: this file is intentionally ASCII-only. cmd.exe parses
rem  .bat files with the system ANSI code page, so non-ASCII text
rem  here would corrupt command parsing.
rem ============================================================

set "PORT=8080"

echo Looking for a server listening on port %PORT% ...
echo.

rem netstat lists the same PID twice (IPv4 + IPv6 rows), so dedupe with LAST.
set "FOUND=0"
set "LAST="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /c:":%PORT% " ^| findstr /i "LISTENING"') do (
  if not "%%P"=="!LAST!" (
    echo Stopping PID %%P ...
    taskkill /F /PID %%P >nul 2>nul
    if not errorlevel 1 set "FOUND=1"
    set "LAST=%%P"
  )
)

echo.
if "%FOUND%"=="0" (
  echo No server is listening on port %PORT%. Nothing to stop.
) else (
  echo Done. The server on port %PORT% has been stopped.
)
echo.
echo You can close this window now.
pause
