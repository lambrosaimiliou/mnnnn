'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(__dirname, '../../../.env') });
const express = require('express');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { createDiscordIntegration } = require('./discord-integration');

const PORT = Number(process.env.PORT || 6767);
const HOST = process.env.HOST || '127.0.0.1';
const DB_NAME = process.env.DB_NAME || 'digitalbotsclients';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const INITIAL_SETUP_KEY = process.env.INITIAL_SETUP_KEY || '';
const COOKIE_SECURE = String(process.env.COOKIE_SECURE).toLowerCase() === 'true';
const COOKIE_SAME_SITE = ['lax', 'strict', 'none'].includes(String(process.env.COOKIE_SAME_SITE).toLowerCase())
  ? String(process.env.COOKIE_SAME_SITE).toLowerCase() : 'lax';
const configuredIdle = Number(process.env.SESSION_IDLE_HOURS || 6);
const DEFAULT_IDLE_HOURS = Number.isFinite(configuredIdle) ? Math.min(10, Math.max(5, configuredIdle)) : 6;
const corsOrigins = new Set((process.env.CORS_ORIGINS || 'tauri://localhost,http://tauri.localhost').split(',').map((v) => v.trim()).filter(Boolean));
const isProduction = process.env.NODE_ENV === 'production';

if (!process.env.DB_HOST || !process.env.DB_USER || !SESSION_SECRET || SESSION_SECRET.length < 32 || /^(GENERATE|REPLACE|CHANGE|YOUR_)/i.test(SESSION_SECRET) || !INITIAL_SETUP_KEY || INITIAL_SETUP_KEY.length < 32 || /^(GENERATE|REPLACE|CHANGE|YOUR_)/i.test(INITIAL_SETUP_KEY)) {
  console.error('Configuration incomplete. Set DB_HOST, DB_USER, a SESSION_SECRET of at least 32 characters, and an INITIAL_SETUP_KEY of at least 32 characters in the server environment.');
  process.exit(1);
}
if (COOKIE_SAME_SITE === 'none' && !COOKIE_SECURE) {
  console.error('COOKIE_SAME_SITE=none requires COOKIE_SECURE=true.');
  process.exit(1);
}
if (isProduction && HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1' && !COOKIE_SECURE) {
  console.error('For network binding in production, COOKIE_SECURE=true is required. Put the app behind HTTPS.');
  process.exit(1);
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || '',
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 12,
  maxIdle: 6,
  idleTimeout: 60000,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'local',
  dateStrings: true,
  enableKeepAlive: true
});
const db = pool.promise();
const MySQLStore = MySQLStoreFactory(session);
const sessionStore = new MySQLStore({
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000,
  expiration: DEFAULT_IDLE_HOURS * 60 * 60 * 1000,
  createDatabaseTable: false,
  schema: { tableName: 'sessions', columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' } }
}, pool);

const app = express();
if (String(process.env.TRUST_PROXY).toLowerCase() === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  const origin = req.get('origin');
  const ownOrigin = origin && origin === `${req.protocol}://${req.get('host')}`;
  if (origin && !ownOrigin && !corsOrigins.has(origin)) return res.status(403).json({ error: 'This application origin is not allowed.' });
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '150kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(session({
  name: 'digitalbots.sid',
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: COOKIE_SAME_SITE,
    secure: COOKIE_SECURE,
    maxAge: DEFAULT_IDLE_HOURS * 60 * 60 * 1000
  }
}));

const discord = createDiscordIntegration({
  db,
  token: process.env.DISCORD_BOT_TOKEN || '',
  guildId: process.env.DISCORD_GUILD_ID || '1569256802179354646',
  webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  logger: console
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false });
const setupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });
const mutationLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function getIp(req) {
  let ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip.slice(0, 45);
}
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function csrfGuard(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    const allowed = corsOrigins.has(origin) || origin === `${req.protocol}://${req.get('host')}`;
    if (!allowed) return res.status(403).json({ error: 'Cross-origin request blocked.' });
  }
  if (!safeEqual(req.get('x-csrf-token'), req.session.csrfToken)) {
    return res.status(403).json({ error: 'Security token expired. Refresh and try again.' });
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Please sign in again.' });
  next();
}
function idParam(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error('Invalid record ID.'), { status: 400 });
  return id;
}
function cleanText(value, max, label, required = false) {
  const text = String(value ?? '').trim();
  if (required && !text) throw Object.assign(new Error(`${label} is required.`), { status: 400 });
  if (text.length > max) throw Object.assign(new Error(`${label} must be ${max} characters or fewer.`), { status: 400 });
  return text;
}
function money(value, label = 'Amount') {
  const text = String(value ?? '0').trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text)) throw Object.assign(new Error(`${label} must be a non-negative amount with up to two decimals.`), { status: 400 });
  return Number(text).toFixed(2);
}
function currency(value) {
  const valueUpper = String(value || 'EUR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(valueUpper)) throw Object.assign(new Error('Currency must be a 3-letter code.'), { status: 400 });
  return valueUpper;
}
function validInvite(value) {
  const invite = cleanText(value, 500, 'Discord invite');
  if (!invite) return '';
  let parsed;
  try { parsed = new URL(invite); } catch { throw Object.assign(new Error('Enter a valid Discord invite URL.'), { status: 400 }); }
  if (parsed.protocol !== 'https:' || !['discord.gg', 'www.discord.gg', 'discord.com', 'www.discord.com'].includes(parsed.hostname.toLowerCase())) {
    throw Object.assign(new Error('Invite must be an HTTPS Discord invite URL.'), { status: 400 });
  }
  return invite;
}
function parseDate(value, label, optional = false) {
  if (!value && optional) return null;
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw Object.assign(new Error(`${label} must be a valid date.`), { status: 400 });
  const date = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw Object.assign(new Error(`${label} is invalid.`), { status: 400 });
  return text;
}
function addDuration(start, duration, customEnd) {
  if (duration === 'Lifetime') return null;
  if (duration === 'Custom') return parseDate(customEnd, 'Custom expiration date');
  const [y, m, d] = start.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const monthAdd = { '1 Month': 1, '3 Months': 3, '6 Months': 6, '1 Year': 12 }[duration];
  if (!monthAdd) throw Object.assign(new Error('Choose a valid subscription duration.'), { status: 400 });
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + monthAdd);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(originalDay, lastDay));
  return date.toISOString().slice(0, 10);
}
async function logActivity(action, details, req = null) {
  await db.execute('INSERT INTO activity_logs (actor_id, actor, action, details) VALUES (?, ?, ?, ?)', [req?.session?.user?.id || null, req?.session?.user?.username || 'digitalbots', action, String(details || '').slice(0, 1500)]);
}
async function logLogin(username, ip, status, req, userId = null) {
  const [result] = await db.execute('INSERT INTO login_logs (user_id, username, ip_address, status, user_agent) VALUES (?, ?, ?, ?, ?)', [userId, cleanText(username || 'unknown', 64, 'Username'), ip, status, cleanText(req.get('user-agent') || '', 500, 'User agent')]);
  return result.insertId;
}
async function setting(key, fallback = '') {
  const [rows] = await db.execute('SELECT setting_value FROM application_settings WHERE setting_key = ? LIMIT 1', [key]);
  return rows[0]?.setting_value ?? fallback;
}
async function notify(title, message) {
  await db.execute('INSERT INTO notifications (channel, title, message) VALUES (?, ?, ?)', ['IN_APP', title, message]);
  await discord.notify(`**${title}**\n${message}`);
}
async function createClientRecord(body, req) {
  const discordName = cleanText(body.discordName, 120, 'Discord username', true);
  const discordId = cleanText(body.discordId, 32, 'Discord ID', true);
  if (!/^\d{5,25}$/.test(discordId)) throw Object.assign(new Error('Discord ID must contain 5–25 digits.'), { status: 400 });
  const irlName = cleanText(body.irlName, 160, 'IRL name', true);
  const invite = validInvite(body.discordInviteUrl);
  const notes = cleanText(body.notes, 4000, 'Notes');
  const plan = String(body.plan || 'Basic');
  const duration = String(body.duration || '1 Month');
  if (!['Basic', 'Premium', 'Business'].includes(plan)) throw Object.assign(new Error('Choose Basic, Premium or Business.'), { status: 400 });
  if (!['1 Month', '3 Months', '6 Months', '1 Year', 'Lifetime', 'Custom'].includes(duration)) throw Object.assign(new Error('Choose a valid subscription duration.'), { status: 400 });
  const startDate = parseDate(body.startDate || new Date().toISOString().slice(0, 10), 'Start date');
  const endDate = addDuration(startDate, duration, body.customEndDate);
  if (endDate && endDate < startDate) throw Object.assign(new Error('Expiration date must be on or after the start date.'), { status: 400 });
  const price = money(body.price ?? '0', 'Subscription price');
  const curr = currency(body.currency);
  const initialPaid = money(body.amountPaid ?? '0', 'Amount paid');
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [clientResult] = await conn.execute('INSERT INTO clients (discord_name, discord_id, discord_invite_url, irl_name, notes) VALUES (?, ?, ?, ?, ?)', [discordName, discordId, invite, irlName, notes || null]);
    const clientId = clientResult.insertId;
    const [subResult] = await conn.execute(
      `INSERT INTO subscriptions (client_id, plan, duration, started_at, expires_at, price, currency, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      [clientId, plan, duration, `${startDate} 00:00:00`, endDate ? `${endDate} 23:59:59` : null, price, curr, notes || null]
    );
    if (Number(initialPaid) > 0) {
      await conn.execute(
        `INSERT INTO payments (client_id, subscription_id, amount, currency, payment_date, method, status, description)
         VALUES (?, ?, ?, ?, NOW(), ?, 'PAID', ?)`,
        [clientId, subResult.insertId, initialPaid, curr, cleanText(body.paymentMethod || 'Other', 80, 'Payment method'), 'Initial payment']
      );
    }
    await conn.commit();
    await logActivity('CLIENT_CREATED', `Client #${clientId} created · ${plan} · ${duration}`, req);
    await notify('Client created', `${discordName} was added to the client register.`);
    return clientId;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally { conn.release(); }
}

app.get('/api/health', wrap(async (req, res) => {
  await db.query('SELECT 1');
  res.json({ ok: true, application: 'DigitalBots', status: 'online', database: 'connected', time: new Date().toISOString() });
}));
app.get('/api/csrf', (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = newToken();
  res.json({ token: req.session.csrfToken });
});
app.get('/api/setup/status', wrap(async (req, res) => {
  const [[row]] = await db.query('SELECT COUNT(*) AS total FROM users');
  res.json({ setupRequired: Number(row.total) === 0 });
}));
app.post('/api/setup', setupLimiter, csrfGuard, wrap(async (req, res) => {
  const [[row]] = await db.query('SELECT COUNT(*) AS total FROM users');
  if (Number(row.total) !== 0) return res.status(409).json({ error: 'Initial setup has already been completed.' });
  if (!safeEqual(req.body.setupKey, INITIAL_SETUP_KEY)) return res.status(403).json({ error: 'The one-time server setup key is incorrect.' });
  const username = String(req.body.username || 'digitalbots').trim();
  const password = String(req.body.password || '');
  if (username !== 'digitalbots') return res.status(400).json({ error: 'The initial administrator username must be digitalbots.' });
  if (password.length < 14 || password.length > 128) return res.status(400).json({ error: 'Choose a password between 14 and 128 characters.' });
  const hash = await bcrypt.hash(password, 12);
  const [result] = await db.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash]);
  const ip = getIp(req);
  await db.execute("INSERT INTO trusted_ips (ip_address, status, note) VALUES (?, 'TRUSTED', 'Initial administrator setup')", [ip]);
  await logActivity('INITIAL_SETUP', `Administrator ${username} configured`, req);
  await new Promise((resolve, reject) => req.session.regenerate((err) => err ? reject(err) : resolve()));
  req.session.user = { id: result.insertId, username };
  req.session.csrfToken = newToken();
  const hours = DEFAULT_IDLE_HOURS;
  req.session.cookie.maxAge = hours * 60 * 60 * 1000;
  await new Promise((resolve, reject) => req.session.save((err) => err ? reject(err) : resolve()));
  res.status(201).json({ ok: true, username, csrfToken: req.session.csrfToken, idleTimeoutHours: hours });
}));
app.post('/api/auth/login', loginLimiter, csrfGuard, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().slice(0, 64);
  const password = String(req.body.password || '');
  const ip = getIp(req);
  const [rows] = await db.execute('SELECT id, username, password_hash FROM users WHERE username = ? LIMIT 1', [username]);
  const user = rows[0];
  const passwordOk = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!passwordOk) {
    await logLogin(username || 'unknown', ip, 'REJECTED', req, user?.id || null);
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const [ipRows] = await db.execute('SELECT status FROM trusted_ips WHERE ip_address = ? LIMIT 1', [ip]);
  const status = ipRows[0]?.status || null;
  if (status === 'BLOCKED') {
    await logLogin(username, ip, 'REJECTED', req, user.id);
    return res.status(403).json({ error: 'This network address is blocked.' });
  }
  const [[trustedCount]] = await db.query('SELECT COUNT(*) AS total FROM trusted_ips');
  if (Number(trustedCount.total) === 0) {
    await db.execute("INSERT INTO trusted_ips (ip_address, status, note) VALUES (?, 'TRUSTED', 'First successful administrator login') ON DUPLICATE KEY UPDATE status = 'TRUSTED', last_seen = CURRENT_TIMESTAMP", [ip]);
  } else if (status !== 'TRUSTED') {
    await db.execute("INSERT INTO trusted_ips (ip_address, status, note) VALUES (?, 'PENDING', 'Waiting for administrator approval') ON DUPLICATE KEY UPDATE status = 'PENDING', last_seen = CURRENT_TIMESTAMP", [ip]);
    const logId = await logLogin(username, ip, 'PENDING', req, user.id);
    await notify('New login needs approval', `A valid login from ${ip} is waiting for approval. Request #${logId}.`);
    return res.status(202).json({ pending: true, message: 'This login is waiting for approval from an already trusted session.' });
  }
  const idleHours = Math.max(5, Math.min(10, Number(await setting('idle_timeout_hours', String(DEFAULT_IDLE_HOURS))) || DEFAULT_IDLE_HOURS));
  await new Promise((resolve, reject) => req.session.regenerate((err) => err ? reject(err) : resolve()));
  req.session.user = { id: user.id, username: user.username };
  req.session.csrfToken = newToken();
  req.session.cookie.maxAge = idleHours * 60 * 60 * 1000;
  await logLogin(username, ip, 'SUCCESS', req, user.id);
  await logActivity('LOGIN_SUCCESS', `Administrator signed in from ${ip}`, req);
  await new Promise((resolve, reject) => req.session.save((err) => err ? reject(err) : resolve()));
  res.json({ ok: true, username, csrfToken: req.session.csrfToken, idleTimeoutHours: idleHours });
}));
app.post('/api/auth/logout', csrfGuard, (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy((error) => {
    res.clearCookie('digitalbots.sid', { httpOnly: true, sameSite: COOKIE_SAME_SITE, secure: COOKIE_SECURE });
    if (error) return res.status(500).json({ error: 'Could not end the session.' });
    res.json({ ok: true });
  });
});
app.post('/api/auth/change-password', requireAuth, csrfGuard, wrap(async (req, res) => {
  const current = String(req.body.currentPassword || '');
  const next = String(req.body.newPassword || '');
  if (next.length < 14 || next.length > 128) return res.status(400).json({ error: 'New password must be 14–128 characters.' });
  const [[user]] = await db.execute('SELECT password_hash FROM users WHERE id = ?', [req.session.user.id]);
  if (!user || !(await bcrypt.compare(current, user.password_hash))) return res.status(400).json({ error: 'Current password is incorrect.' });
  const hash = await bcrypt.hash(next, 12);
  await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.session.user.id]);
  await logActivity('PASSWORD_CHANGED', 'Administrator password updated', req);
  res.json({ ok: true });
}));
app.get('/api/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, username: req.session.user.username, csrfToken: req.session.csrfToken });
});

app.get('/api/dashboard', requireAuth, wrap(async (req, res) => {
  const [[clients]] = await db.query(`SELECT COUNT(*) total,
    SUM(CASE WHEN s.expires_at IS NULL OR s.expires_at >= NOW() THEN 1 ELSE 0 END) active,
    SUM(CASE WHEN s.expires_at IS NOT NULL AND s.expires_at < NOW() THEN 1 ELSE 0 END) expired,
    SUM(CASE WHEN s.expires_at IS NOT NULL AND s.expires_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) expiring
    FROM clients c LEFT JOIN subscriptions s ON s.id = (SELECT s2.id FROM subscriptions s2 WHERE s2.client_id=c.id AND s2.status IN ('ACTIVE','EXPIRED') ORDER BY s2.started_at DESC, s2.id DESC LIMIT 1) WHERE c.deleted_at IS NULL`);
  const [revenueByCurrency] = await db.query(`SELECT currency,
    COALESCE(SUM(CASE WHEN status='PAID' THEN amount WHEN status='REFUNDED' THEN -amount ELSE 0 END),0) total,
    COALESCE(SUM(CASE WHEN status='PAID' AND payment_date >= DATE_FORMAT(NOW(), '%Y-%m-01') THEN amount WHEN status='REFUNDED' AND payment_date >= DATE_FORMAT(NOW(), '%Y-%m-01') THEN -amount ELSE 0 END),0) month,
    COALESCE(SUM(CASE WHEN status='PENDING' THEN amount ELSE 0 END),0) outstanding
    FROM payments GROUP BY currency ORDER BY currency`);
  const chartCurrency = currency(await setting('currency', 'EUR'));
  const [[newClients]] = await db.query("SELECT COUNT(*) total FROM clients WHERE created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')");
  const [[pendingLogins]] = await db.query("SELECT COUNT(*) total FROM login_logs WHERE status='PENDING'");
  const [recentClients] = await db.query(`SELECT c.id,c.discord_name,c.discord_id,c.irl_name,s.plan,s.duration,s.expires_at,
    COALESCE(p.paid,0) amount_paid, c.created_at,
    CASE WHEN s.id IS NULL THEN 'NO SUBSCRIPTION' WHEN s.expires_at IS NULL THEN 'LIFETIME' WHEN s.expires_at>=NOW() THEN 'ACTIVE' ELSE 'EXPIRED' END subscription_status
    FROM clients c LEFT JOIN subscriptions s ON s.id=(SELECT s2.id FROM subscriptions s2 WHERE s2.client_id=c.id ORDER BY s2.started_at DESC,s2.id DESC LIMIT 1)
    LEFT JOIN (SELECT client_id,currency,SUM(CASE WHEN status='PAID' THEN amount WHEN status='REFUNDED' THEN -amount ELSE 0 END) paid FROM payments GROUP BY client_id,currency) p ON p.client_id=c.id AND p.currency=s.currency
    WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT 7`);
  const [recentPayments] = await db.query(`SELECT p.id,p.amount,p.currency,p.method,p.status,p.payment_date,c.discord_name FROM payments p JOIN clients c ON c.id=p.client_id ORDER BY p.payment_date DESC,p.id DESC LIMIT 5`);
  const [planStats] = await db.query(`SELECT plan, COUNT(*) total FROM subscriptions WHERE status='ACTIVE' AND (expires_at IS NULL OR expires_at >= NOW()) GROUP BY plan`);
  const [monthly] = await db.query(`SELECT DATE_FORMAT(payment_date,'%b %Y') label, DATE_FORMAT(payment_date,'%Y-%m') period,
    SUM(CASE WHEN status='PAID' THEN amount WHEN status='REFUNDED' THEN -amount ELSE 0 END) amount
    FROM payments WHERE currency=? AND payment_date >= DATE_SUB(DATE_FORMAT(NOW(),'%Y-%m-01'), INTERVAL 5 MONTH) AND status IN ('PAID','REFUNDED')
    GROUP BY period,label ORDER BY period`, [chartCurrency]);
  const discordStats = await discord.getStats();
  res.json({
    totalClients: Number(clients.total || 0), activeClients: Number(clients.active || 0), expiredSubscriptions: Number(clients.expired || 0), expiringSoon: Number(clients.expiring || 0),
    revenueByCurrency, chartCurrency, newClientsThisMonth: Number(newClients.total || 0),
    pendingLogins: Number(pendingLogins.total || 0), recentClients, recentPayments, monthlyRevenue: monthly, planStats, discord: discordStats
  });
}));

app.get('/api/clients', requireAuth, wrap(async (req, res) => {
  const search = String(req.query.search || '').trim().slice(0, 100);
  const plan = String(req.query.plan || '');
  const status = String(req.query.status || '');
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 25)));
  const conditions = ['c.deleted_at IS NULL'];
  const params = [];
  if (search) { conditions.push('(c.discord_name LIKE ? OR c.discord_id LIKE ? OR c.irl_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (plan && ['Basic','Premium','Business'].includes(plan)) { conditions.push('s.plan = ?'); params.push(plan); }
  if (status === 'ACTIVE') conditions.push('(s.expires_at IS NULL OR s.expires_at >= NOW())');
  if (status === 'EXPIRED') conditions.push('(s.expires_at IS NOT NULL AND s.expires_at < NOW())');
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const base = `FROM clients c LEFT JOIN subscriptions s ON s.id=(SELECT s2.id FROM subscriptions s2 WHERE s2.client_id=c.id ORDER BY s2.started_at DESC,s2.id DESC LIMIT 1)
    LEFT JOIN (SELECT client_id,currency,SUM(CASE WHEN status='PAID' THEN amount WHEN status='REFUNDED' THEN -amount ELSE 0 END) paid FROM payments GROUP BY client_id,currency) p ON p.client_id=c.id AND p.currency=s.currency ${where}`;
  const [[count]] = await db.execute(`SELECT COUNT(*) total ${base}`, params);
  const [rows] = await db.execute(`SELECT c.id,c.discord_name,c.discord_id,c.discord_invite_url,c.irl_name,c.notes,c.created_at,c.updated_at,
    s.id subscription_id,s.plan,s.duration,s.started_at,s.expires_at,s.price,s.currency,s.status subscription_state,COALESCE(p.paid,0) amount_paid,
    CASE WHEN s.id IS NULL THEN 'NONE' WHEN s.expires_at IS NULL THEN 'LIFETIME' WHEN s.expires_at>=NOW() THEN 'ACTIVE' ELSE 'EXPIRED' END subscription_status
    ${base} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  res.json({ rows, page, pageSize, total: Number(count.total), pages: Math.max(1, Math.ceil(Number(count.total) / pageSize)) });
}));
app.post('/api/clients', requireAuth, csrfGuard, mutationLimiter, wrap(async (req, res) => {
  const id = await createClientRecord(req.body, req);
  res.status(201).json({ ok: true, id });
}));
app.put('/api/clients/:id', requireAuth, csrfGuard, mutationLimiter, wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const discordName = cleanText(req.body.discordName, 120, 'Discord username', true);
  const discordId = cleanText(req.body.discordId, 32, 'Discord ID', true);
  if (!/^\d{5,25}$/.test(discordId)) throw Object.assign(new Error('Discord ID must contain 5–25 digits.'), { status: 400 });
  const irlName = cleanText(req.body.irlName, 160, 'IRL name', true);
  const invite = validInvite(req.body.discordInviteUrl);
  const notes = cleanText(req.body.notes, 4000, 'Notes');
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute('UPDATE clients SET discord_name=?,discord_id=?,discord_invite_url=?,irl_name=?,notes=? WHERE id=? AND deleted_at IS NULL', [discordName, discordId, invite, irlName, notes || null, id]);
    if (!result.affectedRows) { await conn.rollback(); return res.status(404).json({ error: 'Client not found.' }); }
    if (req.body.updateSubscription === true) {
      const plan = String(req.body.plan); const duration = String(req.body.duration);
      if (!['Basic','Premium','Business'].includes(plan) || !['1 Month','3 Months','6 Months','1 Year','Lifetime','Custom'].includes(duration)) throw Object.assign(new Error('Invalid subscription plan or duration.'), { status: 400 });
      const startDate = parseDate(req.body.startDate || new Date().toISOString().slice(0,10), 'Start date');
      const endDate = addDuration(startDate, duration, req.body.customEndDate);
      if (endDate && endDate < startDate) throw Object.assign(new Error('Expiration date must be on or after the start date.'), { status: 400 });
      const price = money(req.body.price ?? '0', 'Subscription price');
      const curr = currency(req.body.currency);
      const [[current]] = await conn.execute("SELECT id FROM subscriptions WHERE client_id=? AND status IN ('ACTIVE','EXPIRED') ORDER BY started_at DESC,id DESC LIMIT 1", [id]);
      if (current) await conn.execute("UPDATE subscriptions SET status='SUPERSEDED' WHERE id=?", [current.id]);
      const [sub] = await conn.execute("INSERT INTO subscriptions (client_id,plan,duration,started_at,expires_at,price,currency,status,notes) VALUES (?,?,?,?,?,?,?,'ACTIVE',?)", [id,plan,duration,`${startDate} 00:00:00`,endDate ? `${endDate} 23:59:59` : null,price,curr,notes || null]);
      const initialPaid = money(req.body.amountPaid ?? '0', 'Amount paid');
      if (Number(initialPaid) > 0) await conn.execute("INSERT INTO payments (client_id,subscription_id,amount,currency,payment_date,method,status,description) VALUES (?,?,?, ?,NOW(),?,'PAID','Subscription adjustment payment')", [id,sub.insertId,initialPaid,curr,cleanText(req.body.paymentMethod || 'Other',80,'Payment method')]);
    }
    await conn.commit();
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
  await logActivity('CLIENT_UPDATED', `Client #${id} updated`, req);
  res.json({ ok: true });
}));
app.delete('/api/clients/:id', requireAuth, csrfGuard, mutationLimiter, wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const [result] = await db.execute('UPDATE clients SET deleted_at=NOW() WHERE id=? AND deleted_at IS NULL', [id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Client not found.' });
  await logActivity('CLIENT_ARCHIVED', `Client #${id} archived; payment and subscription history retained`, req);
  res.json({ ok: true });
}));
app.post('/api/clients/:id/payments', requireAuth, csrfGuard, mutationLimiter, wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const amount = money(req.body.amount, 'Payment amount');
  if (Number(amount) <= 0) throw Object.assign(new Error('Payment amount must be greater than zero.'), { status: 400 });
  const [[client]] = await db.execute('SELECT id FROM clients WHERE id=? AND deleted_at IS NULL', [id]);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  const paymentDate = String(req.body.paymentDate || new Date().toISOString().slice(0,10));
  parseDate(paymentDate, 'Payment date');
  const status = ['PAID','PENDING','REFUNDED'].includes(req.body.status) ? req.body.status : 'PAID';
  const [result] = await db.execute('INSERT INTO payments (client_id,amount,currency,payment_date,method,status,description) VALUES (?,?,?,?,?,?,?)', [id,amount,currency(req.body.currency),`${paymentDate} 12:00:00`,cleanText(req.body.method || 'Other',80,'Payment method'),status,cleanText(req.body.description || '',500,'Description')]);
  await logActivity('PAYMENT_RECORDED', `Payment #${result.insertId} recorded for client #${id} (${amount} ${currency(req.body.currency)})`, req);
  if (status === 'PAID') await notify('Payment recorded', `${amount} ${currency(req.body.currency)} was recorded for client #${id}.`);
  res.status(201).json({ ok: true, id: result.insertId });
}));

app.get('/api/subscriptions', requireAuth, wrap(async (req,res)=>{
  const [rows] = await db.query(`SELECT s.*,c.discord_name,c.discord_id,c.irl_name,
    CASE WHEN s.status='CANCELLED' THEN 'CANCELLED' WHEN s.status='SUPERSEDED' THEN 'SUPERSEDED' WHEN s.expires_at IS NULL THEN 'LIFETIME' WHEN s.expires_at>=NOW() THEN 'ACTIVE' ELSE 'EXPIRED' END display_status
    FROM subscriptions s JOIN clients c ON c.id=s.client_id ORDER BY s.created_at DESC LIMIT 500`);
  res.json(rows);
}));
app.post('/api/subscriptions/:id/extend', requireAuth, csrfGuard, wrap(async (req,res)=>{
  const id = idParam(req.params.id);
  const conn = await db.getConnection();
  let newId;
  try {
    await conn.beginTransaction();
    const [[old]] = await conn.execute('SELECT * FROM subscriptions WHERE id=? FOR UPDATE',[id]);
    if(!old){ await conn.rollback(); return res.status(404).json({error:'Subscription not found.'}); }
    const plan = String(req.body.plan || old.plan);
    if(!['Basic','Premium','Business'].includes(plan)) throw Object.assign(new Error('Invalid subscription plan.'),{status:400});
    const duration = String(req.body.duration || old.duration);
    if(!['1 Month','3 Months','6 Months','1 Year','Lifetime','Custom'].includes(duration)) throw Object.assign(new Error('Invalid extension duration.'),{status:400});
    const baseDate = old.expires_at && new Date(old.expires_at).getTime() > Date.now() ? String(old.expires_at).slice(0,10) : new Date().toISOString().slice(0,10);
    let start = String(req.body.startDate || baseDate);
    parseDate(start,'Start date');
    const end = addDuration(start,duration,req.body.customEndDate);
    if (end && end < start) throw Object.assign(new Error('Expiration date must be on or after the start date.'), { status: 400 });
    await conn.execute("UPDATE subscriptions SET status='SUPERSEDED' WHERE id=?",[id]);
    const [result] = await conn.execute("INSERT INTO subscriptions (client_id,plan,duration,started_at,expires_at,price,currency,status,notes) VALUES (?,?,?,?,?,?,?,'ACTIVE',?)",[old.client_id,plan,duration,`${start} 00:00:00`,end?`${end} 23:59:59`:null,money(req.body.price ?? old.price,'Price'),currency(req.body.currency || old.currency),cleanText(req.body.notes || old.notes || '',1000,'Notes')]);
    newId = result.insertId;
    await conn.commit();
  } catch(error){await conn.rollback();throw error;} finally{conn.release();}
  await logActivity('SUBSCRIPTION_EXTENDED',`Subscription #${id} extended as #${newId}`,req);
  res.status(201).json({ok:true,id:newId});
}));
app.get('/api/payments', requireAuth, wrap(async (req,res)=>{
  const [rows] = await db.query(`SELECT p.*,c.discord_name,c.discord_id FROM payments p JOIN clients c ON c.id=p.client_id ORDER BY p.payment_date DESC,p.id DESC LIMIT 500`);
  res.json(rows);
}));
app.post('/api/payments', requireAuth, csrfGuard, mutationLimiter, wrap(async (req,res)=>{
  const clientId=idParam(req.body.clientId); const amount=money(req.body.amount,'Payment amount');
  if(Number(amount)<=0) throw Object.assign(new Error('Payment amount must be greater than zero.'),{status:400});
  const date=String(req.body.paymentDate || new Date().toISOString().slice(0,10)); parseDate(date,'Payment date');
  const status=['PAID','PENDING','REFUNDED'].includes(req.body.status)?req.body.status:'PAID';
  const [[client]]=await db.execute('SELECT id FROM clients WHERE id=? AND deleted_at IS NULL',[clientId]); if(!client) return res.status(404).json({error:'Client not found.'});
  const [result]=await db.execute('INSERT INTO payments (client_id,amount,currency,payment_date,method,status,description) VALUES (?,?,?,?,?,?,?)',[clientId,amount,currency(req.body.currency),`${date} 12:00:00`,cleanText(req.body.method||'Other',80,'Payment method'),status,cleanText(req.body.description||'',500,'Description')]);
  await logActivity('PAYMENT_RECORDED',`Payment #${result.insertId} recorded for client #${clientId}`,req);
  res.status(201).json({ok:true,id:result.insertId});
}));
app.get('/api/security', requireAuth, wrap(async(req,res)=>{
  const [pending]=await db.query("SELECT id,username,ip_address,status,user_agent,attempted_at FROM login_logs WHERE status='PENDING' ORDER BY attempted_at DESC LIMIT 100");
  const [trusted]=await db.query("SELECT id,ip_address,status,note,first_seen,last_seen,updated_at FROM trusted_ips WHERE status IN ('TRUSTED','BLOCKED') ORDER BY updated_at DESC LIMIT 200");
  const [logs]=await db.query('SELECT id,username,ip_address,status,user_agent,attempted_at,decided_at FROM login_logs ORDER BY attempted_at DESC LIMIT 150');
  res.json({pending,trusted,logs});
}));
app.post('/api/security/:id/approve', requireAuth, csrfGuard, wrap(async(req,res)=>{
  const id=idParam(req.params.id);
  const [[log]]=await db.execute("SELECT id,ip_address,status FROM login_logs WHERE id=?",[id]);
  if(!log || log.status!=='PENDING') return res.status(404).json({error:'Pending login request not found.'});
  await db.execute("INSERT INTO trusted_ips (ip_address,status,note,created_by) VALUES (?,'TRUSTED','Approved by administrator',?) ON DUPLICATE KEY UPDATE status='TRUSTED',note='Approved by administrator',last_seen=CURRENT_TIMESTAMP,created_by=VALUES(created_by)",[log.ip_address,req.session.user.id]);
  await db.execute("UPDATE login_logs SET status='APPROVED',decided_by=?,decided_at=NOW() WHERE ip_address=? AND status='PENDING'",[req.session.user.id,log.ip_address]);
  await logActivity('IP_APPROVED',`Approved IP ${log.ip_address}`,req);
  res.json({ok:true});
}));
app.post('/api/security/:id/reject', requireAuth, csrfGuard, wrap(async(req,res)=>{
  const id=idParam(req.params.id);
  const [[log]]=await db.execute("SELECT id,ip_address,status FROM login_logs WHERE id=?",[id]);
  if(!log || log.status!=='PENDING') return res.status(404).json({error:'Pending login request not found.'});
  await db.execute("INSERT INTO trusted_ips (ip_address,status,note,created_by) VALUES (?,'BLOCKED','Rejected by administrator',?) ON DUPLICATE KEY UPDATE status='BLOCKED',note='Rejected by administrator',created_by=VALUES(created_by)",[log.ip_address,req.session.user.id]);
  await db.execute("UPDATE login_logs SET status='REJECTED',decided_by=?,decided_at=NOW() WHERE ip_address=? AND status='PENDING'",[req.session.user.id,log.ip_address]);
  await logActivity('IP_REJECTED',`Rejected and blocked IP ${log.ip_address}`,req);
  res.json({ok:true});
}));
app.delete('/api/security/trusted/:id', requireAuth, csrfGuard, wrap(async(req,res)=>{
  const id=idParam(req.params.id);
  const [result]=await db.execute("UPDATE trusted_ips SET status='PENDING',note='Trust revoked; re-approval required' WHERE id=? AND status='TRUSTED'",[id]);
  if(!result.affectedRows) return res.status(404).json({error:'Trusted address not found.'});
  await logActivity('TRUSTED_IP_REVOKED',`Revoked trusted IP record #${id}; future login requires approval`,req);
  res.json({ok:true});
}));
app.get('/api/activity', requireAuth, wrap(async(req,res)=>{
  const [rows]=await db.query('SELECT id,actor,action,details,created_at FROM activity_logs ORDER BY created_at DESC LIMIT 300');res.json(rows);
}));
app.get('/api/discord/stats', requireAuth, wrap(async(req,res)=>res.json(await discord.getStats())));
app.post('/api/discord/test', requireAuth, csrfGuard, wrap(async(req,res)=>{
  const stats=await discord.getStats();
  if(!stats.configured) return res.status(400).json({error:'Discord bot token is not configured on the main server.'});
  res.json({ok:true,stats});
}));
app.get('/api/settings', requireAuth, wrap(async(req,res)=>{
  const [rows]=await db.query('SELECT setting_key,setting_value FROM application_settings');
  const values=Object.fromEntries(rows.map(r=>[r.setting_key,r.setting_value]));
  res.json({settings:{idleTimeoutHours:Number(values.idle_timeout_hours||6),currency:values.currency||'EUR',basicPrice:values.basic_price||'0.00',premiumPrice:values.premium_price||'0.00',businessPrice:values.business_price||'0.00',discordGuildId:values.discord_guild_id||'1569256802179354646',discordInviteUrl:values.discord_invite_url||'https://discord.gg/cwAcrz7zeH'},server:{host:HOST,port:PORT,secure:COOKIE_SECURE,proxy:!!app.get('trust proxy')},discord:await discord.getStats()});
}));
app.patch('/api/settings', requireAuth, csrfGuard, wrap(async(req,res)=>{
  const changes=req.body||{};
  const allowed={idleTimeoutHours:'idle_timeout_hours',currency:'currency',basicPrice:'basic_price',premiumPrice:'premium_price',businessPrice:'business_price'};
  const values=[];
  if(changes.idleTimeoutHours!==undefined){const h=Number(changes.idleTimeoutHours);if(!Number.isInteger(h)||h<5||h>10) throw Object.assign(new Error('Idle timeout must be between 5 and 10 hours.'),{status:400});values.push(['idle_timeout_hours',String(h)]);}
  if(changes.currency!==undefined) values.push(['currency',currency(changes.currency)]);
  for(const [field,key] of [['basicPrice','basic_price'],['premiumPrice','premium_price'],['businessPrice','business_price']]) if(changes[field]!==undefined) values.push([key,money(changes[field],field)]);
  for(const [key,value] of values) await db.execute('INSERT INTO application_settings (setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',[key,value]);
  await logActivity('SETTINGS_UPDATED',`Updated settings: ${values.map(v=>v[0]).join(', ')}`,req);
  res.json({ok:true});
}));
app.get('/api/reports/clients.csv', requireAuth, wrap(async(req,res)=>{
  const [rows]=await db.query(`SELECT c.discord_name,c.discord_id,c.irl_name,s.plan,s.duration,s.started_at,s.expires_at,COALESCE(p.paid,0) amount_paid FROM clients c LEFT JOIN subscriptions s ON s.id=(SELECT s2.id FROM subscriptions s2 WHERE s2.client_id=c.id ORDER BY s2.started_at DESC,s2.id DESC LIMIT 1) LEFT JOIN (SELECT client_id,currency,SUM(CASE WHEN status='PAID' THEN amount WHEN status='REFUNDED' THEN -amount ELSE 0 END) paid FROM payments GROUP BY client_id,currency) p ON p.client_id=c.id AND p.currency=s.currency WHERE c.deleted_at IS NULL ORDER BY c.created_at DESC`);
  const csvLine=(arr)=>arr.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',');
  res.type('text/csv').attachment('digitalbots-clients.csv').send([csvLine(Object.keys(rows[0]||{discord_name:'Discord Name',discord_id:'Discord ID',irl_name:'IRL Name',plan:'Plan',duration:'Duration',started_at:'Start Date',expires_at:'Expiration Date',amount_paid:'Amount Paid'})),...rows.map(r=>csvLine(Object.values(r)))].join('\r\n'));
}));
app.get('/api/reports/payments.csv', requireAuth, wrap(async(req,res)=>{
  const [rows]=await db.query('SELECT p.id,c.discord_name,p.amount,p.currency,p.payment_date,p.method,p.status,p.description FROM payments p JOIN clients c ON c.id=p.client_id ORDER BY p.payment_date DESC');
  const headers=['id','discord_name','amount','currency','payment_date','method','status','description'];
  const csvLine=(arr)=>arr.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',');
  res.type('text/csv').attachment('digitalbots-payments.csv').send([csvLine(headers),...rows.map(r=>csvLine(headers.map(h=>r[h])))].join('\r\n'));
}));

app.use(express.static(path.join(__dirname, '../public'), { maxAge: isProduction ? '1h' : 0, etag: true }));
app.get('/', (req,res)=>res.redirect('/desktop6767'));
app.get(['/desktop6767','/onlineconnectpc6742'],(req,res)=>res.sendFile(path.join(__dirname,'../public','index.html')));
app.use('/api',(req,res)=>res.status(404).json({error:'API endpoint not found.'}));
app.use((error,req,res,next)=>{
  if(res.headersSent) return next(error);
  if(error.message?.includes('CORS')) return res.status(403).json({error:'This application origin is not allowed.'});
  console.error('[DigitalBots request error]',error);
  const status=error.status||500;
  res.status(status).json({error:status>=500?'An internal server error occurred. Check server logs.':error.message});
});

async function shutdown(){
  console.log('\nStopping DigitalBots...');
  try{await discord.close();}catch(e){console.warn(e.message);}
  if(typeof sessionStore.close==='function') sessionStore.close();
  pool.end(()=>process.exit(0));
  setTimeout(()=>process.exit(1),5000).unref();
}
async function start(){
  await db.query('SELECT 1');
  const [[row]]=await db.query('SELECT COUNT(*) total FROM users');
  app.listen(PORT,HOST,()=>{
    console.log(`DigitalBots API and web app listening at http://${HOST}:${PORT}`);
    console.log(`Initial setup: ${Number(row.total)===0?'required at /':'already completed'}`);
    console.log(`Database: ${DB_NAME}`);
    console.log(`IP trust: enabled · Session idle timeout default: ${DEFAULT_IDLE_HOURS} hours`);
  });
}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
start().catch(error=>{console.error('\nDigitalBots server failed to start:',error.message);console.error('Check .env, database connectivity and run npm run db:migrate.');process.exit(1);});
