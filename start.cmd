@echo off
cd /d "%~dp0"
set "EASYINPUT_REPEATER_PORT=8766"
start "EasyInput Repeater" cmd /k "cd /d ""%~dp0"" ^&^& set EASYINPUT_REPEATER_PORT=8766 ^&^& node server.mjs"
start "" http://127.0.0.1:8766
