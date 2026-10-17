@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Network check

rem ============================================================
rem  Measures the network path between this PC and another PC.
rem  Uses ONLY tools that ship with Windows (ping + curl), so the
rem  OTHER person can run it too - nothing to install.
rem
rem  WHAT IT TELLS YOU
rem    [1/2] ping  : packets lost, min/avg/max round-trip time
rem    [2/2] curl  : real HTTP round trip to the game server
rem
rem  HOW TO USE
rem    Run it on EITHER machine, passing the OTHER machine's IP:
rem        on the other PC :  <this file> 10.67.8.88
rem        on this PC      :  <this file> <the other PC's IP>
rem    The test that matters most is the one run ON THE OTHER PC
rem    pointing at THIS PC's IP - that is the real in-game path.
rem
rem  NOTE: this file is intentionally ASCII-only. cmd.exe parses
rem  .bat files with the system ANSI code page, so non-ASCII text
rem  here would corrupt command parsing.
rem ============================================================

if "%~1"=="" (
  echo Usage: %~nx0 ^<other PC IP^>
  echo Example: %~nx0 10.67.8.88
  echo.
  echo Run this ON THE OTHER PC and pass THIS PC's IP.
  pause
  exit /b 1
)

set "IP=%~1"
set "PORT=8080"
set "CURL=%SystemRoot%\System32\curl.exe"
if not exist "%CURL%" set "CURL=curl"

echo ============================================================
echo  Network check against %IP%
echo ============================================================
echo.
echo [1/2] ICMP ping, 20 packets.
echo       Look at the summary: packets lost, and min/avg/max time.
echo.
ping -n 20 %IP%
echo.
echo [2/2] HTTP round trip to the game server, 15 samples.
echo       Each line is:  HTTP-status  seconds
echo.
set /a ok=0
set /a bad=0
for /l %%i in (1,1,15) do (
  set "t="
  for /f "delims=" %%T in ('%CURL% -s -o NUL -m 3 -w "%%{http_code} %%{time_total}" "http://%IP%:%PORT%/api/info" 2^>nul') do set "t=%%T"
  if defined t (
    echo    sample %%i : !t!
    if "!t:~0,1!"=="2" ( set /a ok+=1 ) else ( set /a bad+=1 )
  ) else (
    echo    sample %%i : no response
    set /a bad+=1
  )
)
echo.
echo   reachable = !ok! / 15 , failed = !bad! / 15
echo.
if !ok! equ 0 (
  echo   VERDICT: the game server is NOT reachable from this PC.
  echo   If you are on the same Wi-Fi, the network likely has
  echo   "client isolation" - devices cannot see each other.
  echo   Switch to Radmin VPN or a phone hot spot.
) else if !bad! gtr 0 (
  echo   VERDICT: reachable but UNSTABLE - some requests failed.
  echo   Packet loss makes the game feel laggy and jumpy.
) else (
  echo   VERDICT: reachable with no lost requests.
  echo   Now read the timings above. Under 0.030 s is great;
  echo   0.030-0.070 s is fine; above 0.070 s is slow and
  echo   above 0.130 s is very slow - that would explain the lag.
)
echo.
pause
