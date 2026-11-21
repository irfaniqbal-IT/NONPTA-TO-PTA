// Security helpers for the relay WebSocket port.
const crypto = require('crypto');

const MIN_TOKEN_LENGTH = 32;

/** Reads RELAY_AUTH_TOKEN and refuses to start with a missing/weak value. */
function loadAuthToken() {
  const token = (process.env.RELAY_AUTH_TOKEN || '').trim();
  if (!token || token.length < MIN_TOKEN_LENGTH || token.includes('your_')) {
    console.error(
      `[Security] RELAY_AUTH_TOKEN is missing or shorter than ${MIN_TOKEN_LENGTH} characters.\n` +
      '           Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
      '           and put the same value in relay/.env and in the app (Settings -> Relay Auth Token).'
    );
    process.exit(1);
  }
  return token;
}

/** Constant-time string comparison (prevents timing attacks on the token). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Extracts the bearer token from the HTTP upgrade request. */
function extractToken(req) {
  const header = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : '';
}

/**
 * Blocks an IP for a while after too many failed auth attempts
 * (stops brute-forcing the token over the open port).
 */
class FailedAuthLimiter {
  constructor({ maxFailures = 5, windowMs = 10 * 60 * 1000, blockMs = 30 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.blockMs = blockMs;
    this.entries = new Map(); // ip -> { count, first, blockedUntil }
    setInterval(() => this.cleanup(), 60 * 1000).unref();
  }

  isBlocked(ip) {
    const e = this.entries.get(ip);
    return !!(e && e.blockedUntil && e.blockedUntil > Date.now());
  }

  recordFailure(ip) {
    const now = Date.now();
    let e = this.entries.get(ip);
    if (!e || now - e.first > this.windowMs) e = { count: 0, first: now, blockedUntil: 0 };
    e.count += 1;
    if (e.count >= this.maxFailures) {
      e.blockedUntil = now + this.blockMs;
      console.warn(`[Security] Blocking ${ip} for ${this.blockMs / 60000} min after ${e.count} failed auth attempts`);
    }
    this.entries.set(ip, e);
  }

  recordSuccess(ip) {
    this.entries.delete(ip);
  }

  cleanup() {
    const now = Date.now();
    for (const [ip, e] of this.entries) {
      if ((!e.blockedUntil || e.blockedUntil < now) && now - e.first > this.windowMs) this.entries.delete(ip);
    }
  }
}

/** Simple per-connection message rate limiter (token bucket). */
class MessageRateLimiter {
  constructor(maxPerSecond = 10, burst = 20) {
    this.rate = maxPerSecond;
    this.capacity = burst;
    this.tokens = burst;
    this.last = Date.now();
  }

  allow() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const ALLOWED_EVENT_TYPES = new Set(['RINGING', 'MISSED', 'ANSWERED']);

/** Validates and sanitises a CALL_STATE payload coming from Phone A. Returns null if invalid. */
function validateCallPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { eventType, number, name, timestamp } = payload;
  if (!ALLOWED_EVENT_TYPES.has(eventType)) return null;
  if (typeof number !== 'string' || number.length > 40) return null;
  if (name != null && (typeof name !== 'string' || name.length > 100)) return null;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return {
    eventType,
    number: number.replace(/[^\d+*#\-() ]/g, '').slice(0, 40) || 'Unknown',
    name: (name || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100),
    timestamp: ts
  };
}

/** Escapes text for Telegram HTML parse_mode. */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Masks a phone number for logs: +923001234567 -> +92300*****67 */
function maskNumber(n) {
  const s = String(n || '');
  if (s.length <= 6) return '***';
  return s.slice(0, 6) + '*'.repeat(Math.max(0, s.length - 8)) + s.slice(-2);
}

/** Parses a comma-separated list of IDs from an env variable. */
function idList(value) {
  return new Set(String(value || '').split(',').map((s) => s.trim()).filter((s) => s && !s.includes('your_')));
}

module.exports = {
  loadAuthToken,
  safeEqual,
  extractToken,
  FailedAuthLimiter,
  MessageRateLimiter,
  validateCallPayload,
  escapeHtml,
  maskNumber,
  idList
};
