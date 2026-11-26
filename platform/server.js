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
const PARTNER = { HO1: 'HO2', HO2: 'HO1', HO3: 'HO4', HO4: 'HO3' };
const DEFAULT_AMBIENT = [
  '未检测到威胁。',
  '周边环境稳定。',
  '附近无可疑信号。',
  '环境噪声处于正常范围。',
  '未发现未登记的机体。',
];
const GLITCHES = ['snow', 'black', 'bsod']; // bsod：人类办公电脑的蓝屏

// 第 3c 步：接入平台的游戏。skill：用角色卡的哪个技能；settings：KP 在控制台定的设置（对玩家隐藏）
const GAME_DEFS = {
  hack: {
    skill: 'hack',
    settings: [
      { key: 'difficulty', label: '难度', options: [['1.3', '一档 1.3'], ['1.4', '二档 1.4'], ['1.6', '三档 1.6']], def: '1.3' },
      { key: 'stage', label: '关卡', options: [['firewall', '防火墙'], ['swarm', '数据流'], ['boss', '守卫程序'], ['random', '随机']], def: 'firewall' },
    ],
  },
  footage: {
    skill: 'comp',
    settings: [
      { key: 'tier', label: '段数', options: [['auto', '按技能'], ['high', '6 段'], ['low', '8 段']], def: 'auto' },
      { key: 'retries', label: '允许重来', options: [['0', '0 次'], ['1', '1 次'], ['2', '2 次'], ['3', '3 次']], def: '1' },
      { key: 'tut', label: '教学', options: [['1', '开'], ['0', '关']], def: '1' },
      { key: 'clues', label: '破绽类型', multi: true, options: [['weather', '天气'], ['umbrella', '晾着的伞'], ['paper', '一摞报纸'], ['cat', '白天的白猫']], def: ['weather', 'umbrella', 'paper', 'cat'] },
    ],
  },
};
const ATTEMPT_TTL = 12 * 3600 * 1000; // 开始一局后多久内还能上传结果
// 第 3d 步：观战
const DEFAULT_CHEERS = ['左边！', '右边！', '小心！', '加油', '稳住', '快到了', '好厉害', '？？？'];
const LIVE_STALE = 60 * 1000;      // 这么久没收到操作者的画面或心跳，就当这一局断了
const LIVE_KEEP = 10 * 60 * 1000;  // 结束后在内存里留多久（中途进来的人还能看到“本局结束”）
const CHEER_GAP = 2000;            // 每个观众两次短语之间至少隔多久

// ---------- 启动 ----------
const db = DB.load();
db.presets = db.presets || [];   // {id, name, states: {uid: {entryId: state}}, createdAt, updatedAt}
db.messages = db.messages || []; // {id, to: [uid], title, body, t, readBy: {uid: t}}
// 第 3a 步：扫描条目、环境台词池。用户上另有 model（型号名）、hudColor（旧型机颜色）、vitals（体征覆盖）
db.scans = db.scans || [];       // {id, title, lines, createdAt, updatedAt}；状态存在 db.unlocks[uid]['scan:'+id]
if (!Array.isArray(db.hudAmbient)) db.hudAmbient = DEFAULT_AMBIENT.slice();
// 第 3b 步：办公电脑的系统名、回收站文件（状态存在 db.unlocks[uid]['trash:'+id]）。用户上另有 notes（记事本）
if (typeof db.deskName !== 'string' || !db.deskName) db.deskName = 'MPD OS';
db.trash = db.trash || [];       // {id, title, body, createdAt, updatedAt}
// 第 3c 步：游戏设置、正式局次数、开局记录、结果
db.gameSettings = db.gameSettings || {}; // {entryId: {key: value}}
db.plays = db.plays || {};               // {uid: {entryId: {used, extra}}}，正式局次数 = 1 + extra
db.attempts = db.attempts || {};         // {attemptId: {uid, entry, official, t}}
db.results = db.results || [];           // {id, rid, uid, entry, official, attempt, result, t, test}
// 第 3d 步：每个游戏谁能观战（默认没人），快捷短语
db.spectate = db.spectate || {};         // {entryId: {all, uids: [], showRecover}}
if (!Array.isArray(db.cheers) || !db.cheers.length) db.cheers = DEFAULT_CHEERS.slice();
for (const u of db.users) if (u.role === 'player') fillHudDefaults(u);
E.sync(db, GAMES_DIR);
DB.save();
// 每分钟重新扫描 games/，git pull 加进来的新游戏不用重启就会出现在控制台
setInterval(() => { if (E.sync(db, GAMES_DIR)) { DB.save(); notifyKp(); } }, 60 * 1000).unref();

const gameOpened = new Map(); // `${uid}:${entryId}` -> 最近一次打开游戏页面的时间
// 正在进行的局（只在内存里，重启就没了）：attempt -> {id, uid, entry, t, last, frame, init, ended, grade, mute}
const lives = new Map();
const cheerAt = new Map();    // uid -> 上次发短语的时间

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

function isHuman(u) { return !!u && u.role === 'player' && (u.ho === 'HO1' || u.ho === 'HO3'); }
function trashKey(id) { return 'trash:' + id; }
function gameSettings(entryId) {
  const def = GAME_DEFS[entryId], saved = db.gameSettings[entryId] || {}, out = {};
  if (!def) return out;
  for (const f of def.settings) out[f.key] = saved[f.key] !== undefined ? saved[f.key] : f.def;
  return out;
}
function playInfo(uid, entryId) {
  const p = (db.plays[uid] && db.plays[uid][entryId]) || { used: 0, extra: 0 };
  const allowed = 1 + (p.extra || 0);
  return { used: p.used || 0, allowed, extra: p.extra || 0, official: (p.used || 0) < allowed };
}
// 游戏页面里注入的会话信息：玩家的角色名、技能值、KP 的设置、正式局是否还有
function gameSession(user, entry) {
  if (user.role === 'kp') return { role: 'kp', game: entry.id };
  const def = GAME_DEFS[entry.id];
  return Object.assign({
    role: 'player', game: entry.id, ho: user.ho, name: user.sheet.name, test: !!user.test,
    skill: def ? Number(user.sheet[def.skill]) || 0 : null, settings: gameSettings(entry.id),
    spectate: { showRecover: spectateOf(entry.id).showRecover }, // 录像排序：要不要把恢复画面发给观众
  }, playInfo(user.id, entry.id));
}
function serveGamePage(req, res, file, session) {
  fs.readFile(file, 'utf8', (e, html) => {
    if (e) return notFound(res);
    const json = JSON.stringify(session).replace(/</g, '\\u003c');
    const inject = `<script>window.VOID_SESSION=${json};</script><script src="/static/void-bridge.js?v=${assetVersion()}"></script>`;
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + inject) : inject + html;
    send(res, 200, html, 'text/html; charset=utf-8', { 'Cache-Control': 'private, no-store' });
  });
}
function notifyDesk(what = 'desk') {
  for (const u of db.users) if (isHuman(u)) EV.send(u.id, 'refresh', { what });
  notifyKp();
}
function isAndroid(u) { return !!u && u.role === 'player' && (u.ho === 'HO2' || u.ho === 'HO4'); }
function fillHudDefaults(u) {
  if (u.model === undefined) u.model = u.ho === 'HO2' ? 'BR800' : '';
  if (!['grey', 'green'].includes(u.hudColor)) u.hudColor = 'grey'; // 旧型机：灰白（默认）或淡绿。早期的 amber 自动改成 grey
  if (!u.vitals || typeof u.vitals !== 'object') u.vitals = { hr: null, bp: null, rr: null };
}
// 搭档：HO1—HO2、HO3—HO4。测试账号只和测试账号配对；有多个时取已审核、最早注册的
function partnerOf(u) {
  const ho = PARTNER[u.ho];
  if (!ho) return null;
  return db.users.find(x => x.role === 'player' && x.ho === ho && !!x.test === !!u.test && x.status === 'approved') || null;
}
// 伤情：0 无伤、1 轻伤、2 重伤、3 濒死
function injuryTier(u) {
  const max = Math.max(1, u.sheet.hp), hp = Math.max(0, Math.min(u.hpNow, max));
  if (hp >= max) return 0;
  if (hp * 2 >= max) return 1;
  if (hp > 0) return 2;
  return 3;
}
// 仿生人界面相关的变化：通知所有仿生人玩家重新读取（玩家只有几个人，不必精确到人）
function notifyHud(what = 'hud') {
  for (const u of db.users) if (isAndroid(u)) EV.send(u.id, 'refresh', { what });
  notifyKp();
}
function scanKey(id) { return 'scan:' + id; }

// ----- 观战 -----
function spectateOf(entryId) {
  const s = db.spectate[entryId] || {};
  return { all: !!s.all, uids: Array.isArray(s.uids) ? s.uids : [], showRecover: !!s.showRecover };
}
// KP 永远能看；玩家要在这个游戏的观战名单里，不能看自己，测试账号只看测试账号
function canWatch(user, L) {
  if (!user || !L) return false;
  if (user.role === 'kp') return true;
  if (user.role !== 'player' || user.status !== 'approved' || user.id === L.uid) return false;
  const op = db.users.find(u => u.id === L.uid);
  if (!op || !!op.test !== !!user.test) return false;
  const sp = spectateOf(L.entry);
  return sp.all || sp.uids.includes(user.id);
}
function liveWatchers(L) { return db.users.filter(u => u.role === 'player' && canWatch(u, L)); }
function notifyLive(L) {
  for (const u of liveWatchers(L)) EV.send(u.id, 'refresh', { what: 'live' });
  notifyKp('live');
}
function liveInfo(L) {
  const op = db.users.find(u => u.id === L.uid), e = entryList().find(x => x.id === L.entry);
  return {
    attempt: L.id, game: L.entry, gameName: e ? e.name : L.entry, ho: op ? op.ho : '', name: op ? op.sheet.name : '',
    url: e ? `/games/${e.dir}/?watch=${encodeURIComponent(L.id)}` : '', t: L.t,
    watchers: EV.chanCount('watch:' + L.id), ended: L.ended, grade: L.grade,
  };
}
// 某个人现在能看的局（未结束的）
function livesFor(user) {
  return [...lives.values()].filter(L => !L.ended && canWatch(user, L)).map(liveInfo);
}
function endLive(L, grade) {
  if (L.ended) return;
  L.ended = true; L.grade = grade; L.endedAt = now();
  const msg = JSON.stringify({ grade });
  EV.sendChan('watch:' + L.id, 'end', msg); EV.sendChan('watchkp:' + L.id, 'end', msg);
  notifyLive(L);
}
setInterval(() => {
  for (const L of lives.values()) {
    if (!L.ended && now() - L.last > LIVE_STALE) endLive(L, null);
    if (L.ended && now() - L.endedAt > LIVE_KEEP) {
      lives.delete(L.id);
      for (const k of ['watch:', 'watchkp:', 'play:']) EV.closeChan(k + L.id);
    }
  }
}, 5000).unref();
function watchSession(user, L) {
  const op = db.users.find(u => u.id === L.uid);
  return {
    role: 'watch', game: L.entry, attempt: L.id, me: user.role === 'kp' ? 'KP' : user.ho,
    operator: { ho: op ? op.ho : '', name: op ? op.sheet.name : '' },
    cheers: db.cheers, showRecover: spectateOf(L.entry).showRecover,
  };
}

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

// KP 和玩家用两个不同的 cookie，同一个浏览器里可以同时登录 KP 和一个玩家
const COOKIE = { player: 'void_sid', kp: 'void_kp' };

function setCookie(req, res, name, value, maxAgeMs) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
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

// which：'player' 只看玩家登录，'kp' 只看 KP 登录，不填则先玩家后 KP
function currentUser(req, which) {
  if (!which) return currentUser(req, 'player') || currentUser(req, 'kp');
  const sid = parseCookies(req)[COOKIE[which]];
  if (!sid) return null;
  const s = db.sessions[sid];
  if (!s) return null;
  if (s.exp < now()) { delete db.sessions[sid]; return null; }
  const u = db.users.find(x => x.id === s.uid);
  return u && u.role === which ? { user: u, sid, t: s.t || 0 } : null;
}

function startSession(req, res, user) {
  for (const [k, s] of Object.entries(db.sessions)) if (s.exp < now()) delete db.sessions[k];
  const sid = A.token();
  const ttl = user.role === 'kp' ? KP_SESSION : PLAYER_SESSION;
  db.sessions[sid] = { uid: user.id, exp: now() + ttl, t: now() };
  DB.save();
  setCookie(req, res, COOKIE[user.role], sid, ttl);
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
  if (forKp) Object.assign(out, { createdAt: u.createdAt, model: u.model, hudColor: u.hudColor, vitals: u.vitals, notes: u.notes || '', notesAt: u.notesAt || null });
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
  const as = url.searchParams.get('as');
  if (as) {
    const kp = currentUser(req, 'kp');
    const p = kp && findPlayer(as);
    return p ? { user: p, preview: true } : null;
  }
  const cu = currentUser(req);
  if (!cu) return null;
  return { user: cu.user, preview: false, sessionT: cu.t };
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

// 页面里引用的样式和脚本自动带上版本号（?v=...），文件一改版本号就变。
// 这样浏览器和 Cloudflare 都会去取新文件，不会出现“新页面配旧脚本”导致的空白页。
let verCache = { t: 0, v: '' };
function assetVersion() {
  if (now() - verCache.t < 5000) return verCache.v;
  let h = 0;
  try {
    for (const f of fs.readdirSync(PUBLIC_DIR).sort()) {
      const st = fs.statSync(path.join(PUBLIC_DIR, f));
      for (const ch of `${f}:${st.size}:${Math.floor(st.mtimeMs)};`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
    }
  } catch {}
  verCache = { t: now(), v: (h >>> 0).toString(36) };
  return verCache.v;
}
function servePage(req, res, file, cache) {
  fs.readFile(file, 'utf8', (e, html) => {
    if (e) return notFound(res);
    const v = assetVersion();
    html = html.replace(/(\/static\/[\w.-]+\.(?:js|css))(?=["'])/g, `$1?v=${v}`);
    send(res, 200, html, 'text/html; charset=utf-8', { 'Cache-Control': cache });
  });
}

const PAGES = {
  '/': 'index.html',
  '/register': 'register.html',
  '/intranet': 'intranet.html',
  '/terminal': 'terminal.html',
  '/hud': 'hud.html',
  '/desk': 'desk.html',
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
  ok(res, { ok: true, user: v ? publicUser(v.user) : null, preview: !!(v && v.preview), sessionT: v && v.sessionT || 0, kpReady: !!kpUser() });
});

route('GET', '/api/meta', (req, res) => ok(res, {
  ok: true, fields: SHEET_FIELDS.map(([key, label, min, max]) => ({ key, label, min, max })), hos: HO_INFO,
}));

// 推送连接
route('GET', '/api/events', (req, res, body, url) => {
  const cu = currentUser(req, url.searchParams.get('kp') ? 'kp' : 'player');
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
  // 复制粘贴时常带进前后空格，原样不对时再试一次去掉空格的
  const pwOk = u && (A.verify(body.password, u.pw) || A.verify(String(body.password || '').trim(), u.pw));
  if (!u || u.role !== 'player' || !pwOk) {
    A.fail(keys); logLogin(req, name, 'player', false);
    return err(res, 401, '账号或密码不正确');
  }
  A.succeed(keys); logLogin(req, u.username, 'player', true);
  startSession(req, res, u);
  ok(res, { ok: true, user: publicUser(u) });
});

route('POST', '/api/logout', (req, res, body) => {
  const which = body.kind === 'kp' ? 'kp' : 'player';
  const cu = currentUser(req, which);
  if (cu) { delete db.sessions[cu.sid]; DB.save(); }
  setCookie(req, res, COOKIE[which], '', 0);
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
  fillHudDefaults(u);
  db.users.push(u);
  inv.usedBy = u.id; inv.usedAt = now();
  A.succeed(keys);
  DB.save();
  logLogin(req, username, 'register', true);
  startSession(req, res, u);
  notifyHud('vitals');
  ok(res, { ok: true, user: publicUser(u) });
});

route('POST', '/api/sheet', async (req, res, body) => {
  const cu = currentUser(req, 'player');
  if (!cu || cu.user.role !== 'player') return err(res, 401, '请先登录');
  if (cu.user.status !== 'pending') return err(res, 403, '角色卡已由 KP 锁定，需要修改请联系 KP');
  try { cu.user.sheet = cleanSheet(body.sheet || {}); } catch (e) { return err(res, 400, e.message); }
  cu.user.hpNow = cu.user.sheet.hp;
  DB.save();
  notifyHud('vitals');
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
  const cu = currentUser(req, 'player');
  if (!cu || cu.user.role !== 'player') return err(res, 401, '请先登录');
  const m = db.messages.find(x => x.id === body.id && x.to.includes(cu.user.id));
  if (!m) return err(res, 404, '没有这条消息');
  if (!m.readBy[cu.user.id]) { m.readBy[cu.user.id] = now(); DB.save(); notifyKp(); }
  ok(res);
});

// 仿生人 HUD 的数据：本机设置、搭档体征（只给伤情档和覆盖值，不给 HP 数字）、已开放的扫描条目、环境台词
route('GET', '/api/hud', (req, res, body, url) => {
  const v = viewer(req, url);
  if (!v || !isAndroid(v.user) || v.user.status !== 'approved') return err(res, 403, '不可用');
  const u = v.user;
  const p = partnerOf(u);
  const partner = p ? { connected: true, name: p.sheet.name, ho: p.ho, tier: injuryTier(p), vitals: p.vitals } : { connected: false, ho: PARTNER[u.ho] };
  const scans = db.scans.filter(s => entryState(u.id, scanKey(s.id)) === 'open')
    .map(s => ({ id: s.id, title: s.title, lines: s.lines, updatedAt: s.updatedAt }));
  ok(res, { ok: true, model: u.model, color: u.ho === 'HO2' ? 'cyan' : u.hudColor, partner, scans, ambient: db.hudAmbient, lives: livesFor(u) });
});

// 人类办公电脑的数据：系统名、已开放的回收站文件、本人记事本
route('GET', '/api/desk', (req, res, body, url) => {
  const v = viewer(req, url);
  if (!v || !isHuman(v.user) || v.user.status !== 'approved') return err(res, 403, '不可用');
  const u = v.user;
  const trash = db.trash.filter(t => entryState(u.id, trashKey(t.id)) === 'open')
    .map(t => ({ id: t.id, title: t.title, body: t.body, updatedAt: t.updatedAt }));
  ok(res, { ok: true, name: db.deskName, trash, notes: u.notes || '', notesAt: u.notesAt || null, lives: livesFor(u) });
});

// 记事本：玩家自己写，KP 可看
route('POST', '/api/notes', async (req, res, body) => {
  const cu = currentUser(req, 'player');
  if (!cu || cu.user.status !== 'approved') return err(res, 401, '请先登录');
  const text = String(body.text ?? '');
  if (text.length > 20000) return err(res, 400, '记事本最多 20000 个字');
  cu.user.notes = text; cu.user.notesAt = now();
  DB.save();
  notifyKp('notes');
  ok(res, { ok: true, t: cu.user.notesAt });
});

// ----- 游戏：开局、上传结果、查询次数 -----
function gamePlayer(req, res, gameId) {
  const cu = currentUser(req, 'player');
  if (!cu || cu.user.status !== 'approved') { err(res, 401, '请先登录'); return null; }
  const entry = entryList().find(e => e.id === gameId);
  if (!entry) { err(res, 404, '没有这个游戏'); return null; }
  return { user: cu.user, entry };
}
route('GET', '/api/game/status', (req, res, body, url) => {
  const g = gamePlayer(req, res, url.searchParams.get('game'));
  if (!g) return;
  ok(res, Object.assign({ ok: true }, playInfo(g.user.id, g.entry.id)));
});
// 点“开始”时调用：还有正式局就用掉一次（防止打不好刷新重来），没有就是练习局
route('POST', '/api/game/start', async (req, res, body) => {
  const g = gamePlayer(req, res, body.game);
  if (!g) return;
  if (!canOpen(g.user, g.entry)) return err(res, 403, '这个程序现在不能启动');
  const uid = g.user.id, eid = g.entry.id;
  const info = playInfo(uid, eid);
  if (info.official) {
    db.plays[uid] = db.plays[uid] || {};
    const p = db.plays[uid][eid] = db.plays[uid][eid] || { used: 0, extra: 0 };
    p.used = (p.used || 0) + 1;
  }
  const id = newId('a');
  db.attempts[id] = { uid, entry: eid, official: info.official, t: now() };
  for (const [k, a] of Object.entries(db.attempts)) if (now() - a.t > ATTEMPT_TTL) delete db.attempts[k];
  DB.save();
  // 同一个人之前没结束的局算断了
  for (const L of lives.values()) if (L.uid === uid && !L.ended) endLive(L, null);
  const L = { id, uid, entry: eid, t: now(), last: now(), frame: null, init: null, ended: false, grade: null, mute: false };
  lives.set(id, L);
  notifyLive(L);
  notifyKp('plays');
  ok(res, Object.assign({ ok: true, attempt: id }, info, playInfo(uid, eid), { official: info.official }));
});
// 结果上传。rid 由浏览器生成，断线补传时同一条不会重复记录。入口关闭后，已开局的仍可上传
route('POST', '/api/game/result', async (req, res, body) => {
  const cu = currentUser(req, 'player');
  if (!cu) return err(res, 401, '请先登录');
  const a = db.attempts[body.attempt];
  if (!a || a.uid !== cu.user.id || now() - a.t > ATTEMPT_TTL) return err(res, 404, '这一局已过期');
  const rid = String(body.rid || '').slice(0, 40);
  if (!rid) return err(res, 400, '缺少 rid');
  if (db.results.some(r => r.rid === rid && r.uid === cu.user.id)) return ok(res, { ok: true, dup: true });
  const result = body.result && typeof body.result === 'object' ? body.result : null;
  if (!result || JSON.stringify(result).length > 4000) return err(res, 400, '结果格式不正确');
  db.results.push({ id: newId('r'), rid, uid: cu.user.id, entry: a.entry, official: a.official, attempt: body.attempt, result, t: now(), test: !!cu.user.test });
  if (db.results.length > 2000) db.results.splice(0, db.results.length - 2000);
  DB.save();
  notifyKp(a.official ? 'result-official' : 'result');
  ok(res);
});

// ----- 观战 -----
// 观战的身份：先看 KP 登录，再看玩家（和游戏页面一致）
function watcherOf(req) {
  const cu = currentUser(req, 'kp') || currentUser(req, 'player');
  return cu ? cu.user : null;
}
function chanEvent(type, str) { return `event: ${type}\ndata: ${str}\n\n`; }
// 操作者发画面：kind = init（这一轮的素材）/ frame（当前状态）/ beat（心跳）/ end（结束，data.win）
route('POST', '/api/live/frame', async (req, res, body) => {
  const cu = currentUser(req, 'player');
  const L = lives.get(String(body.attempt || ''));
  if (!cu || !L || L.uid !== cu.user.id) return err(res, 404, '没有这一局');
  if (L.ended) return ok(res, { ok: true, ended: true });
  const kind = String(body.kind || '');
  if (!['init', 'frame', 'beat', 'end'].includes(kind)) return err(res, 400, 'kind 不正确');
  L.last = now();
  if (kind === 'beat') return ok(res, { ok: true, watchers: EV.chanCount('watch:' + L.id) });
  if (kind === 'end') { endLive(L, body.data && body.data.win ? 'win' : 'lose'); return ok(res); }
  const str = JSON.stringify(body.data === undefined ? null : body.data);
  if (str.length > 60000) return err(res, 400, '画面太大');
  if (kind === 'init') { L.init = str; L.frame = null; } else L.frame = str;
  EV.sendChan('watch:' + L.id, kind, str); EV.sendChan('watchkp:' + L.id, kind, str);
  ok(res, { ok: true, watchers: EV.chanCount('watch:' + L.id) });
});
// as=play：操作者收短语和观众人数；as=watch：观众收画面
route('GET', '/api/live/stream', (req, res, body, url) => {
  const L = lives.get(String(url.searchParams.get('attempt') || ''));
  if (url.searchParams.get('as') === 'play') {
    const cu = currentUser(req, 'player');
    if (!cu || !L || L.uid !== cu.user.id) return err(res, 404, '没有这一局');
    EV.addChan('play:' + L.id, req, res);
    res.write(chanEvent('watchers', JSON.stringify({ n: EV.chanCount('watch:' + L.id) })));
    return;
  }
  const user = watcherOf(req);
  if (!L || !canWatch(user, L)) return err(res, 404, '没有这一局');
  // KP 单独一个频道，不算在操作者看到的观众人数里
  const key = (user.role === 'kp' ? 'watchkp:' : 'watch:') + L.id;
  const count = () => { EV.sendChan('play:' + L.id, 'watchers', { n: EV.chanCount('watch:' + L.id) }); notifyKp('live'); };
  EV.addChan(key, req, res, user.role === 'kp' ? null : count);
  if (L.init) res.write(chanEvent('init', L.init));
  if (L.frame) res.write(chanEvent('frame', L.frame));
  if (L.mute) res.write(chanEvent('mute', JSON.stringify({ mute: true })));
  if (L.ended) res.write(chanEvent('end', JSON.stringify({ grade: L.grade })));
});
// 观众发快捷短语：只能从 KP 定的短语里选，每人每 2 秒一次
route('POST', '/api/live/cheer', async (req, res, body) => {
  const user = watcherOf(req);
  const L = lives.get(String(body.attempt || ''));
  if (!L || !canWatch(user, L)) return err(res, 404, '没有这一局');
  if (L.ended) return err(res, 400, '这一局已经结束');
  const text = db.cheers[Number(body.i)];
  if (typeof text !== 'string') return err(res, 400, '没有这句');
  const last = cheerAt.get(user.id) || 0;
  if (now() - last < CHEER_GAP) return err(res, 429, '慢一点');
  cheerAt.set(user.id, now());
  if (L.mute) return ok(res, { ok: true, muted: true });
  EV.sendChan('play:' + L.id, 'cheer', { from: user.role === 'kp' ? 'KP' : user.ho, text });
  ok(res);
});
// 操作者关掉 / 打开观战提示
route('POST', '/api/live/mute', async (req, res, body) => {
  const cu = currentUser(req, 'player');
  const L = lives.get(String(body.attempt || ''));
  if (!cu || !L || L.uid !== cu.user.id) return err(res, 404, '没有这一局');
  L.mute = !!body.mute;
  const msg = JSON.stringify({ mute: L.mute });
  EV.sendChan('watch:' + L.id, 'mute', msg); EV.sendChan('watchkp:' + L.id, 'mute', msg);
  ok(res);
});
route('GET', '/api/live', (req, res, body, url) => {
  const cu = currentUser(req, url.searchParams.get('kp') ? 'kp' : 'player');
  if (!cu) return err(res, 401, '请先登录');
  ok(res, { ok: true, lives: livesFor(cu.user) });
});

// ----- KP -----
function requireKp(req, res) {
  const cu = currentUser(req, 'kp');
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
    scans: db.scans,
    hudAmbient: db.hudAmbient,
    trash: db.trash,
    deskName: db.deskName,
    gameDefs: GAME_DEFS,
    gameSettings: Object.fromEntries(Object.keys(GAME_DEFS).map(k => [k, gameSettings(k)])),
    plays: Object.fromEntries(db.users.filter(u => u.role === 'player').map(u => [u.id, Object.fromEntries(entryList().map(e => [e.id, playInfo(u.id, e.id)]))])),
    results: db.results.slice(-300).reverse(),
    spectate: Object.fromEntries(entryList().map(e => [e.id, spectateOf(e.id)])),
    cheers: db.cheers,
    lives: [...lives.values()].map(liveInfo).reverse(),
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
  if (body.model !== undefined) {
    try { u.model = cleanText(body.model, 20, '型号', false); } catch (e) { return err(res, 400, e.message); }
  }
  if (body.hudColor !== undefined) {
    if (!['grey', 'green'].includes(body.hudColor)) return err(res, 400, '颜色不正确');
    u.hudColor = body.hudColor;
  }
  if (body.password) {
    if (String(body.password).length < 6) return err(res, 400, '密码至少 6 位');
    u.pw = A.hash(body.password);
    endSessionsOf(u.id);
  }
  DB.save();
  notifyUser(u.id, 'user');
  notifyHud('vitals');
  ok(res, { ok: true, user: publicUser(u, true) });
});

route('POST', '/api/kp/user/delete', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const i = db.users.findIndex(x => x.id === Number(body.id) && x.role === 'player');
  if (i < 0) return err(res, 404, '没有这个玩家');
  const u = db.users[i];
  db.users.splice(i, 1);
  delete db.unlocks[u.id];
  delete db.plays[u.id];
  db.results = db.results.filter(r => r.uid !== u.id);
  for (const p of db.presets) delete p.states[u.id];
  for (const m of db.messages) m.to = m.to.filter(x => x !== u.id);
  db.messages = db.messages.filter(m => m.to.length);
  endSessionsOf(u.id);
  DB.save();
  notifyHud('vitals');
  ok(res);
});

route('POST', '/api/kp/unlock', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const u = findPlayer(body.uid);
  const key = String(body.entry || '');
  const isScan = key.startsWith('scan:'), isTrash = key.startsWith('trash:');
  const e = isScan ? db.scans.find(x => scanKey(x.id) === key)
    : isTrash ? db.trash.find(x => trashKey(x.id) === key)
    : entryList().find(x => x.id === key);
  if (!u || !e) return err(res, 404, '玩家或入口不存在');
  if (!(isScan || isTrash ? ['hidden', 'open'] : STATES).includes(body.state)) return err(res, 400, '状态不正确');
  (db.unlocks[u.id] = db.unlocks[u.id] || {})[key] = body.state;
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
    for (const s of db.scans) states[u.id][scanKey(s.id)] = entryState(u.id, scanKey(s.id));
    for (const t of db.trash) states[u.id][trashKey(t.id)] = entryState(u.id, trashKey(t.id));
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

// 体征面板：改当前 HP（加减或直接设定），0 到 HP 上限
route('POST', '/api/kp/hp', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const u = findPlayer(body.id);
  if (!u) return err(res, 404, '没有这个玩家');
  let hp = body.value !== undefined && body.value !== '' ? Number(body.value) : u.hpNow + Number(body.delta);
  if (!Number.isFinite(hp)) return err(res, 400, 'HP 需要是数字');
  hp = Math.max(0, Math.min(u.sheet.hp, Math.round(hp)));
  u.hpNow = hp;
  DB.save();
  EV.send(u.id, 'refresh', { what: 'user' });
  notifyHud('vitals');
  ok(res, { ok: true, hpNow: hp });
});

// 体征覆盖：心率、血压、呼吸，空值表示不覆盖
route('POST', '/api/kp/vitals', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const u = findPlayer(body.id);
  if (!u) return err(res, 404, '没有这个玩家');
  const out = { hr: null, bp: null, rr: null };
  const hr = String(body.hr ?? '').trim(), bp = String(body.bp ?? '').trim(), rr = String(body.rr ?? '').trim();
  if (hr) { const n = Number(hr); if (!Number.isInteger(n) || n < 0 || n > 250) return err(res, 400, '心率需要是 0–250 的整数'); out.hr = n; }
  if (bp) { if (!/^\d{1,3}\/\d{1,3}$/.test(bp)) return err(res, 400, '血压格式如 120/80'); out.bp = bp; }
  if (rr) { const n = Number(rr); if (!Number.isInteger(n) || n < 0 || n > 80) return err(res, 400, '呼吸需要是 0–80 的整数'); out.rr = n; }
  u.vitals = out;
  DB.save();
  notifyHud('vitals');
  ok(res, { ok: true, vitals: out });
});

// 扫描条目：新建或修改
route('POST', '/api/kp/scan/save', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  let title, lines;
  try {
    title = cleanText(body.title, 40, '目标名');
    lines = cleanText(body.lines, 2000, '数据', false);
  } catch (x) { return err(res, 400, x.message); }
  let s;
  if (body.id) {
    s = db.scans.find(x => x.id === body.id);
    if (!s) return err(res, 404, '没有这个条目');
    Object.assign(s, { title, lines, updatedAt: now() });
  } else {
    s = { id: newId('s'), title, lines, createdAt: now(), updatedAt: now() };
    db.scans.push(s);
  }
  DB.save();
  notifyHud('scans');
  ok(res, { ok: true, id: s.id });
});

route('POST', '/api/kp/scan/delete', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const s = db.scans.find(x => x.id === body.id);
  if (!s) return err(res, 404, '没有这个条目');
  db.scans = db.scans.filter(x => x !== s);
  for (const st of Object.values(db.unlocks)) delete st[scanKey(s.id)];
  for (const p of db.presets) for (const st of Object.values(p.states)) delete st[scanKey(s.id)];
  DB.save();
  notifyHud('scans');
  ok(res);
});

// 环境台词池：一行一句
route('POST', '/api/kp/hud', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const lines = String(body.ambient ?? '').split('\n').map(x => x.trim()).filter(Boolean);
  if (lines.length > 100) return err(res, 400, '最多 100 句');
  if (lines.some(x => x.length > 80)) return err(res, 400, '每句最多 80 个字');
  db.hudAmbient = lines;
  DB.save();
  notifyHud('ambient');
  ok(res);
});

// 回收站文件：新建或修改
route('POST', '/api/kp/trash/save', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  let title, text;
  try {
    title = cleanText(body.title, 40, '文件名');
    text = cleanText(body.body, 5000, '内容', false);
  } catch (x) { return err(res, 400, x.message); }
  let t;
  if (body.id) {
    t = db.trash.find(x => x.id === body.id);
    if (!t) return err(res, 404, '没有这个文件');
    Object.assign(t, { title, body: text, updatedAt: now() });
  } else {
    t = { id: newId('t'), title, body: text, createdAt: now(), updatedAt: now() };
    db.trash.push(t);
  }
  DB.save();
  notifyDesk('trash');
  ok(res, { ok: true, id: t.id });
});

route('POST', '/api/kp/trash/delete', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const t = db.trash.find(x => x.id === body.id);
  if (!t) return err(res, 404, '没有这个文件');
  db.trash = db.trash.filter(x => x !== t);
  for (const st of Object.values(db.unlocks)) delete st[trashKey(t.id)];
  for (const p of db.presets) for (const st of Object.values(p.states)) delete st[trashKey(t.id)];
  DB.save();
  notifyDesk('trash');
  ok(res);
});

// 办公电脑系统名
route('POST', '/api/kp/desk', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  try { db.deskName = cleanText(body.name, 20, '系统名'); } catch (x) { return err(res, 400, x.message); }
  DB.save();
  notifyDesk('desk');
  ok(res);
});

// 游戏设置（对所有玩家统一）
route('POST', '/api/kp/game/settings', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const def = GAME_DEFS[body.entry];
  if (!def) return err(res, 404, '这个游戏没有可调的设置');
  const out = {}, inp = body.settings || {};
  for (const f of def.settings) {
    const v = inp[f.key], keys = f.options.map(o => o[0]);
    if (f.multi) {
      const arr = Array.isArray(v) ? v.filter(x => keys.includes(x)) : [];
      if (!arr.length) return err(res, 400, `${f.label}至少选一项`);
      out[f.key] = arr;
    } else {
      if (!keys.includes(String(v))) return err(res, 400, `${f.label}不正确`);
      out[f.key] = String(v);
    }
  }
  db.gameSettings[body.entry] = out;
  DB.save();
  notifyKp();
  ok(res);
});

// 再给一次正式局（delta: -1 是“收回一次”，只能收回之前多给的）
route('POST', '/api/kp/game/grant', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const u = findPlayer(body.uid);
  const e = entryList().find(x => x.id === body.entry);
  if (!u || !e) return err(res, 404, '玩家或游戏不存在');
  db.plays[u.id] = db.plays[u.id] || {};
  const p = db.plays[u.id][e.id] = db.plays[u.id][e.id] || { used: 0, extra: 0 };
  if (Number(body.delta) === -1) {
    if (!(p.extra > 0)) return err(res, 400, '没有多给的次数可以收回');
    p.extra -= 1;
  } else p.extra = (p.extra || 0) + 1;
  DB.save();
  EV.send(u.id, 'refresh', { what: 'plays' });
  notifyKp();
  ok(res, Object.assign({ ok: true }, playInfo(u.id, e.id)));
});

route('POST', '/api/kp/result/delete', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const n = db.results.length;
  db.results = db.results.filter(r => r.id !== body.id);
  if (db.results.length === n) return err(res, 404, '没有这条结果');
  DB.save();
  notifyKp();
  ok(res);
});

// 观战名单：all 全员，uids 指定玩家；showRecover 观众能否看到录像排序的恢复画面
route('POST', '/api/kp/spectate', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const e = entryList().find(x => x.id === body.entry);
  if (!e) return err(res, 404, '没有这个游戏');
  const uids = (Array.isArray(body.uids) ? body.uids : []).map(Number).filter(id => findPlayer(id));
  db.spectate[e.id] = { all: !!body.all, uids: [...new Set(uids)], showRecover: !!body.showRecover };
  DB.save();
  for (const L of lives.values()) if (L.entry === e.id && !L.ended) notifyLive(L);
  for (const u of db.users) if (u.role === 'player') EV.send(u.id, 'refresh', { what: 'live' });
  notifyKp();
  ok(res);
});
route('POST', '/api/kp/cheers', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const list = (Array.isArray(body.list) ? body.list : []).map(x => String(x).trim()).filter(Boolean);
  if (!list.length) return err(res, 400, '至少留一句');
  if (list.length > 12) return err(res, 400, '最多 12 句');
  if (list.some(x => x.length > 10)) return err(res, 400, '每句最多 10 个字');
  db.cheers = list;
  DB.save();
  notifyKp();
  ok(res);
});

// 界面故障：只推送，不保存
route('POST', '/api/kp/glitch', async (req, res, body) => {
  if (!requireKp(req, res)) return;
  const u = findPlayer(body.uid);
  if (!u) return err(res, 404, '没有这个玩家');
  if (!GLITCHES.includes(body.effect)) return err(res, 400, '效果不正确');
  let text;
  try { text = cleanText(body.text, 60, '文字', false); } catch (x) { return err(res, 400, x.message); }
  EV.send(u.id, 'glitch', { effect: body.effect, text });
  ok(res, { ok: true, online: EV.online().includes(u.id) });
});

// 测试账号：test-ho1（人类）— test-ho2（新型仿生人）、test-ho3（人类）— test-ho4（旧型仿生人），两对搭档。
// 每次重置生成新密码，并清空进度和消息、开放全部游戏入口。
route('POST', '/api/kp/test/reset', async (req, res) => {
  if (!requireKp(req, res)) return;
  const made = [];
  const TESTS = [['test-ho1', 'HO1', '测试员（人类）'], ['test-ho2', 'HO2', '测试机（仿生人）'], ['test-ho3', 'HO3', '测试员二（人类）'], ['test-ho4', 'HO4', '测试机二（旧型）']];
  for (const [username, ho, name] of TESTS) {
    const android = ho === 'HO2' || ho === 'HO4';
    const password = A.readablePassword();
    let u = findUser(username);
    if (!u) {
      u = { id: db.nextId++, username, role: 'player', createdAt: now() };
      db.users.push(u);
    }
    Object.assign(u, {
      pw: A.hash(password), ho, kind: HO_INFO[ho].kind, test: true, status: 'approved',
      // 仿生人 HP 是人类的两倍（模组规则）；HO4 带《艺术（黑客）》，方便测骇入
      sheet: { name, dex: 60, hp: android ? 24 : 12, comp: android ? 80 : 50, hack: ho === 'HO4' ? 70 : 0, spot: 60, mech: 20, lock: 20, idea: 60 },
    });
    u.hpNow = u.sheet.hp;
    u.vitals = { hr: null, bp: null, rr: null };
    u.notes = ''; u.notesAt = null;
    delete db.plays[u.id];
    db.results = db.results.filter(r => r.uid !== u.id);
    fillHudDefaults(u);
    db.unlocks[u.id] = Object.fromEntries(entryList().map(e => [e.id, 'open']));
    for (const m of db.messages) m.to = m.to.filter(x => x !== u.id);
    endSessionsOf(u.id);
    made.push({ username, password, ho });
  }
  db.messages = db.messages.filter(m => m.to.length);
  DB.save();
  notifyHud('vitals');
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
      // 控制台页面只发给已登录的 KP，其他人跳到 KP 登录页（页面本身也不能让玩家看到）
      if (p === '/kp' && !currentUser(req, 'kp')) { res.writeHead(302, { Location: '/kp/login', 'Cache-Control': 'no-store' }); return res.end(); }
      if (p === '/kp') return servePage(req, res, path.join(PUBLIC_DIR, PAGES[p]), 'private, no-store');
      // 每个网址只对应一个页面（不按身份换内容），这样任何一层缓存都不会把一个人的页面发给别人。
      // 已审核的仿生人打开 /terminal 时由页面自己转到 /hud，反过来也一样
      return servePage(req, res, path.join(PUBLIC_DIR, PAGES[p]), 'no-cache');
    }

    // 公共静态资源（样式、脚本、图标）
    if (p.startsWith('/static/')) {
      // 只发样式、脚本、图片；HTML 页面只能从各自的网址打开（控制台页面要先登录 KP）
      if (/\.html?$/i.test(p)) return notFound(res);
      const f = safeJoin(PUBLIC_DIR, p.slice('/static/'.length));
      // 带版本号的可以长期缓存（文件一改网址就变）；不带的每次都问服务器
      const cache = url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache';
      return f ? serveFile(req, res, f, cache) : notFound(res);
    }

    // 游戏文件：登录且有权限才发送，否则一律 404
    const m = p.match(/^\/games\/([a-z0-9_-]+)(\/.*)?$/);
    if (m) {
      const entry = entryList().find(e => e.dir === m[1]);
      if (!entry) return notFound(res);
      const cu = currentUser(req, 'kp') || currentUser(req, 'player');
      const user = cu && cu.user;
      const rel = !m[2] || m[2] === '/' ? 'index.html' : m[2].slice(1);
      const isPage = rel.endsWith('.html');
      // 观战：同一个游戏页面，以观战模式打开。不需要自己的入口是开放的，只要在观战名单里
      const watchId = url.searchParams.get('watch');
      if (watchId && m[2] === '/') {
        const L = lives.get(watchId);
        if (!L || L.entry !== entry.id || !canWatch(user, L)) return notFound(res);
        if (user.role === 'player') gameOpened.set(`${user.id}:${entry.id}`, now()); // 让素材能加载
        const f = safeJoin(path.join(GAMES_DIR, entry.dir), 'index.html');
        return f ? serveGamePage(req, res, f, watchSession(user, L)) : notFound(res);
      }
      if (isPage ? !canOpen(user, entry) : !canLoadAsset(user, entry)) return notFound(res);
      if (!m[2]) { res.writeHead(301, { Location: `/games/${m[1]}/` }); return res.end(); }
      const f = safeJoin(path.join(GAMES_DIR, entry.dir), rel);
      if (!f) return notFound(res);
      if (rel === 'index.html') {
        if (user.role === 'player') gameOpened.set(`${user.id}:${entry.id}`, now());
        return serveGamePage(req, res, f, gameSession(user, entry));
      }
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
