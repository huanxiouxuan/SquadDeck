@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem =============================================================
rem  If auto-detection cannot find a JDK, set it manually here:
rem      set "JK_JDK_HOME=D:\Java\jdk-21"
rem
rem  NOTE: this file is intentionally ASCII-only. Windows cmd.exe
rem  parses .bat files using the ANSI code page (GBK on zh-CN), so
rem  non-ASCII text here would corrupt the command parsing.
rem =============================================================
set "JK_JDK_HOME="

rem chcp 65001 makes the console UTF-8, so the server's Chinese log
rem output (written as UTF-8) displays correctly.

if "%~1"=="" (
  echo Usage: run.bat ^<port^> ^<directory-to-serve^> [sub-reactor-count]
  echo Example: run.bat 8080 www
  echo          run.bat 8080 D:\my_site 8
  exit /b 1
)

if not exist lkserver2-game.jar (
  echo lkserver2-game.jar not found, building first ...
  call build.bat
  if errorlevel 1 exit /b 1
)

call :find_jdk
if not defined JDK_BIN (
  echo.
  echo [ERROR] No JDK found, cannot run.
  echo         This project needs JDK 17 or newer.
  echo         Download: https://adoptium.net/temurin/releases/
  echo.
  exit /b 1
)
set "PATH=%JDK_BIN%;%PATH%"

java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -jar lkserver2-game.jar %1 %2 %3
exit /b 0

rem -------------------------------------------------------------
rem Find JDK by priority: JK_JDK_HOME -> JAVA_HOME -> PATH -> bundled
rem -------------------------------------------------------------
:find_jdk
set "JDK_BIN="
if defined JK_JDK_HOME if exist "%JK_JDK_HOME%\bin\java.exe" set "JDK_BIN=%JK_JDK_HOME%\bin"
if not defined JDK_BIN if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" set "JDK_BIN=%JAVA_HOME%\bin"
if not defined JDK_BIN for /f "delims=" %%I in ('where java 2^>nul') do if not defined JDK_BIN set "JDK_BIN=%%~dpI"
if not defined JDK_BIN for /d %%D in ("%USERPROFILE%\.jdks\*") do if exist "%%~fD\bin\java.exe" set "JDK_BIN=%%~fD\bin"
if not defined JDK_BIN if exist "%USERPROFILE%\.workbuddy\binaries\java\jdk-21.0.12.1+1\bin\java.exe" set "JDK_BIN=%USERPROFILE%\.workbuddy\binaries\java\jdk-21.0.12.1+1\bin"
exit /b 0
