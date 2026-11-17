@echo off
setlocal EnableExtensions
title DigitalBots
set "APP=%LOCALAPPDATA%\Programs\DigitalBots\DigitalBots.exe"
if not exist "%APP%" (
  echo DigitalBots desktop application is not installed.
  echo Run the official DigitalBots setup executable first.
  pause
  exit /b 1
)
start "DigitalBots" "%APP%"
exit /b 0
