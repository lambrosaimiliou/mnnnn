# Verification report

## Checks performed in this environment

- `node --check` on the Express API, migration runner, Discord integration and browser JavaScript.
- Frontend build script copies the versioned UI source into the server's static public directory.
- Static HTML and CSS assets are present.
- Tauri configuration, Rust entry point, Windows NSIS hook and Windows CI workflow are included.
- The ZIP package is checked for integrity before delivery.

## Not executed here

- No live MySQL/MariaDB instance or credentials were supplied, so SQL migrations, database transactions and session persistence have not been executed against a real server.
- No Discord bot token or server access was supplied, so Gateway intents, guild member counts and invite attribution were not live-tested.
- No domain, DNS or TLS certificate was supplied, so the HTTPS reverse proxy and remote desktop cookie/CORS path have not been tested end to end.
- The current tool environment is Linux without the Windows MSVC/Tauri toolchain, so no `.exe` installer or Windows Desktop shortcut test was produced here. The GitHub Actions Windows build is included to create and test that artifact on a Windows runner.

Do not interpret included integration code or a source-level check as proof of a live deployment. Run the Windows build workflow and test the central server with your own credentials before using production data.
