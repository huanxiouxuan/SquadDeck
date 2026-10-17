@echo off
rem MakeShortcut.bat - create the launcher shortcut (.lnk) with the project icon.
rem ASCII-only by design: cmd.exe parses .bat in the ANSI codepage (GBK on
rem zh-CN), so any non-ASCII byte corrupts command parsing. Chinese UI lives
rem in MakeShortcut.ps1 (UTF-8 with BOM), which PowerShell reads correctly.
rem
rem Usage:
rem   MakeShortcut.bat            create the shortcut (desktop + this folder)
rem   MakeShortcut.bat selftest   verify the shortcut machinery works
chcp 65001 >nul
cd /d "%~dp0"
if /i "%~1"=="selftest" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0MakeShortcut.ps1" -SelfTest
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0MakeShortcut.ps1"
)
