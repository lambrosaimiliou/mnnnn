# Building the native Windows installer

The Tauri app is the actual desktop shell; it embeds the DigitalBots front-end assets and connects to the central HTTPS API selected on first launch.

## Recommended: GitHub Actions

1. Create an empty GitHub repository and upload this whole project.
2. Ensure `.env` and `deploy/.env` secrets are not committed.
3. Open **Actions** in the repository.
4. Select **Build DigitalBots Windows Installer**.
5. Choose **Run workflow**.
6. When the workflow completes, download the `DigitalBots-Windows-Installer` artifact.
7. Extract `DigitalBots_Installer.zip`, then run `install.bat`.

The workflow uses a Windows runner, installs Node.js 22 and the stable Rust toolchain, builds the web assets, and runs the Tauri Windows NSIS build. It packages the actual `DigitalBotsSetup.exe` with the BAT helpers and installation docs.

## Build locally on Windows

Install:

- Node.js 22.12 or newer.
- Rust stable via rustup.
- Microsoft C++ Build Tools with **Desktop development with C++**.
- Microsoft Edge WebView2 Runtime (normally already present on supported Windows 10/11 systems).

From PowerShell in the project root:

```powershell
npm install
npm run build:web
npm run tauri:build --workspace @digitalbots/desktop
```

Or run:

```powershell
.\installer\build-windows.ps1
```

The NSIS setup executable is created under:

`apps/desktop/src-tauri/target/release/bundle/nsis/`

The PowerShell helper copies it to `DigitalBotsSetup.exe` in the project root.

## Installer behavior

- NSIS install mode is `currentUser`, so no administrator elevation is required for normal installation.
- The installer hooks create and remove the `DigitalBots.lnk` Desktop shortcut.
- Tauri provides the native app and Start Menu integration.
- The installer uses the WebView2 download bootstrapper mode.
- It does not install MySQL or modify the central database.

## Why the source ZIP does not contain an EXE

A Windows setup executable must be built by the Windows target toolchain. This environment has Linux and no Windows MSVC/Tauri toolchain, so it cannot truthfully produce or test the native Windows installer. The included GitHub Actions workflow is the reproducible way to generate the actual installer. The BAT script explicitly refuses to fake a successful install when the EXE is absent.
