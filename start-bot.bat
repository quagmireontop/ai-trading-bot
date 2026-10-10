@echo off
title AI Trading Bot
cd /d "%~dp0"

rem Start the website if it is not already running on port 3000
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if errorlevel 1 (
  if not exist node_modules call npm install
  start "AI Trading Bot - keep this window open" /min cmd /k npm start
  timeout /t 4 /nobreak >nul
)

start "" http://localhost:3000
