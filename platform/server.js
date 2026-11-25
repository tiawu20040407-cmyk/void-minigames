// VOID 平台后端。不依赖第三方包，Node 18 以上即可运行：
//   node platform/server.js
// 环境变量：PORT（默认 3100）、KP_NAME（默认 咕咕）、VOID_DATA_DIR（默认 platform/data）
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const DB = require('./lib/db');
const A = require('./lib/auth');
const E = require('./lib/entries');
const EV = require('./lib/events');

const PORT = Number(process.env.PORT) || 3100;
const KP_NAME = process.env.KP_NAME || '咕咕';
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const GAMES_DIR = path.join(ROOT, 'games');
const STARTED = Date.now();

const PLAYER_SESSION = 14 * 24 * 3600 * 1000;
const KP_SESSION = 12 * 3600 * 1000;
const GAME_GRACE = 3 * 3600 * 1000; // 入口关闭后，已经打开的游戏页面还能继续加载素材的时间（保证这一局打完）

const HO_INFO = {
  HO1: { kind: '人类' },
  HO2: { kind: '新型仿生人' },
  HO3: { kind: '人类' },
  HO4: { kind: '旧型仿生人' },
};
const SHEET_FIELDS = [
  // key, 名称, 最小, 最大
  ['dex', 'DEX', 1, 200],
  ['hp', 'HP 上限', 1, 99],
  ['comp', '计算机使用', 0, 200],
  ['hack', '艺术（黑客）', 0, 200],
  ['spot', '侦查', 0, 200],
  ['mech', '机械维修', 0, 200],
  ['lock', '开锁', 0, 200],
  ['idea', '灵感', 0, 200],
];
const STATES = ['hidden', 'locked', 'open'];

// ---------- 启动 ----------
const db = DB.load();
db.presets = db.presets || [];   // {id, name, states: {uid: {entryId: state}}, createdAt, updatedAt}
db.messages = db.messages || []; // {id, to: [uid], title, body, t, readBy: {uid: t}}
E.sync(db, GAMES_DIR);
DB.save();
// 每分钟重新扫描 games/，git pull 加进来的新游戏不用重启就会出现在控制台
setInterval(() => { if (E.sync(db, GAMES_DIR)) { DB.save(); notifyKp(); } }, 60 * 1000).unref();

const gameOpened = new Map(); // `${uid}:${entryId}` -> 最近一次打开游戏页面的时间

let setupCode = null;
function kpUser() { return db.users.find(u => u.role === 'kp'); }
if (!kpUser()) {
  setupCode = A.inviteCode().replace('VOID', 'SETUP');
  console.log('==================================================');
  console.log('[VOID] 还没有 KP 账号。KP 初始化码：' + setupCode);
  console.log('[VOID] 打开 /kp/setup 输入这个码，设置密码和密令。');
  console.log('==================================================');
}
DB.backup();
setInterval(DB.backup, 3600 * 1000).unref();

EV.setPresenceHandler(() => notifyKp('presence'));

// ---------- 推送 ----------
function kpIds() { return db.users.filter(u => u.role === 'kp').map(u => u.id); }
function notifyKp(what = 'state') { EV.sendMany(kpIds(), 'state', { what }); }
function notifyUser(uid, what = 'refresh') { EV.send(uid, 'refresh', { what }); notifyKp(); }
function notifyAllPlayers(what) { for (const u of db.users) if (u.role === 'player') EV.send(u.id, 'refresh', { what }); notifyKp(); }

// ---------- 小工具 ----------
function now() { return Date.now(); }

function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
}

function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return out;
}

function setCookie(req, res, value, maxAgeMs) {
  const parts = [`void_sid=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': type,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  }, extra));
  res.end(data);
}
const ok = (res, body = { ok: true }) => send(res, 200, body);
const err = (res, status, msg) => send(res, status, { ok: false, error: msg });

function notFound(res) {
  send(res, 404, '<!doctype html><meta charset="utf-8"><title>404</title><body style="background:#0b0d10;color:#8a96a3;font-family:monospace;padding:40px">404 NOT FOUND</body>', 'text/html; charset=utf-8');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 64 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function currentUser(req) {
  const sid = parseCookies(req).void_sid;
  if (!sid) return null;
  const s = db.sessions[sid];
  if (!s) return null;
  if (s.exp < now()) { delete db.sessions[sid]; return null; }
  const u = db.users.find(x => x.id === s.uid);
  return u ? { user: u, sid } : null;
}

function startSession(req, res, user) {
  for (const [k, s] of Object.entries(db.sessions)) if (s.exp < now()) delete db.sessions[k];
  const sid = A.token();
  const ttl = user.role === 'kp' ? KP_SESSION : PLAYER_SESSION;
  db.sessions[sid] = { uid: user.id, exp: now() + ttl };
  DB.save();
  setCookie(req, res, sid, ttl);
}

function endSessionsOf(uid) {
  for (const [k, s] of Object.entries(db.sessions)) if (s.uid === uid) delete db.sessions[k];
  EV.send(uid, 'logout', {}); // 页面收到后立刻回到登录页
  EV.drop(uid);
}

function logLogin(req, username, kind, okFlag) {
  db.loginLog.push({ t: now(), ip: clientIp(req), username: String(username).slice(0, 40), kind, ok: okFlag });
  if (db.loginLog.length > 300) db.loginLog.splice(0, db.loginLog.length - 300);
  DB.save();
}

function cleanUsername(s) {
  s = String(s || '').trim();
  if (s.length < 2 || s.length > 20) return null;
  if (!/^[\p{L}\p{N}_\-]+$/u.test(s)) return null;
  return s;
}
function findUser(name) {
  const n = String(name || '').trim().toLowerCase();
  return db.users.find(u => u.username.toLowerCase() === n);
}
function findPlayer(id) { return db.users.find(x => x.id === Number(id) && x.role === 'player'); }

function cleanText(v, max, label, required = true) {
  const t = String(v ?? '').trim();
  if (required && !t) throw new Error(`请填写${label}`);
  if (t.length > max) throw new Error(`${label}最多 ${max} 个字`);
  return t;
}

function cleanSheet(input, base = {}) {
  const s = Object.assign({}, base);
  const name = String((input && input.name) || '').trim();
  if (!name || name.length > 30) throw new Error('角色姓名需要 1–30 个字');
  s.name = name;
  for (const [k, label, min, max] of SHEET_FIELDS) {
    const v = Number(input[k]);
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${label} 需要是 ${min}–${max} 的整数`);
    s[k] = v;
  }
  return s;
}

function publicUser(u, forKp = false) {
  const out = {
    id: u.id, username: u.username, role: u.role, ho: u.ho, kind: u.kind,
    status: u.status, test: !!u.test, sheet: u.sheet, hpNow: u.hpNow,
  };
  if (forKp) out.createdAt = u.createdAt;
  return out;
}

function entryState(uid, id) {
  return (db.unlocks[uid] && db.unlocks[uid][id]) || 'hidden';
}

function entryList() { return E.list(db); }

// 能否打开游戏页面本身
function canOpen(user, entry) {
  if (!user) return false;
  if (user.role === 'kp') return true;
  return user.status === 'approved' && entryState(user.id, entry.id) === 'open';
}
// 能否加载游戏的素材：能打开页面，或者最近 3 小时内打开过页面（入口关闭后让这一局打完）
function canLoadAsset(user, entry) {
  if (canOpen(user, entry)) return true;
  if (!user || user.status !== 'approved') return false;
  const t = gameOpened.get(`${user.id}:${entry.id}`);
  return !!t && now() - t < GAME_GRACE;
}

// 预览：KP 可以带 ?as=玩家id 查看玩家视角
function viewer(req, url) {
  const cu = currentUser(req);
  if (!cu) return null;
  const as = url.searchParams.get('as');
  if (as && cu.user.role === 'kp') {
    const p = findPlayer(as);
    return p ? { user: p, preview: true } : null;
  }
  return { user: cu.user, preview: false };
}

function messagesFor(uid) {
  return db.messages.filter(m => m.to.includes(uid)).map(m => ({
    id: m.id, title: m.title, body: m.body, t: m.t, read: !!m.readBy[uid],
  })).reverse();
}

function newId(prefix) { return prefix + now().toString(36) + A.token(3); }

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  if (p !== base && !p.startsWith(base + path.sep)) return null;
  return p;
}

function serveFile(req, res, file, cache, onServed) {
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) return notFound(res);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff', 'Last-Modified': st.mtime.toUTCString(),
    };
    if (onServed) onServed();
    if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(st.mtime.toUTCString())) {
      res.writeHead(304, headers); return res.end();
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const PAGES = {
  '/': 'index.html',
  '/register': 'register.html',
  '/intranet': 'intranet.html',
  '/terminal': 'terminal.html',
  '/kp': 'kp.html',
  '/kp/login': 'kp-login.html',
  '/kp/setup': 'kp-setup.html',
};

// ---------- API ----------
const routes = {};
function route(method, p, fn) { routes[method + ' ' + p] = fn; }

route('GET', '/api/health', (req, res) => ok(res, { ok: true }));

route('GET', '/api/me', (req, res, body, url) => {
  const v = viewer(req, url);
  ok(res, { ok: true, user: v ? publicUser(v.user) : null, preview: !!(v && v.preview), kpReady: !!kpUser() });
});

route('GET', '/api/meta', (req, res) => ok(res, {
  ok: true, fields: SHEET_FIELDS.map(([key, label, min, max]) => ({ key, label, min, max })), hos: HO_INFO,
}));

// 推送连接
route('GET', '/api/events', (req, res) => {
  const cu = currentUser(req);
  if (!cu) return err(res, 401, '请先登录');
  EV.add(cu.user.id, req, res);
});

route('POST', '/api/login', async (req, res, body) => {
  const ip = clientIp(req);
  const name = String(body.username || '').trim();
  const keys = ['ip:' + ip, 'user:' + name.toLowerCase()];
  const wait = A.limited(keys);
  if (wait) return err(res, 429, `尝试次数过多，请 ${wait} 分钟后再试`);
  const u = findUser(name);
  if (!u || u.role !== 'player' || !A.verify(body.password, u.pw)) {
    A.fail(keys); logLogin(req, name, 'player', false);
    return err(res, 401, '账号或密码不正确');
  }
  A.succeed(keys); logLogin(req, u.username, 'player', true);
  startSession(req, res, u);
  ok(res, { ok: true, user: publicUser(u) });
});

route('POST', '/api/logout', (req, res) => {
  const cu = currentUser(req);
  if (cu) { delete db.sessions[cu.sid]; DB.save(); }
  setCookie(req, res, '', 0);
  ok(res);
});

route('POST', '/api/register', async (req, res, body) => {
  const ip = clientIp(req);
  const keys = ['reg:' + ip];
  const wait = A.limited(keys);
  if (wait) return err(res, 429, `尝试次数过多，请 ${wait} 分钟后再试`);
  const code = String(body.code || '').trim().toUpperCase();
  const inv = db.invites.find(i => i.code === code);
  if (!inv || inv.usedBy || inv.revoked) { A.fail(keys); return err(res, 400, '邀请码无效或已被使用'); }
  const username = cleanUsername(body.username);
  if (!username) return err(res, 400, '账号名需要 2–20 个字，只能用文字、数字、_ 和 -');
  if (username.toLowerCase() === KP_NAME.toLowerCase() || /^test-/i.test(username) || findUser(username)) {
    return err(res, 400, '这个账号名不能用，换一个');
  }
  const pw = String(body.password || '');
  if (pw.length < 6 || pw.length > 100) return err(res, 400, '密码至少 6 位');
  let sheet;
  try { sheet = cleanSheet(body.sheet || {}); } catch (e) { return err(res, 400, e.message); }
  const u = {
    id: db.nextId++, username, role: 'player', pw: A.hash(pw), ho: inv.ho, kind: HO_INFO[inv.ho].kind,
    sheet, hpNow: sheet.hp, status: 'pending', test: false, createdAt: now(),
  };
  db.users.push(u);
  inv.usedBy = u.id; inv.usedAt = now();
  A.succeed(keys);
  DB.save();
  logLogin(req, username, 'register', true);
  startSession(req, res, u);
  notifyKp();
  ok(res, { ok: true, user: publicUser(u) });
});

route('POST', '/api/sheet', async (req, res, body) => {
  const cu = currentUser(req);
  if (!cu || cu.user.role !== 'player') return err(res, 401, '请先登录');
  if (cu.user.status !== 'pending') return err(res, 403, '角色卡已由 KP 锁定，需要修改请联系 KP');
  try { cu.user.sheet = cleanSheet(body.sheet || {}); } catch (e) { return err(res, 400, e.message); }
  cu.user.hpNow = cu.user.sheet.hp;
  DB.save();
  notifyKp();
  ok(res, { ok: true, user: publicUser(cu.user) });
});

// 玩家终端的程序列表：开放的（可启动）和锁定的（只显示名字）
route('GET', '/api/entries', (req, res, body, url) => {
  const v = viewer(req, url);
  if (!v) return err(res, 401, '请先登录');
  const u = v.user;
  const toItem = e => ({ id: e.id, name: e.name, desc: e.desc, url: `/games/${e.dir}/` });
  if (u.role === 'kp') return ok(res, { ok: true, entries: entryList().map(toItem), locked: [] });
  const approved = u.status === 'approved';
  const all = entryList();
  const open = approved ? all.filter(e => entryState(u.id, e.id) === 'open') : [];
  const locked = approved ? all.filter(e => entryState(u.id, e.id) === 'locked') : [];
  ok(res, { ok: true, entries: open.map(toItem), locked: locked.map(e => ({ id: e.id, name: e.name })) });
});

route('GET', '/api/messages', (req, res, body, url) => {
  const v = viewer(req, url);
  if (!v || v.user.role !== 'player') return err(res, 401, '请先登录');
  ok(res, { ok: true, messages: messagesFor(v.user.id) });
});

route('POST', '/api/messages/read', async (req, res, body) => {
  const cu = currentUser(req);
  if (!cu || cu.user.role !== 'player') return err(res, 401, '请先登录');
  const m = db.messages.find(x => x.id === body.id && x.to.includes(cu.user.id));
  if (!m) return err(res, 404, '没有这条消息');
  if (!m.readBy[cu.user.id]) { m.readBy[cu.user.id] = now(); DB.save(); notifyKp(); }
  ok(res);
});

// ----- KP -----
function requireKp(req, res) {
  const cu = currentUser(req);
  if (!cu || cu.user.role !== 'kp') { err(res, 401, '需要 KP 登录'); return null; }
  return cu.user;
}

route('POST', '/api/kp/setup', async (req, res, body) => {
  if (kpUser() || !setupCode) return err(res, 404, '已完成初始化');
  const keys = ['setup:' + clientIp(req)];
  const wait = A.limited(keys);
  if (wait) return err(res, 429, `尝试次数过多，请 ${wait} 分钟后再试`);
  if (String(body.code || '').trim().toUpperCase() !== setupCode) { A.fail(keys); return err(res, 400, '初始化码不正确'); }
  const pw = String(body.password || ''), secret = String(body.secret || '');
  if (pw.length < 8) return err(res, 400, '密码至少 8 位');
  if (secret.length < 4) return err(res, 400, '密令至少 4 个字');
  if (pw === secret) return err(res, 400, '密码和密令不要相同');
  const u = { id: db.nextId++, username: KP_NAME, role: 'kp', pw: A.hash(pw), secret: A.hash(secret), createdAt: now() };
  db.users.push(u);
  setupCode = null;
  DB.save();
  console.log('[VOID] KP 账号已初始化');
  ok(res, { ok: true, username: KP_NAME });
});

route('POST', '/api/kp/login', async (req, res, body) => {
  const ip = clientIp(req);
  const keys = ['kpip:' + ip, 'kp'];
  const wait = A.limited(keys);
  if (wait) return err(res, 429, `尝试次数过多，请 ${wait} 分钟后再试`);
  const u = kpUser();
  const pwOk = !!u && A.verify(body.password, u.pw);
  const secretOk = !!u && A.verify(body.secret, u.secret);
  const good = !!u && String(body.username || '').trim() === u.username && pwOk && secretOk;
  if (!good) {
    A.fail(keys); logLogin(req, body.username || '', 'kp', false);
    return err(res, 401, '验证失败');
  }
  A.succeed(keys); logLogin(req, u.username, 'kp', true);
  startSession(req, res, u);
  ok(res);
});

route('GET', '/api/kp/state', (req, res) => {
  if (!requireKp(req, res)) return;
  if (E.sync(db, GAMES_DIR)) DB.save();
  const online = EV.online();
  ok(res, {
    ok: true,
    kpName: KP_NAME,
    hos: HO_INFO,
    fields: SHEET_FIELDS.map(([key, label, min, max]) => ({ key, label, min, max })),
    entries: entryList().map(e => ({ id: e.id, name: e.name, desc: e.desc, url: `/games/${e.dir}/` })),
    users: db.users.filter(u => u.role === 'player').map(u => Object.assign(publicUser(u, true), { online: online.includes(u.id) })),
    unlocks: db.unlocks,
    presets: db.presets.map(p => ({ id: p.id, name: p.name, updatedAt: p.updatedAt })),
    messages: db.messages.slice().reverse(),
    invites: db.invites.slice().reverse(),
    loginLog: db.loginLog.slice(-100).reverse(),
  });
});

route('GET', '/api/kp/system', (req, res) => {
  if (!requireKp(req, res)) return;
  let version = '未知', dataSize = 0, lastBackup = null;
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5);
      const refFile = path.join(ROOT, '.git', ref);
      if (fs.existsSync(refFile)) version = fs.readFileSync(refFile, 'utf8').trim();
      else {
        const packed = fs.readFileSync(path.join(ROOT, '.git', 'packed-refs'), 'utf8');
        const line = packed.split('\n').find(l => l.endsWith(' ' + ref));
        if (line) version = line.split(' ')[0];
      }
    } else version = head;
    version = version.slice(0, 7);
  } catch {}
  try { dataSize = fs.statSync(path.join(DB.DATA_DIR, 'db.json')).size; } catch {}
  try {
    const b = fs.readdirSync(path.join(DB.DATA_DIR, 'backup')).filter(f => f.startsWith('db-')).sort().pop();
    if (b) lastBackup = b.slice(3, 13);
  } catch {}
  const mem = process.memoryUsage();
  ok(res, {
    ok: true, version, node: process.version, uptime: now() - STARTED,
    memoryMB: Math.round(mem.rss / 1048576), dataKB: Math.round(dataSize / 1024), lastBackup,
  });
});

route('POST', '/api/kp/invite', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  if (!HO_INFO[body.ho]) return err(res, 400, '请选择 HO');
  let code;
  do { code = A.inviteCode(); } while (db.invites.some(i => i.code === code));
  db.invites.push({ code, ho: body.ho, createdAt: now(), usedBy: null, usedAt: null, revoked: false });
  DB.save();
  ok(res, { ok: true, code });
});

route('POST', '/api/kp/invite/revoke', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const inv = db.invites.find(i => i.code === body.code);
  if (!inv) return err(res, 404, '没有这个邀请码');
  if (inv.usedBy) return err(res, 400, '已被使用，不能作废');
  inv.revoked = true;
  DB.save();
  ok(res);
});

route('POST', '/api/kp/user', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const u = findPlayer(body.id);
  if (!u) return err(res, 404, '没有这个玩家');
  if (body.sheet) {
    try { u.sheet = cleanSheet(body.sheet, u.sheet); } catch (e) { return err(res, 400, e.message); }
  }
  if (body.hpNow !== undefined) {
    const hp = Number(body.hpNow);
    if (!Number.isInteger(hp) || hp < 0 || hp > 99) return err(res, 400, '当前 HP 需要是 0–99 的整数');
    u.hpNow = hp;
  }
  if (body.status) {
    if (!['pending', 'approved'].includes(body.status)) return err(res, 400, '状态不正确');
    u.status = body.status;
  }
  if (body.password) {
    if (String(body.password).length < 6) return err(res, 400, '密码至少 6 位');
    u.pw = A.hash(body.password);
    endSessionsOf(u.id);
  }
  DB.save();
  notifyUser(u.id, 'user');
  ok(res, { ok: true, user: publicUser(u, true) });
});

route('POST', '/api/kp/user/delete', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const i = db.users.findIndex(x => x.id === Number(body.id) && x.role === 'player');
  if (i < 0) return err(res, 404, '没有这个玩家');
  const u = db.users[i];
  db.users.splice(i, 1);
  delete db.unlocks[u.id];
  for (const p of db.presets) delete p.states[u.id];
  for (const m of db.messages) m.to = m.to.filter(x => x !== u.id);
  db.messages = db.messages.filter(m => m.to.length);
  endSessionsOf(u.id);
  DB.save();
  ok(res);
});

route('POST', '/api/kp/unlock', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const u = findPlayer(body.uid);
  const e = entryList().find(x => x.id === body.entry);
  if (!u || !e) return err(res, 404, '玩家或入口不存在');
  if (!STATES.includes(body.state)) return err(res, 400, '状态不正确');
  (db.unlocks[u.id] = db.unlocks[u.id] || {})[e.id] = body.state;
  DB.save();
  notifyUser(u.id, 'entries');
  ok(res);
});

route('POST', '/api/kp/entry', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const e = db.entries[body.id];
  if (!e || e.missing) return err(res, 404, '没有这个入口');
  try {
    e.name = cleanText(body.name, 30, '名字');
    e.desc = cleanText(body.desc, 200, '说明', false);
  } catch (x) { return err(res, 400, x.message); }
  DB.save();
  notifyAllPlayers('entries');
  ok(res);
});

// 场景预设
function snapshotStates() {
  const states = {};
  for (const u of db.users) if (u.role === 'player') {
    states[u.id] = {};
    for (const e of entryList()) states[u.id][e.id] = entryState(u.id, e.id);
  }
  return states;
}

route('POST', '/api/kp/preset/save', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  if (body.id) {
    const p = db.presets.find(x => x.id === body.id);
    if (!p) return err(res, 404, '没有这个预设');
    p.states = snapshotStates(); p.updatedAt = now();
  } else {
    let name;
    try { name = cleanText(body.name, 30, '预设名字'); } catch (x) { return err(res, 400, x.message); }
    db.presets.push({ id: newId('p'), name, states: snapshotStates(), createdAt: now(), updatedAt: now() });
  }
  DB.save();
  notifyKp();
  ok(res);
});

route('POST', '/api/kp/preset/view', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const p = db.presets.find(x => x.id === body.id);
  if (!p) return err(res, 404, '没有这个预设');
  ok(res, { ok: true, preset: p });
});

route('POST', '/api/kp/preset/apply', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const p = db.presets.find(x => x.id === body.id);
  if (!p) return err(res, 404, '没有这个预设');
  for (const [uid, st] of Object.entries(p.states)) {
    const u = findPlayer(uid);
    if (!u) continue;
    const cur = db.unlocks[u.id] = db.unlocks[u.id] || {};
    for (const [eid, s] of Object.entries(st)) if (STATES.includes(s)) cur[eid] = s;
    EV.send(u.id, 'refresh', { what: 'entries' });
  }
  DB.save();
  notifyKp();
  ok(res);
});

route('POST', '/api/kp/preset/rename', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const p = db.presets.find(x => x.id === body.id);
  if (!p) return err(res, 404, '没有这个预设');
  try { p.name = cleanText(body.name, 30, '预设名字'); } catch (x) { return err(res, 400, x.message); }
  DB.save();
  notifyKp();
  ok(res);
});

route('POST', '/api/kp/preset/delete', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  db.presets = db.presets.filter(x => x.id !== body.id);
  DB.save();
  notifyKp();
  ok(res);
});

// 秘密情报 / 系统消息
route('POST', '/api/kp/message/send', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const to = [...new Set((Array.isArray(body.to) ? body.to : []).map(Number))].filter(id => findPlayer(id));
  if (!to.length) return err(res, 400, '请选择发给谁');
  let title, text;
  try {
    title = cleanText(body.title, 60, '标题');
    text = cleanText(body.body, 3000, '正文');
  } catch (x) { return err(res, 400, x.message); }
  const m = { id: newId('m'), to, title, body: text, t: now(), readBy: {} };
  db.messages.push(m);
  DB.save();
  for (const uid of to) EV.send(uid, 'message', { id: m.id });
  notifyKp();
  ok(res, { ok: true, id: m.id });
});

route('POST', '/api/kp/message/delete', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const m = db.messages.find(x => x.id === body.id);
  if (!m) return err(res, 404, '没有这条消息');
  db.messages = db.messages.filter(x => x !== m);
  DB.save();
  for (const uid of m.to) EV.send(uid, 'refresh', { what: 'messages' });
  notifyKp();
  ok(res);
});

// 测试账号：test-ho1（人类）、test-ho2（仿生人）。每次重置生成新密码，并清空进度和消息。
route('POST', '/api/kp/test/reset', async (req, res) => {
  if (!requireKp(req, res)) return;
  const made = [];
  for (const [username, ho, name] of [['test-ho1', 'HO1', '测试员（人类）'], ['test-ho2', 'HO2', '测试机（仿生人）']]) {
    const password = A.readablePassword();
    let u = findUser(username);
    if (!u) {
      u = { id: db.nextId++, username, role: 'player', createdAt: now() };
      db.users.push(u);
    }
    Object.assign(u, {
      pw: A.hash(password), ho, kind: HO_INFO[ho].kind, test: true, status: 'approved',
      sheet: { name, dex: 60, hp: 12, comp: ho === 'HO2' ? 80 : 50, hack: 0, spot: 60, mech: 20, lock: 20, idea: 60 },
    });
    u.hpNow = u.sheet.hp;
    db.unlocks[u.id] = Object.fromEntries(entryList().map(e => [e.id, 'open']));
    for (const m of db.messages) m.to = m.to.filter(x => x !== u.id);
    endSessionsOf(u.id);
    made.push({ username, password, ho });
  }
  db.messages = db.messages.filter(m => m.to.length);
  DB.save();
  notifyKp();
  ok(res, { ok: true, accounts: made });
});

// ---------- 请求分发 ----------
const server = http.createServer(async (req, res) => {
  let url, p;
  try { url = new URL(req.url, 'http://x'); p = decodeURIComponent(url.pathname); } catch { return notFound(res); }

  try {
    // API
    if (p.startsWith('/api/')) {
      const fn = routes[req.method + ' ' + p];
      if (!fn) return err(res, 404, 'not found');
      let body = {};
      if (req.method === 'POST') {
        // 简单的跨站防护：必须带自定义请求头，跨站表单无法伪造
        if (req.headers['x-void'] !== '1') return err(res, 403, 'forbidden');
        try { body = await readBody(req); } catch { return err(res, 400, '请求格式不正确'); }
      }
      return await fn(req, res, body, url);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);

    // 页面
    if (PAGES[p]) {
      if (p === '/kp/setup' && kpUser()) return notFound(res);
      return serveFile(req, res, path.join(PUBLIC_DIR, PAGES[p]), 'no-cache');
    }

    // 公共静态资源（样式、脚本、图标）
    if (p.startsWith('/static/')) {
      const f = safeJoin(PUBLIC_DIR, p.slice('/static/'.length));
      return f ? serveFile(req, res, f, 'public, max-age=300') : notFound(res);
    }

    // 游戏文件：登录且有权限才发送，否则一律 404
    const m = p.match(/^\/games\/([a-z0-9_-]+)(\/.*)?$/);
    if (m) {
      const entry = entryList().find(e => e.dir === m[1]);
      if (!entry) return notFound(res);
      const cu = currentUser(req);
      const user = cu && cu.user;
      const rel = !m[2] || m[2] === '/' ? 'index.html' : m[2].slice(1);
      const isPage = rel.endsWith('.html');
      if (isPage ? !canOpen(user, entry) : !canLoadAsset(user, entry)) return notFound(res);
      if (!m[2]) { res.writeHead(301, { Location: `/games/${m[1]}/` }); return res.end(); }
      const f = safeJoin(path.join(GAMES_DIR, entry.dir), rel);
      if (!f) return notFound(res);
      const cache = isPage ? 'private, no-cache' : 'private, max-age=86400';
      const onServed = isPage && user.role === 'player' ? () => gameOpened.set(`${user.id}:${entry.id}`, now()) : null;
      return serveFile(req, res, f, cache, onServed);
    }

    return notFound(res);
  } catch (e) {
    console.error('[VOID] 出错', req.method, p, e);
    if (!res.headersSent) err(res, 500, '服务器出错');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[VOID] 平台已启动，端口 ${PORT}，数据目录 ${DB.DATA_DIR}`);
});

function shutdown() { try { DB.save(); } catch {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
