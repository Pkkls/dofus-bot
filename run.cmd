@echo off
cd /d %~dp0
start "" /min cmd /c "ping -n 25 127.0.0.1 >nul & start http://127.0.0.1:7777"
:loop
node bot.mjs
if %errorlevel%==2 exit /b 2
ping -n 16 127.0.0.1 >nul
goto loop
