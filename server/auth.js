import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { DATA_DIR, get } from './db.js';

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(DATA_DIR, '.jwt_secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();
const COOKIE = 'te_token';

export function issueToken(res, req, user) {
  const token = jwt.sign({ uid: user.id }, SECRET, { expiresIn: '12h' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 12 * 3600e3, path: '/' });
}
export const clearToken = (res) => res.clearCookie(COOKIE, { path: '/' });

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function authenticate(req, _res, next) {
  const token = readCookie(req, COOKIE);
  if (token) {
    try {
      const { uid } = jwt.verify(token, SECRET);
      const u = get('SELECT id, email, name, role, team_id, active FROM users WHERE id = ?', uid);
      if (u && u.active) req.user = u;
    } catch { /* invalid or expired token: treated as anonymous */ }
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  next();
}
export const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(new HttpError(403, 'You do not have permission for this action'));

// Naive in-memory brute-force protection for the login endpoint.
const attempts = new Map();
export function loginThrottle(req, _res, next) {
  const key = req.ip;
  const now = Date.now();
  const rec = (attempts.get(key) || []).filter((t) => now - t < 15 * 60e3);
  if (rec.length >= 10) return next(new HttpError(429, 'Too many login attempts. Try again in 15 minutes.'));
  req.recordFailure = () => { rec.push(Date.now()); attempts.set(key, rec); };
  next();
}
