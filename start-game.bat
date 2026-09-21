@echo off
chcp 65001 >nul
title DrawGuess - LAN Server
cd /d "%~dp0"

REM ==================================================================
REM  This file is ASCII-only ON PURPOSE. Do not add Chinese text here.
REM
REM  cmd.exe cannot reliably parse a batch file that contains UTF-8
REM  Chinese: it loses sync at line/chunk boundaries and starts reading
REM  mid-line, producing errors like
REM      'itle' is not recognized as an internal or external command
REM      'oto' is not recognized as an internal or external command
REM  (title / goto with their first characters eaten).
REM
REM  Verified on this machine: ASCII + LF is fine, ASCII + CRLF is fine,
REM  Chinese + LF is always broken, Chinese + CRLF is still unreliable
REM  for longer files. So: keep this file pure ASCII and let Node print
REM  all Chinese UI text (Node emits UTF-8, which renders correctly
REM  under "chcp 65001").
REM
REM  All the Chinese you used to see here (LAN addresses, firewall hints,
REM  word-pool stats) is printed by server.js a few lines below.
REM ==================================================================

REM Port check: only look at LOCAL listening sockets. The old
REM "findstr \":3000\"" also matched a browser's outbound connection to
REM the public game server and wrongly claimed the LAN server was already
REM running. Keep the pattern anchored to LISTENING.
netstat -ano 2>nul | findstr "LISTENING" | findstr ":3000 " >nul
if not errorlevel 1 (
  echo.
  echo  [INFO] Port 3000 is already in use - the LAN server is probably running.
  echo  Open in browser: http://localhost:3000
  echo  To restart it, close the old window first ^(or run stop-game.bat^).
  echo.
  pause
  exit /b 0
)

REM Locate node.exe: PATH -> common install dirs -> managed runtimes
set "NODEEXE="
where node >nul 2>&1
if not errorlevel 1 set "NODEEXE=node"
if not defined NODEEXE if exist "C:\Program Files\nodejs\node.exe" set "NODEEXE=C:\Program Files\nodejs\node.exe"
if not defined NODEEXE if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODEEXE=C:\Program Files (x86)\nodejs\node.exe"
if not defined NODEEXE if exist "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" set "NODEEXE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not defined NODEEXE if exist "C:\Users\Administrator\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe" set "NODEEXE=C:\Users\Administrator\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe"
if not defined NODEEXE (
  echo.
  echo  [ERROR] Node.js not found. Install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

REM Allow inbound TCP 3000 (needs admin; failure is non-fatal)
netsh advfirewall firewall show rule name="DrawGuess3000" >nul 2>&1
if errorlevel 1 (
  netsh advfirewall firewall add rule name="DrawGuess3000" dir=in action=allow protocol=TCP localport=3000 >nul 2>&1
  if errorlevel 1 echo  [INFO] Could not add the firewall rule ^(needs admin^). If LAN friends cannot connect, right-click this file and "Run as administrator" once.
)

echo.
echo  Starting the LAN server, please wait...
echo  Keep this window open while playing; close it to stop the server.
echo.

"%NODEEXE%" server.js

echo.
echo  Server stopped.
pause
