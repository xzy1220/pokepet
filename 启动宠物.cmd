@echo off
rem Double-click to start the desktop pet (dev mode, no packaging needed).
set "ELECTRON_RUN_AS_NODE="
set "APP=%~dp0app"
set "EL=%USERPROFILE%\.dsh\electron\electron.exe"
if not exist "%EL%" (
  echo Cannot find Electron: %EL%
  pause
  exit /b 1
)
cd /d "%APP%"
start "" "%EL%" "%APP%"
exit /b 0
