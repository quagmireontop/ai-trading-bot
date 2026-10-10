// Password login for the dashboard, plus token / secret-URL access for Claude.
// No extra dependencies: sessions are HMAC-signed cookies.
import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'tb_session';
const SESSION_DAYS = 30;
// Without SESSION_SECRET, sessions are signed with a key derived from the password,
// so changing the password logs everyone out.
const key = () => config.sessionSecret || crypto.createHash('sha256').update(`tb:${config.dashboardPassword}`).digest('hex');

export const loginEnabled = () => !!config.dashboardPassword;

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

const sign = (value) => crypto.createHmac('sha256', key()).update(value).digest('base64url');

function readCookie(req, name) {
  for (const part of (req.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function validSession(req) {
  const raw = readCookie(req, COOKIE);
  if (!raw) return false;
  const [expires, sig] = raw.split('.');
  return !!sig && safeEqual(sig, sign(expires)) && Number(expires) > Date.now();
}

function validToken(req) {
  if (!config.dashboardToken) return false;
  const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return !!given && safeEqual(given, config.dashboardToken);
}

// Is this request allowed to see the dashboard / API?
export function isAuthed(req) {
  if (!loginEnabled() && !config.dashboardToken) return true; // local use, nothing configured
  return validSession(req) || validToken(req);
}

export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Not logged in' });
}

// Pages: send people to the login screen instead of a JSON error.
export function requirePageAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.redirect('/login');
}

// Simple brute-force protection: 10 wrong passwords per IP per 15 minutes.
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.start > 15 * 60000) return false;
  return a.count >= 10;
}
function recordFailure(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || now - a.start > 15 * 60000) attempts.set(ip, { start: now, count: 1 });
  else a.count++;
}

export function handleLogin(req, res) {
  const ip = req.ip;
  if (!loginEnabled()) return res.redirect('/');
  if (tooMany(ip)) return res.redirect('/login?error=locked');
  if (!safeEqual(req.body?.password ?? '', config.dashboardPassword)) {
    recordFailure(ip);
    return res.redirect('/login?error=wrong');
  }
  attempts.delete(ip);
  const expires = String(Date.now() + SESSION_DAYS * 86400000);
  res.cookie(COOKIE, `${expires}.${sign(expires)}`, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 86400000, path: '/',
  });
  res.redirect('/');
}

export function handleLogout(req, res) {
  res.clearCookie(COOKIE, { path: '/' });
  res.redirect('/login');
}

// MCP access: Bearer token (Claude Code / custom clients) or /mcp/<MCP_SECRET> (claude.ai).
export function mcpAllowed(req) {
  if (req.params.secret !== undefined) return !!config.mcpSecret && safeEqual(req.params.secret, config.mcpSecret);
  if (!loginEnabled() && !config.dashboardToken && !config.mcpSecret) return true; // local use
  return validToken(req);
}
