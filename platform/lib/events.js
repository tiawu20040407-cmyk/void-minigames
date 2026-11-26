// 服务器推送（SSE）。浏览器打开 /api/events 后保持连接，服务器有变化时推一条消息过去。
// 不需要 WebSocket，也不需要改反向代理配置。每 25 秒发一次心跳，防止 Cloudflare 断开空闲连接。
'use strict';

const clients = new Map(); // uid -> Set(res)
let onPresence = () => {};

function add(uid, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'private, no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // 让 nginx/OpenResty 不缓冲
  });
  res.write('retry: 3000\n\n');
  let set = clients.get(uid);
  const wasOnline = !!(set && set.size);
  if (!set) clients.set(uid, set = new Set());
  set.add(res);
  if (!wasOnline) onPresence();
  req.on('close', () => {
    set.delete(res);
    if (!set.size) { clients.delete(uid); onPresence(); }
  });
}

function send(uid, type, data = {}) {
  const set = clients.get(uid);
  if (!set) return;
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(msg);
}

function sendMany(uids, type, data) { for (const uid of uids) send(uid, type, data); }

function online() { return Array.from(clients.keys()); }

// 断开某个用户的全部连接（删除账号、改密码时）
function drop(uid) {
  const set = clients.get(uid);
  if (!set) return;
  for (const res of set) res.end();
  clients.delete(uid);
  onPresence();
}

// 频道：观战用。和上面的用户连接分开，不算在线状态，只收这一局的画面或短语。
const chans = new Map(); // key -> Set(res)
function addChan(key, req, res, onChange) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'private, no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  let set = chans.get(key);
  if (!set) chans.set(key, set = new Set());
  set.add(res);
  if (onChange) onChange();
  req.on('close', () => {
    set.delete(res);
    if (!set.size) chans.delete(key);
    if (onChange) onChange();
  });
}
function sendChan(key, type, data = {}) {
  const set = chans.get(key);
  if (!set) return;
  const msg = `event: ${type}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(msg);
}
function chanCount(key) { const set = chans.get(key); return set ? set.size : 0; }
function closeChan(key) {
  const set = chans.get(key);
  if (!set) return;
  for (const res of set) res.end();
  chans.delete(key);
}

setInterval(() => {
  for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
  for (const set of chans.values()) for (const res of set) res.write(': ping\n\n');
}, 25000).unref();

module.exports = { add, send, sendMany, online, drop, addChan, sendChan, chanCount, closeChan, setPresenceHandler: fn => { onPresence = fn; } };
