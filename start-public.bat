@echo off
chcp 65001 >nul
title DrawGuess Public Tunnel
cd /d "%~dp0"

REM ==================================================================
REM  Play over the Internet (no same-LAN requirement).
REM  Campus / office networks usually block device-to-device traffic,
REM  so the LAN address will NOT work there. This launches a free
REM  Cloudflare tunnel and prints a public https:// URL to share.
REM  Actual logic lives in start-public.js (auto URL capture +
REM  clipboard + auto reconnect).
REM ==================================================================

if not exist "tools\cloudflared.exe" (
  echo.
  echo  [ERROR] tools\cloudflared.exe not found. Download it with:
  echo  curl -L -o tools\cloudflared.exe "https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  echo.
  pause
  exit /b 1
)

set "NODEEXE="
where node >nul 2>&1
if not errorlevel 1 set "NODEEXE=node"
if not defined NODEEXE if exist "C:\Program Files\nodejs\node.exe" set "NODEEXE=C:\Program Files\nodejs\node.exe"
if not defined NODEEXE if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODEEXE=C:\Program Files (x86)\nodejs\node.exe"
if not defined NODEEXE (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org
  pause
  exit /b 1
)

"%NODEEXE%" start-public.js

echo.
echo  Tunnel closed.
pause
