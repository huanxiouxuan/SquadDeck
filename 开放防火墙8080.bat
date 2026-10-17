@echo off
chcp 65001 >nul
setlocal
title Snake Battle - Open port 8080 in Windows Firewall

rem ============================================================
rem  Adds (or removes) an inbound firewall rule that allows
rem  other computers on the network to reach this machine on
rem  TCP port 8080.
rem
rem  HOW TO USE:
rem    1. Right-click this file  ->  "Run as administrator".
rem    2. It adds the rule and prints the result.
rem
rem  To REMOVE the rule later, run this file as administrator
rem  with the argument:  remove
rem
rem  NOTE: this file is intentionally ASCII-only. cmd.exe parses
rem  .bat files with the system ANSI code page, so non-ASCII text
rem  here would break command parsing.
rem ============================================================

rem --- Require administrator (the rule change needs elevation) ---
net session >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Administrator rights are required.
  echo         Please right-click this file and choose
  echo         "Run as administrator".
  echo.
  pause
  exit /b 1
)

if /i "%~1"=="remove" goto :remove
if /i "%~1"=="delete" goto :remove

echo Adding inbound rule: TCP 8080  (profiles: Domain/Private/Public) ...
netsh advfirewall firewall delete rule name="Snake Battle 8080" >nul 2>nul
netsh advfirewall firewall add rule name="Snake Battle 8080" dir=in action=allow protocol=TCP localport=8080 profile=any
if errorlevel 1 (
  echo.
  echo [ERROR] Failed to add the rule.
  pause
  exit /b 1
)
echo.
echo Done. Other computers can now connect to this machine on port 8080,
echo provided they are on a network that can reach one of this machine's IPs.
echo.
echo Current rule:
netsh advfirewall firewall show rule name="Snake Battle 8080"
echo.
pause
exit /b 0

:remove
echo Removing rule "Snake Battle 8080" ...
netsh advfirewall firewall delete rule name="Snake Battle 8080"
echo.
pause
exit /b 0
