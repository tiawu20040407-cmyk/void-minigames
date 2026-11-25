// 密码散列、会话、登录限流
'use strict';
const crypto = require('crypto');

function hash(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(plain), salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + key.toString('hex');
}

function verify(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [kind, saltHex, keyHex] = stored.split('$');
  if (kind !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(String(plain), Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(keyHex, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(key, want);
}

function token(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// 邀请码：去掉容易看错的字符，分组显示，如 VOID-K7PX-3QMA
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function inviteCode() {
  const pick = n => Array.from(crypto.randomBytes(n), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  return `VOID-${pick(4)}-${pick(4)}`;
}

function readablePassword() {
  const pick = n => Array.from(crypto.randomBytes(n), b => CODE_CHARS[b % CODE_CHARS.length]).join('').toLowerCase();
  return `${pick(4)}-${pick(4)}`;
}

// 登录限流：同一个 IP 或同一个账号名，10 分钟内失败 5 次，锁 15 分钟
const WINDOW = 10 * 60 * 1000;
const LOCK = 15 * 60 * 1000;
const MAX_FAIL = 5;
const fails = new Map(); // key -> {n, first, lockUntil}

function limited(keys) {
  const now = Date.now();
  for (const k of keys) {
    const f = fails.get(k);
    if (f && f.lockUntil > now) return Math.ceil((f.lockUntil - now) / 60000);
  }
  return 0;
}

function fail(keys) {
  const now = Date.now();
  for (const k of keys) {
    let f = fails.get(k);
    if (!f || now - f.first > WINDOW) f = { n: 0, first: now, lockUntil: 0 };
    f.n++;
    // 'kp' 是 KP 登录的全局计数，阈值放宽，避免陌生人故意输错把 KP 锁在外面
    if (f.n >= (k === 'kp' ? 20 : MAX_FAIL)) f.lockUntil = now + LOCK;
    fails.set(k, f);
  }
}

function succeed(keys) {
  for (const k of keys) fails.delete(k);
}

module.exports = { hash, verify, token, inviteCode, readablePassword, limited, fail, succeed };
