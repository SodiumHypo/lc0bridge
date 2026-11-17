@echo off
setlocal
title Lc0 XL Backend - CLOSE THIS WINDOW TO STOP INFERENCE
cd /d "%~dp0"

rem Machine-specific values (distro / port / container) come from config.json.
for /f "usebackq tokens=1,2,3" %%a in (`node -e "const c=require('./config.js').engine;process.stdout.write(c.distro+' '+c.port+' '+c.containerName)"`) do (
    set "DISTRO=%%a"
    set "PORT=%%b"
    set "CONTAINER=%%c"
)

echo ============================================================
echo  Lc0 XL inference backend
echo  Bridge : http://127.0.0.1:%PORT%
echo.
echo  Closing this window stops the engine immediately.
echo  Press Ctrl+C for a graceful stop.
echo ============================================================
echo.

node server.js
set "RC=%ERRORLEVEL%"

if "%RC%"=="2" (
    echo.
    echo [info] backend already running - opening the existing GUI instead.
    start "" http://127.0.0.1:%PORT%
    timeout /t 3 >nul
    exit /b 0
)

echo.
echo [cleanup] removing engine container...
wsl.exe -d %DISTRO% -- docker rm -f %CONTAINER% >nul 2>&1
echo [exit] code %RC%
pause
