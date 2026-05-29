const crypto = require('node:crypto');

const PASSWORD_HASH_PREFIX = 'scrypt';
const SESSION_COOKIE_NAME = 'aionui_portal_session';

function base64UrlEncode(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = crypto.scryptSync(String(password), salt, 64).toString('base64url');
  return `${PASSWORD_HASH_PREFIX}$${salt}$${key}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const [prefix, salt, expected] = storedHash.split('$');
  if (prefix !== PASSWORD_HASH_PREFIX || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expectedBuffer = Buffer.from(expected, 'base64url');
  if (actual.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actual, expectedBuffer);
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function buildSessionCookie(token, maxAgeSeconds) {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].join('; ');
}

function signPortalTicket(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

module.exports = {
  SESSION_COOKIE_NAME,
  buildSessionCookie,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  parseCookies,
  signPortalTicket,
  verifyPassword,
};
