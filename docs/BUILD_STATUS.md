# DigitalBots build and verification status

## Package type

This delivery is the **DigitalBots project source and build kit**, not a precompiled Windows installer. It includes the server, web UI, MySQL schema/migration runner, Tauri desktop project, per-user NSIS configuration, Windows helper scripts, Docker deployment templates and a Windows GitHub Actions workflow.

A native `DigitalBotsSetup.exe` is not included because this build environment does not have the Windows MSVC/Tauri toolchain. `installer/install.bat` intentionally refuses to create a shortcut or claim success when that executable is missing. The Windows workflow creates the real NSIS executable and packages it as `DigitalBots_Installer.zip`.

## Implemented in source

- Central Express API and web application backed by MySQL/MariaDB.
- First-run `digitalbots` administrator creation with a bcrypt password hash and separate server-side one-time setup key.
- Server-side sessions, CSRF checks, login rate limiting and 5–10 hour idle timeout configuration.
- First administrator network address trust, pending unknown-IP logins, approve/reject actions, blocked addresses and trust revocation.
- Client create, search, filter, edit and archive. Archive preserves payment and subscription history.
- Subscription creation and extension with Basic, Premium and Business plans and the six requested durations.
- Payment entry and per-currency revenue totals; refunded amounts are subtracted and pending amounts are not counted as received.
- Currency-aware per-client paid totals and a chart in the selected workspace currency.
- CSV client and payment reports.
- Light theme default, dark theme, compact tables and settings persistence in the local installation/browser.
- Optional Discord Gateway integration for the specified guild, server-side bot token, member snapshots, invite tracking and webhook alerts.
- Tauri 2 Windows desktop source configured for per-user NSIS installation, WebView2 bootstrapper and Desktop shortcut hooks.
- Docker Compose, database migrations, Nginx HTTPS example and a Windows build workflow.

## Checks actually run in this environment

- JavaScript syntax checks with `node --check` for application, migration, Discord and frontend scripts.
- JSON parsing checks for project and Tauri configuration files.
- Frontend build script successfully copied the UI into `apps/server/public`.
- Static HTML ID references checked; dynamic setup-confirm IDs are intentionally created by the login UI at runtime.
- Branding and secret scans found no legacy product labels and no occurrence of the old password shared earlier in the conversation.
- ZIP integrity check is performed on the source archive before delivery.

## Not run / still requires your infrastructure

- MySQL migrations, transactions and session persistence against a live MySQL/MariaDB server.
- Live HTTPS reverse proxy and remote browser/Tauri session flow.
- Discord bot login, privileged intents, guild membership and invite attribution.
- Native Tauri compilation, NSIS installer execution, Windows shortcut verification and uninstallation on Windows.
- Full acceptance/end-to-end tests against the user's main server.

## Remaining scope before a production-complete release

- Build and test the real Windows installer on a Windows runner.
- Deploy the central server to the user's actual domain/VPS and validate its HTTPS configuration.
- Add and verify live Discord bot credentials and optional webhook.
- Implement additional administration features from the broader product brief that are not yet in this source build, including TOTP MFA, active-session management, automated in-product backup/restore, scheduled digest notifications, payment editing/voiding and full audit-report tooling.

Do not use this source build with production client records until the missing infrastructure tests and deployment security checks have been completed.
