@echo off
setlocal
cd /d "%~dp0"

rem Port comes from config.json (engine section).
for /f "usebackq tokens=1" %%a in (`node -e "process.stdout.write(String(require('./config.js').engine.port))"`) do set "PORT=%%a"

rem If a backend is already up, just open it - do not start a second one.
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul
if not errorlevel 1 (
    start "" http://127.0.0.1:%PORT%
    exit /b 0
)

start "" http://127.0.0.1:%PORT%
node server.js
