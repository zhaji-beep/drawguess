@echo off
chcp 65001 >nul
title DrawGuess - Network Diagnosis
cd /d "%~dp0"

REM ==================================================================
REM  One-click network diagnosis.
REM  Answers: what's my public IP / do I have one / is the relay
REM  server reachable / is the game running locally.
REM
REM  Chinese UI text lives in doctor.js (Node prints UTF-8).
REM ==================================================================

set "NODEEXE="
where node >nul 2>&1
if not errorlevel 1 set "NODEEXE=node"
if not defined NODEEXE if exist "C:\Program Files\nodejs\node.exe" set "NODEEXE=C:\Program Files\nodejs\node.exe"
if not defined NODEEXE if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODEEXE=C:\Program Files (x86)\nodejs\node.exe"

if not defined NODEEXE (
  echo.
  echo  [ERROR] Node.js not found. Install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

"%NODEEXE%" "doctor.js"

echo.
pause
