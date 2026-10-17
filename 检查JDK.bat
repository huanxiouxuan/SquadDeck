@echo off
rem CheckJDK.bat - check whether this PC has a JDK; if not, prompt to download.
rem ASCII-only by design: cmd.exe parses .bat in the ANSI codepage (GBK on
rem zh-CN), so any non-ASCII byte corrupts command parsing. Chinese UI lives
rem in CheckJDK.ps1 (UTF-8 with BOM), which PowerShell reads correctly.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0CheckJDK.ps1"
