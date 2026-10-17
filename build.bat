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

call :find_jdk
if not defined JDK_BIN (
  echo.
  echo [ERROR] No JDK found. This project needs JDK 17 or newer.
  echo         Download: https://adoptium.net/temurin/releases/
  echo         After installing: set JAVA_HOME, or add javac to PATH,
  echo         or fill in JK_JDK_HOME at the top of this script.
  echo.
  exit /b 1
)
set "PATH=%JDK_BIN%;%PATH%"
echo Using JDK: %JDK_BIN%

rem --- Clean previous output first. ---
rem javac only ADDS .class files to out\; it never removes them. So a class
rem that was deleted or renamed in src\ would linger in out\ forever and even
rem get baked into the jar. Wiping out\ every time keeps it exactly in sync.
if exist out rmdir /s /q out
mkdir out
echo Compiling ...
javac -encoding UTF-8 -d out src\lkserver\*.java
if errorlevel 1 (
  echo [ERROR] Compile failed.
  exit /b 1
)

jar --create --file lkserver2-game.jar --main-class lkserver.Main -C out .
if errorlevel 1 (
  echo [ERROR] Packaging failed.
  exit /b 1
)

echo Build OK: lkserver2-game.jar
echo Next step: run.bat 8080 www
exit /b 0

rem -------------------------------------------------------------
rem Find JDK by priority: JK_JDK_HOME -> JAVA_HOME -> PATH -> bundled
rem -------------------------------------------------------------
:find_jdk
set "JDK_BIN="
if defined JK_JDK_HOME if exist "%JK_JDK_HOME%\bin\javac.exe" set "JDK_BIN=%JK_JDK_HOME%\bin"
if not defined JDK_BIN if defined JAVA_HOME if exist "%JAVA_HOME%\bin\javac.exe" set "JDK_BIN=%JAVA_HOME%\bin"
if not defined JDK_BIN for /f "delims=" %%I in ('where javac 2^>nul') do if not defined JDK_BIN set "JDK_BIN=%%~dpI"
if not defined JDK_BIN for /d %%D in ("%USERPROFILE%\.jdks\*") do if exist "%%~fD\bin\javac.exe" set "JDK_BIN=%%~fD\bin"
if not defined JDK_BIN if exist "%USERPROFILE%\.workbuddy\binaries\java\jdk-21.0.12.1+1\bin\javac.exe" set "JDK_BIN=%USERPROFILE%\.workbuddy\binaries\java\jdk-21.0.12.1+1\bin"
exit /b 0
