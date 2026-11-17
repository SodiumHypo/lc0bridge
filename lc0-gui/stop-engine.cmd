@echo off
setlocal
title Stop Lc0 Backend
cd /d "%~dp0"

rem Machine-specific values (distro / port / container) come from config.json.
for /f "usebackq tokens=1,2,3" %%a in (`node -e "const c=require('./config.js').engine;process.stdout.write(c.distro+' '+c.port+' '+c.containerName)"`) do (
    set "DISTRO=%%a"
    set "PORT=%%b"
    set "CONTAINER=%%c"
)

echo [1/2] stopping bridge on port %PORT%...
rem Trailing space in the match avoids hitting ports like :86420.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    echo     kill PID %%p
    taskkill /F /T /PID %%p >nul 2>&1
)

echo [2/2] removing engine container...
wsl.exe -d %DISTRO% -- docker rm -f %CONTAINER% >nul 2>&1

echo Done.
timeout /t 2 >nul
