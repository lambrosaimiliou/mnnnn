@echo off
setlocal EnableExtensions
title DigitalBots Uninstall
set "APP=%LOCALAPPDATA%\Programs\DigitalBots\uninstall.exe"
if exist "%APP%" (
  echo This removes the local DigitalBots desktop application only.
  echo Your central server and digitalbotsclients database are not deleted.
  echo.
  choice /C YN /M "Continue with uninstall"
  if errorlevel 2 exit /b 0
  start /wait "DigitalBots Uninstaller" "%APP%"
  exit /b %ERRORLEVEL%
)
echo DigitalBots uninstaller was not found at:
echo %APP%
echo Use Windows Settings ^> Apps ^> Installed apps to remove DigitalBots.
pause
exit /b 1
