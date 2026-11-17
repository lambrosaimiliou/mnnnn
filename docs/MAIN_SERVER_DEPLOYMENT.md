# Main Server Deployment

The main server is the single source of truth. Desktop installations do not run their own MySQL database and must not receive SQL credentials.

## 1. Prepare the server

Recommended deployment: a Linux VPS or private server with Docker Engine and Docker Compose, a DNS name, and HTTPS from an ACME certificate provider.

Copy `deploy/.env.example` to `deploy/.env`. Generate independent secret values (for example, `openssl rand -hex 32`) and set:

- `DB_USER` to a dedicated application DB username.
- `DB_PASSWORD` to a long random password.
- `MYSQL_ROOT_PASSWORD` to a different long random password.
- `SESSION_SECRET` to at least 32 random bytes.
- `INITIAL_SETUP_KEY` to a separate random value of at least 32 characters. This is required for the one-time first administrator setup; do not share it with ordinary users.
- `DISCORD_BOT_TOKEN` only if Discord analytics are enabled.
- `DISCORD_WEBHOOK_URL` only if progress notifications are enabled.

Do not commit `deploy/.env`.

## 2. Build the web assets and start services

From the project root:

```bash
npm run build:web
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
```

Compose starts MySQL, waits for its health check, applies SQL migrations, and starts the DigitalBots API/web server. The app is bound to `127.0.0.1:6767` on the host; MySQL has no published public port.

## 3. HTTPS reverse proxy

Configure Nginx or an equivalent trusted reverse proxy with TLS and proxy traffic to `http://127.0.0.1:6767`. An example is in `deploy/nginx.conf.example`.

The container sets `TRUST_PROXY=true` because the app port is only loopback-bound and should only be reached through that proxy. Do not publish port 6767 directly or allow clients to bypass the proxy. The reverse proxy must overwrite the forwarded headers and provide the actual client address.

The example server environment sets `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=none` for the Tauri webview's cross-origin API requests. Keep CORS limited to the Tauri origins plus same-origin web traffic.

## 4. Initial setup

Open your public HTTPS URL, such as `https://manage.example.com/desktop6767`. The first visit prompts you for the `INITIAL_SETUP_KEY` from the server environment and then lets you set the DigitalBots administrator password. The initial network IP is trusted automatically. This extra one-time key prevents an arbitrary visitor from claiming the administrator account before you do. Keep access to that device or another trusted session while approving new IPs.

## 5. HeidiSQL access

HeidiSQL is optional and should connect through an SSH tunnel to the database host. The MySQL container is intentionally not exposed on a public interface. Choose database `digitalbotsclients`.

## 6. Discord

The bot token is configured on the main server only. Enable the Server Members and Presence privileged intents in the Discord Developer Portal and give the bot only the permissions required for membership/presence and invite tracking. Invite attribution requires invite access, typically Manage Server permissions. The configured guild is `1569256802179354646`; invite is `https://discord.gg/cwAcrz7zeH`.

If no bot token is configured, the dashboard shows “Not configured” rather than invented metrics. Thirty-day growth requires snapshots spanning at least 30 days.

## 7. Backups

Back up the `digitalbots_mysql` volume or run `mysqldump` from inside the database container. Example:

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml exec -T database sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction digitalbotsclients' > digitalbotsclients-$(date +%F-%H%M).sql
```

Store backups off-host and test restores. Do not store backups in a public web directory.

## 8. Updates

Back up first, then update the code and rebuild:

```bash
npm run build:web
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build
```

Migrations are versioned and recorded in `_migrations`; they are applied on app container startup. Do not delete the Docker volume when updating.
