@echo off
setlocal EnableExtensions
chcp 65001 >nul
title DigitalBots Setup
color 0F
set "ROOT=%~dp0"
set "LOG=%TEMP%\DigitalBots-setup.log"
>"%LOG%" echo DigitalBots setup started %DATE% %TIME%
cls
echo.
echo  ================================================================
echo                           DIGITALBOTS
echo                         MANAGEMENT SETUP
echo  ================================================================
echo.
echo  This package contains the DigitalBots source and build pipeline.
echo  The native Windows setup executable is created by the Windows build.
echo.
if exist "%ROOT%DigitalBotsSetup.exe" goto run_setup
if exist "%ROOT%release\DigitalBotsSetup.exe" (
  copy /y "%ROOT%release\DigitalBotsSetup.exe" "%ROOT%DigitalBotsSetup.exe" >>"%LOG%" 2>&1
  if errorlevel 1 goto copy_failed
  goto run_setup
)
echo  The Windows application installer is not present in this source package.
echo.
echo  This is intentional: Tauri's supported Windows installer must be built
 echo  by a Windows MSVC toolchain or the included GitHub Actions workflow.
echo  Running a partial BAT install would create a shortcut to an app that
 echo  does not exist, so setup has stopped safely.
echo.
echo  NEXT STEPS:
echo   1. Upload this project to a GitHub repository.
echo   2. Open Actions and run 'Build DigitalBots Windows Installer'.
echo   3. Download the DigitalBots-Windows-Installer artifact.
echo   4. Extract that artifact and run install.bat again.
echo.
echo  Build documentation: docs\WINDOWS_BUILD.md
echo  Log: %LOG%
echo.
pause
exit /b 2

:run_setup
echo  Found DigitalBotsSetup.exe. Starting the official per-user installer...
echo Found installer: %DATE% %TIME% >>"%LOG%"
start /wait "DigitalBots Setup" "%ROOT%DigitalBotsSetup.exe"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo  Installer returned exit code %RC%.
  echo  Check Windows Installer events and the build artifact.
  echo Installer exit code %RC% >>"%LOG%"
  goto finish_error
)
echo.
echo  DigitalBots setup has finished.
echo  A Desktop shortcut should now be available.
echo  The first launch will ask for your main server HTTPS address.
echo.
echo Setup completed %DATE% %TIME% >>"%LOG%"
echo Log: %LOG%
pause
exit /b 0

:copy_failed
echo Could not copy the installer. Check folder permissions.
:finish_error
echo.
echo Setup did not complete successfully. Log: %LOG%
pause
exit /b 1
