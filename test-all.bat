@echo off
chcp 65001 >nul
title DrawGuess Tests
cd /d "%~dp0"
echo Running all test suites...
echo.
node test\run-all.js
echo.
pause
