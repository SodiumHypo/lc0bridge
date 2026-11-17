@echo off
setlocal
title Lc0 XL Lichess Bridge - CLOSE THIS WINDOW TO STOP TAKEOVER
cd /d "%~dp0"

echo ============================================================
echo  Lc0 XL - lichess.org takeover bridge
echo  Think time and all other settings: config.json (bridge section)
echo.
echo  Before using:
echo    1. Start the backend first: start-engine.cmd
echo    2. Chrome with remote debugging enabled
echo       (chrome://inspect/#remote-debugging, then restart Chrome)
echo    3. Manually start any game on lichess.org (computer or online,
echo       any account; anonymous computer games work, no login needed)
echo.
echo  Scope: any already-started game where you are a player -
echo  computer (Stockfish), online human, or BOT-account online.
echo  Spectator views and finished games are skipped.
echo  Note: engine use in human games on normal accounts violates
echo  lichess fair-play rules (BOT accounts are the sanctioned option).
echo  It never starts games, resigns, or clicks rematch.
echo  Close the local GUI (index.html) while the bridge runs -
echo  both would drive the same engine.
echo ============================================================
echo.
node lichess-bridge.js %*
echo.
echo Bridge exited (code %ERRORLEVEL%).
pause
