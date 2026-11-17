@echo off
setlocal
cd /d "%~dp0..\lc0-gui"
for /f "usebackq tokens=1,2,3" %%a in (`node -e "const c=require('./config.js').engine;process.stdout.write(c.distro+' '+c.port+' '+c.containerName)"`) do (
    set "DISTRO=%%a"
    set "PORT=%%b"
    set "CONTAINER=%%c"
)
echo DISTRO=%DISTRO% PORT=%PORT% CONTAINER=%CONTAINER%
for /f "usebackq tokens=1" %%a in (`node -e "process.stdout.write(String(require('./config.js').engine.port))"`) do set "PORT2=%%a"
echo PORT2=%PORT2%
