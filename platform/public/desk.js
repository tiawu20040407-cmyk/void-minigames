// 人类办公电脑（HO1、HO3）。数据来自 /api/me、/api/desk、/api/entries、/api/messages，服务器推送后重新读取。
'use strict';
const AS = new URLSearchParams(location.search).get('as'); // KP 预览：只读
const Q = AS ? '?as=' + encodeURIComponent(AS) : '';
const PREVIEW = !!AS;
const mobile = () => matchMedia('(max-width: 760px)').matches;
const touch = () => matchMedia('(pointer: coarse)').matches;

let me = null, desk = null, fields = [], messages = [], entries = { entries: [], locked: [] }, sessionT = 0;

// ---------- 图标 ----------
const I = {
  mail: '<svg viewBox="0 0 48 48"><rect x="5" y="11" width="38" height="27" rx="2" fill="#3d8fe0"/><path d="M6 13l18 14 18-14" fill="none" stroke="#fff" stroke-width="2.5"/></svg>',
  profile: '<svg viewBox="0 0 48 48"><rect x="5" y="9" width="38" height="30" rx="3" fill="#e9eef4"/><rect x="5" y="9" width="38" height="7" rx="3" fill="#2b78d0"/><circle cx="16" cy="26" r="5" fill="#7b8a99"/><path d="M9 36c1-5 4-7 7-7s6 2 7 7" fill="#7b8a99"/><path d="M27 23h11M27 28h11M27 33h7" stroke="#7b8a99" stroke-width="2.4"/></svg>',
  programs: '<svg viewBox="0 0 48 48"><path d="M4 12h15l4 4h21v22a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" fill="#f2b84b"/><path d="M4 18h40v20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" fill="#ffd36b"/></svg>',
  intranet: '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="18" fill="#2b78d0"/><path d="M6 24h36M24 6c-6 6-6 30 0 36M24 6c6 6 6 30 0 36M10 14h28M10 34h28" fill="none" stroke="#bfe0ff" stroke-width="2"/></svg>',
  notepad: '<svg viewBox="0 0 48 48"><rect x="9" y="7" width="30" height="35" rx="2" fill="#fff"/><rect x="9" y="7" width="30" height="6" fill="#4aa3df"/><path d="M14 20h20M14 26h20M14 32h14" stroke="#8a97a5" stroke-width="2.2"/></svg>',
  trash: '<svg viewBox="0 0 48 48"><path d="M12 14h24l-2 28H14Z" fill="#cfd8e2"/><path d="M9 12h30M19 12V8h10v4" fill="none" stroke="#e8eef4" stroke-width="3"/><path d="M19 19v18M24 19v18M29 19v18" stroke="#93a1b0" stroke-width="2"/></svg>',
  exe: '<svg viewBox="0 0 48 48"><rect x="6" y="9" width="36" height="30" rx="2" fill="#1f4f80"/><rect x="6" y="9" width="36" height="6" fill="#5aa9f0"/><path d="M14 23l6 4-6 4M23 32h10" fill="none" stroke="#9fd2ff" stroke-width="2.4"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="12" rx="2" fill="#f2b84b"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="#c48a1e" stroke-width="2.4"/></svg>',
  file: '<svg viewBox="0 0 48 48"><path d="M11 5h18l9 9v29H11Z" fill="#fff"/><path d="M29 5v9h9" fill="#d9e3ee"/><path d="M16 22h17M16 28h17M16 34h12" stroke="#9aa7b4" stroke-width="2"/></svg>',
};
const APPS = [
  { id: 'mail', name: '邮件', w: 720, h: 460 },
  { id: 'profile', name: '职员档案', w: 420, h: 520 },
  { id: 'programs', name: '程序', w: 560, h: 380 },
  { id: 'intranet', name: '警察厅内网', link: '/intranet' },
  { id: 'notepad', name: '记事本', w: 560, h: 420 },
  { id: 'trash', name: '回收站', w: 520, h: 360 },
];

// ---------- 读取 ----------
async function load() {
  const [r, d, ent, msg, meta] = await Promise.all([
    api('/api/me' + Q), api('/api/desk' + Q), api('/api/entries' + Q), api('/api/messages' + Q),
    fields.length ? null : api('/api/meta'),
  ]);
  if ([r, d, ent, msg, meta].some(x => x && x.net)) { linkState(false); if (me) setTimeout(refreshSoon, 5000); return; } // 没连上：保持原样，稍后再读
  if (!r.user) return location.replace(AS ? '/kp' : '/');
  // 不是已审核的人类（仿生人、KP 退回修改、换了账号）：回到普通终端，由它再分流
  if (!d.ok || r.user.role !== 'player' || r.user.status !== 'approved' || !(r.user.ho === 'HO1' || r.user.ho === 'HO3')) return location.replace('/terminal' + location.search);
  if (meta) fields = meta.fields || [];
  me = r.user; desk = d; sessionT = r.sessionT || 0;
  entries = ent.ok ? ent : { entries: [], locked: [] };
  messages = msg.messages || [];
  if (!booted) { booted = true; maybeBoot(); }
  render();
}
let booted = false;

function render() {
  document.title = desk.name;
  if (PREVIEW) $('#pv').innerHTML = `<div class="preview-bar">预览：${esc(me.username)}（${esc(me.ho)}）看到的画面 · 只读</div>`;
  const unread = messages.filter(m => !m.read).length;
  $('#icons').innerHTML = APPS.map(a => `<div class="ico" tabindex="0" data-app="${a.id}">${I[a.id]}<span>${esc(a.name)}</span>` +
    (a.id === 'mail' && unread ? `<span class="badge">${unread}</span>` : '') + '</div>').join('');
  $('#smname').textContent = me.sheet.name;
  $('#smsub').textContent = `${me.ho} · ${me.username}${me.test ? ' · 测试' : ''}`;
  $('#smav').textContent = me.sheet.name.slice(0, 1);
  $('#smapps').innerHTML = APPS.map(a => `<div class="sma" data-app="${a.id}">${I[a.id]}<span>${esc(a.name)}</span></div>`).join('');
  for (const id of Object.keys(W)) renderWin(id);
  if (!PREVIEW) showNextUnread();
  renderLive();
}

// ---------- 远程监视：有人在运行程序、自己在观战名单里时，右下角弹出通知，托盘里留一个图标 ----------
const liveSeen = new Set();
function renderLive() {
  const list = desk.lives || [], tray = $('#livetray'), toast = $('#livetoast');
  tray.hidden = !list.length;
  if (!list.length) { toast.hidden = true; return; }
  const html = '<div class="lh"><span>远程监视</span><button type="button" data-close title="关闭">×</button></div>' +
    list.map(L => `<div class="li"><span><b>${esc(L.ho)}</b> 正在运行 ${esc(L.gameName)}</span><a href="${esc(L.url)}" target="_blank" rel="noopener">观看</a></div>`).join('');
  if (toast.innerHTML !== html) toast.innerHTML = html;
  // 新出现的局才自动弹出；关掉后点托盘图标还能再打开
  if (list.some(L => !liveSeen.has(L.attempt))) toast.hidden = false;
  for (const L of list) liveSeen.add(L.attempt);
}
document.addEventListener('click', e => {
  if (e.target.closest('#livetray')) { $('#livetoast').hidden = !$('#livetoast').hidden; return; }
  if (e.target.closest('#livetoast [data-close]')) $('#livetoast').hidden = true;
});

// ---------- 窗口 ----------
const W = {}; // id -> {el, tk, min}
let zTop = 10, cascade = 0;
function appOf(id) {
  if (!id.startsWith('file:')) return APPS.find(a => a.id === id);
  const t = desk.trash.find(x => 'file:' + x.id === id);
  return t ? { id, name: t.title, w: 520, h: 380 } : null; // 文件被隐藏或删除时返回空，窗口会关掉
}
function iconOf(id) { return id.startsWith('file:') ? I.file : I[id]; }

function openApp(id) {
  closeStart();
  const a = appOf(id);
  if (!a) return;
  if (a.link) { window.open(a.link, '_blank', 'noopener'); return; }
  if (W[id]) { W[id].min = false; W[id].el.hidden = false; focusWin(id); return; }
  const el = document.createElement('div');
  el.className = 'win'; el.dataset.win = id;
  const area = $('#desktop').getBoundingClientRect();
  const w = Math.min(a.w, area.width - 20), h = Math.min(a.h, area.height - 20);
  const off = (cascade++ % 6) * 26;
  el.style.left = Math.max(0, Math.min(area.width - w, 110 + off)) + 'px';
  el.style.top = Math.max(0, Math.min(area.height - h, 30 + off)) + 'px';
  el.style.width = w + 'px'; el.style.height = h + 'px';
  el.innerHTML = `<div class="tbar"><span class="ttl">${iconOf(id)}<span class="tt"></span></span>
    <button class="mn" title="最小化">&#x2014;</button><button class="mx" title="最大化">&#x2610;</button><button class="x" title="关闭">&#x2715;</button></div>
    <div class="wbody"></div>`;
  $('#wins').appendChild(el);
  const tk = document.createElement('button');
  tk.className = 'tk'; tk.dataset.tk = id;
  tk.innerHTML = iconOf(id) + '<span></span>';
  $('#tasks').appendChild(tk);
  W[id] = { el, tk, min: false };
  renderWin(id);
  focusWin(id);
}
function focusWin(id) {
  for (const [k, w] of Object.entries(W)) { w.el.classList.toggle('active', k === id && !w.min); w.tk.classList.toggle('on', k === id && !w.min); }
  if (W[id]) W[id].el.style.zIndex = ++zTop;
}
function closeWin(id) {
  const w = W[id];
  if (!w) return;
  if (id === 'notepad') flushNotes();
  w.el.remove(); w.tk.remove(); delete W[id];
}
function minWin(id) { const w = W[id]; w.min = true; w.el.hidden = true; w.el.classList.remove('active'); w.tk.classList.remove('on'); }

function renderWin(id) {
  const w = W[id];
  if (!w) return;
  const a = appOf(id);
  if (!a) return closeWin(id); // 例如回收站文件被 KP 隐藏或删除
  $('.tt', w.el).textContent = a.name;
  $('span', w.tk).textContent = a.name;
  const body = $('.wbody', w.el);
  if (id === 'mail') renderMail(body);
  else if (id === 'profile') renderProfile(body);
  else if (id === 'programs') renderPrograms(body);
  else if (id === 'notepad') renderNotepad(body);
  else if (id === 'trash') renderTrash(body);
  else if (id.startsWith('file:')) {
    const t = desk.trash.find(x => 'file:' + x.id === id);
    body.innerHTML = `<div class="fileview">${esc(t.body) || '<span class="dim">（空文件）</span>'}</div>`;
  }
}

// 拖动窗口（电脑上）
let drag = null;
document.addEventListener('pointerdown', e => {
  const win = e.target.closest('.win');
  if (win) focusWin(win.dataset.win);
  const bar = e.target.closest('.tbar');
  if (!bar || e.target.closest('button') || mobile() || win.classList.contains('max')) return;
  const r = win.getBoundingClientRect(), area = $('#desktop').getBoundingClientRect();
  drag = { win, dx: e.clientX - r.left, dy: e.clientY - r.top, area };
  bar.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove', e => {
  if (!drag) return;
  const { win, dx, dy, area } = drag;
  const x = Math.max(-win.offsetWidth + 80, Math.min(area.width - 80, e.clientX - area.left - dx));
  const y = Math.max(0, Math.min(area.height - 32, e.clientY - area.top - dy));
  win.style.left = x + 'px'; win.style.top = y + 'px';
});
document.addEventListener('pointerup', () => { drag = null; });
document.addEventListener('dblclick', e => {
  const bar = e.target.closest('.tbar');
  if (bar && !e.target.closest('button')) bar.parentElement.classList.toggle('max');
});

// ---------- 各程序 ----------
let mailSel = null;
function renderMail(body) {
  if (!messages.length) { body.innerHTML = '<div class="empty">收件箱是空的。</div>'; return; }
  if (!messages.find(m => m.id === mailSel)) mailSel = messages[0].id;
  const m = messages.find(x => x.id === mailSel);
  body.innerHTML = `<div class="mail"><div class="mlist"><div class="hd">收件箱</div>` + messages.map(x =>
    `<div class="mi ${x.read ? '' : 'unread'} ${x.id === mailSel ? 'on' : ''}" data-mail="${esc(x.id)}"><div>${esc(x.title)}</div><div class="t">${fmtTime(x.t)}</div></div>`).join('') +
    `</div><div class="mread"><h3>${esc(m.title)}</h3><div class="from">${fmtTime(m.t)} · 发件人：系统</div><div class="body">${esc(m.body)}</div></div></div>`;
}
function renderProfile(body) {
  const s = me.sheet;
  const rows = [['职员编号', me.ho], ['身份', me.kind], ['账号', me.username], ['体力（HP）', `${me.hpNow} / ${s.hp}`]]
    .concat(fields.filter(f => f.key !== 'hp').map(f => [f.label, s[f.key]]));
  body.innerHTML = `<div class="prof"><div class="top"><span class="avatar">${esc(s.name.slice(0, 1))}</span><div><b style="font-size:17px">${esc(s.name)}</b>
    <div class="dim" style="font-size:12px">警察厅 · 职员档案（只读）</div></div></div>
    <table>${rows.map(([k, v]) => `<tr><td class="dim">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table></div>`;
}
function renderPrograms(body) {
  const open = (entries.entries || []).map(e => `<div class="fi" data-prog="${esc(e.url)}" title="${esc(e.desc)}">${I.exe}${esc(e.name)}${e.desc ? `<span class="desc">${esc(e.desc)}</span>` : ''}</div>`).join('');
  const locked = (entries.locked || []).map(e => `<div class="fi locked" data-locked>${I.exe}<svg class="lk" viewBox="0 0 24 24">${I.lock.slice(I.lock.indexOf('>') + 1)}${esc(e.name)}</div>`).join('');
  const other = `<div class="fi locked" data-locked data-other>${I.programs}其他程序</div>`;
  const n = (entries.entries || []).length;
  body.innerHTML = `<div class="folder">${open}${locked}${other}</div><div class="status">${n} 个可用程序${touch() ? '，点一下启动' : '，双击启动'}</div>`;
}
function renderTrash(body) {
  const seen = trashSeen();
  body.innerHTML = desk.trash.length
    ? `<div class="folder">${desk.trash.map(t => `<div class="fi" data-file="${esc(t.id)}">${I.file}${esc(t.title)}${!PREVIEW && !(seen[t.id] >= t.updatedAt) ? '<span class="new">新</span>' : ''}</div>`).join('')}</div>
       <div class="status">${desk.trash.length} 个项目</div>`
    : '<div class="empty">回收站是空的。</div>';
}

// 回收站的“新”标记记在浏览器里
function trashSeen() { try { return JSON.parse(localStorage.getItem('void_trash_seen_' + me.id) || '{}'); } catch { return {}; } }
function markTrash(t) {
  if (PREVIEW) return;
  const m = trashSeen(); m[t.id] = t.updatedAt;
  try { localStorage.setItem('void_trash_seen_' + me.id, JSON.stringify(m)); } catch {}
}

// 记事本：输入后 0.8 秒自动保存到服务器
let noteTimer = null, noteDirty = false, noteSaving = null;
function renderNotepad(body) {
  let ta = $('textarea', body);
  if (!ta) {
    body.innerHTML = `<div class="np"><div class="menu"><span>文件</span><span>编辑</span><span>格式</span></div>
      <textarea spellcheck="false" ${PREVIEW ? 'readonly' : ''} placeholder="${PREVIEW ? '' : '在这里记笔记。自动保存，只有你和 KP 能看到。'}"></textarea>
      <div class="status" id="npst"></div></div>`;
    ta = $('textarea', body);
    ta.value = desk.notes;
    ta.addEventListener('input', () => { noteDirty = true; $('#npst').textContent = '正在编辑…'; clearTimeout(noteTimer); noteTimer = setTimeout(flushNotes, 800); });
    ta.addEventListener('blur', flushNotes);
    noteStatus();
    return;
  }
  // 推送刷新：没在编辑时才用服务器上的内容（例如另一台设备改过）
  if (!noteDirty && document.activeElement !== ta && ta.value !== desk.notes) ta.value = desk.notes;
}
function noteStatus(msg) {
  const st = $('#npst');
  if (!st) return;
  st.textContent = msg || (PREVIEW ? '预览：只读' : desk.notesAt ? `已保存 ${fmtTime(desk.notesAt)}` : '自动保存');
}
async function flushNotes() {
  clearTimeout(noteTimer);
  if (PREVIEW || !noteDirty || !W.notepad) return;
  const text = $('textarea', W.notepad.el).value;
  noteDirty = false;
  noteStatus('正在保存…');
  noteSaving = api('/api/notes', { text });
  const r = await noteSaving;
  if (r.ok) { desk.notes = text; desk.notesAt = r.t; noteStatus(); }
  else { noteDirty = true; noteStatus('保存失败：' + (r.error || '') + '，稍后自动重试'); noteTimer = setTimeout(flushNotes, 3000); }
}
window.addEventListener('pagehide', () => {
  if (noteDirty && W.notepad) fetch('/api/notes', { method: 'POST', keepalive: true, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Void': '1' }, body: JSON.stringify({ text: $('textarea', W.notepad.el).value }) });
});

// ---------- 对话框 ----------
function msgbox(title, text) {
  $('#modal').innerHTML = `<div class="modal-bg"><div class="modal"><div class="kicker">${esc(desk.name)}</div>
    <h2>${esc(title)}</h2><div class="body">${esc(text)}</div><div class="row"><button class="primary" id="mbok">确定</button></div></div></div>`;
  $('#mbok').addEventListener('click', () => { $('#modal').innerHTML = ''; showing = false; showNextUnread(); });
  showing = true;
}
// 未读邮件：一封一封弹出，点“确认”才关闭
let showing = false;
function showNextUnread() {
  if (showing || bootOn) return;
  const m = messages.slice().reverse().find(x => !x.read);
  if (!m) return;
  showing = true;
  beep();
  $('#modal').innerHTML = `<div class="modal-bg"><div class="modal">
    <div class="kicker">新邮件 · ${fmtTime(m.t)}</div>
    <h2>${esc(m.title)}</h2><div class="body">${esc(m.body)}</div>
    <div class="row"><button class="primary" id="ack">确认</button></div></div></div>`;
  $('#ack').addEventListener('click', async () => {
    await api('/api/messages/read', { id: m.id });
    m.read = true; mailSel = m.id;
    $('#modal').innerHTML = '';
    showing = false;
    render();
  });
}

// ---------- 点击 ----------
let selIco = null;
document.addEventListener('click', e => {
  if (!e.target.closest('#startmenu') && !e.target.closest('#startbtn')) closeStart();
  const ico = e.target.closest('.ico');
  if (ico) {
    for (const x of $$('.ico')) x.classList.toggle('sel', x === ico);
    if (touch()) openApp(ico.dataset.app);
    return;
  }
  if (!e.target.closest('.win')) for (const x of $$('.ico.sel')) x.classList.remove('sel');
  const sma = e.target.closest('.sma');
  if (sma) return openApp(sma.dataset.app);
  const tk = e.target.closest('.tk');
  if (tk) {
    const id = tk.dataset.tk, w = W[id];
    if (w.min) { w.min = false; w.el.hidden = false; focusWin(id); }
    else if (w.el.classList.contains('active')) minWin(id);
    else focusWin(id);
    return;
  }
  const win = e.target.closest('.win');
  if (win) {
    const id = win.dataset.win;
    if (e.target.closest('.tbar .x')) return closeWin(id);
    if (e.target.closest('.tbar .mn')) return minWin(id);
    if (e.target.closest('.tbar .mx')) return win.classList.toggle('max');
    const mi = e.target.closest('[data-mail]');
    if (mi) { mailSel = mi.dataset.mail; return renderWin('mail'); }
    const fi = e.target.closest('.fi');
    if (fi) {
      for (const x of $$('.fi', win)) x.classList.toggle('sel', x === fi);
      if (fi.hasAttribute('data-locked')) return msgbox('权限不足', fi.hasAttribute('data-other') ? '你没有访问这些程序的权限。' : '你没有运行这个程序的权限。请联系管理员。');
      if (touch()) activateFile(fi);
    }
  }
});
document.addEventListener('dblclick', e => {
  const ico = e.target.closest('.ico');
  if (ico) return openApp(ico.dataset.app);
  const fi = e.target.closest('.fi');
  if (fi && !fi.hasAttribute('data-locked')) activateFile(fi);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('ico')) openApp(e.target.dataset.app);
  if (e.key === 'Escape') closeStart();
});
function activateFile(fi) {
  if (fi.dataset.prog) {
    if (PREVIEW) return msgbox('预览', '预览中不能启动程序。');
    window.open(fi.dataset.prog, '_blank', 'noopener');
  } else if (fi.dataset.file) {
    const t = desk.trash.find(x => x.id === fi.dataset.file);
    if (t) { markTrash(t); openApp('file:' + t.id); renderWin('trash'); }
  }
}

// 显示桌面：全部最小化（手机上窗口是全屏的，靠它回到桌面）
$('#showdesk').addEventListener('click', () => { closeStart(); for (const id of Object.keys(W)) minWin(id); });

// ---------- 开始菜单 ----------
function closeStart() { $('#startmenu').hidden = true; $('#startbtn').classList.remove('on'); }
$('#startbtn').addEventListener('click', () => {
  const sm = $('#startmenu');
  sm.hidden = !sm.hidden;
  $('#startbtn').classList.toggle('on', !sm.hidden);
});
if (PREVIEW) { $('#out').textContent = '返回控制台'; $('#out').addEventListener('click', () => { location.href = '/kp'; }); }
else $('#out').addEventListener('click', async () => { await flushNotes(); logout(); });

const LOW_KEY = 'void_desk_low';
let low = false;
try { low = localStorage.getItem(LOW_KEY) === '1'; } catch {}
function setLow(v) { low = v; document.body.classList.toggle('low', v); $('#lowbtn').textContent = '简化特效：' + (v ? '开' : '关'); }
setLow(low);
$('#lowbtn').addEventListener('click', () => { setLow(!low); try { localStorage.setItem(LOW_KEY, low ? '1' : '0'); } catch {} });

// ---------- 声音 ----------
let actx = null;
function beep() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t0 = actx.currentTime;
    for (const [dt, f] of [[0, 1046], [0.12, 1568]]) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + dt + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.35);
      o.connect(g).connect(actx.destination);
      o.start(t0 + dt); o.stop(t0 + dt + 0.4);
    }
    if (navigator.vibrate) navigator.vibrate(80);
  } catch {}
}
document.addEventListener('pointerdown', () => { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch {} }, { once: true });

// ---------- 开机（每次登录只播一次，预览不播） ----------
let bootOn = false;
function maybeBoot() {
  if (PREVIEW) return;
  const key = 'void_boot_' + me.id;
  let last = null;
  try { last = localStorage.getItem(key); } catch {}
  if (last === String(sessionT)) return;
  try { localStorage.setItem(key, String(sessionT)); } catch {}
  bootOn = true;
  const box = $('#boot');
  box.innerHTML = `${$('.mark svg').outerHTML}<div class="nm">${esc(desk.name)}</div>
    <div class="dots"><i></i><i></i><i></i><i></i><i></i></div><div class="msg2">正在登录 ${esc(me.sheet.name)}</div><div class="skip">点击跳过</div>`;
  box.hidden = false;
  const t = setTimeout(end, 2600);
  function end() {
    clearTimeout(t);
    if (!bootOn) return;
    bootOn = false;
    box.hidden = true; box.innerHTML = '';
    showNextUnread();
  }
  box.addEventListener('click', end, { once: true });
}

// ---------- 蓝屏（KP 触发的界面故障） ----------
let bsodOn = false;
function bsod(d) {
  if (bsodOn) return;
  bsodOn = true;
  const box = $('#bsod');
  box.innerHTML = `<div class="sad">:(</div><div>你的电脑遇到问题，需要重新启动。</div><div>我们只收集某些错误信息，然后为你重新启动。</div>
    <div class="pc"><span id="bpc">0</span>% 完成</div><div class="code">终止代码：${esc(d.text || 'CRITICAL_PROCESS_DIED')}</div>`;
  box.hidden = false;
  const t0 = performance.now();
  const iv = setInterval(() => { const p = $('#bpc'); if (p) p.textContent = Math.min(100, Math.round((performance.now() - t0) / 3000 * 100)); }, 150);
  setTimeout(() => { clearInterval(iv); box.hidden = true; box.innerHTML = ''; bsodOn = false; }, 3000);
}

// ---------- 时钟、推送 ----------
function tick() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  $('#ctime').textContent = `${p(d.getHours())}:${p(d.getMinutes())}`;
  $('#cdate').textContent = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
setInterval(tick, 5000); tick();
function linkState(on) { const l = $('#link'); l.classList.toggle('off', !on); l.title = on ? '已连接' : '网络已断开'; }
let timer = null;
function refreshSoon() { clearTimeout(timer); timer = setTimeout(load, 150); }

// 手机浏览器锁屏、切到别的应用时推送连接会断，自动重连后中间的推送就丢了。
// 所以：重连成功、页面回到前台时重新读取一次；页面看得见时每 30 秒再兜底读一次。
let esOpened = false;
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshSoon(); });
setInterval(() => { if (document.visibilityState === 'visible') refreshSoon(); }, 30000);
function connect() {
  const es = new EventSource(PREVIEW ? '/api/events?kp=1' : '/api/events');
  es.onopen = () => { linkState(true); if (esOpened) refreshSoon(); esOpened = true; };
  es.addEventListener('refresh', refreshSoon);
  es.addEventListener('message', refreshSoon);
  es.addEventListener('state', ev => { // 预览模式下收到的是 KP 的推送；记事本保存这种只和 KP 有关的不用刷新
    let what = ''; try { what = JSON.parse(ev.data).what; } catch {}
    if (what !== 'presence') refreshSoon();
  });
  es.addEventListener('glitch', ev => { try { bsod(JSON.parse(ev.data)); } catch {} });
  es.addEventListener('logout', () => { es.close(); if (!PREVIEW) location.replace('/'); });
  es.onerror = () => {
    linkState(false);
    if (es.readyState === EventSource.CLOSED) setTimeout(() => load().then(connect), 5000);
  };
}
// 第一次读取没连上时 5 秒后重试，读到了再开始推送连接
function start() { load().then(() => { if (me) connect(); else setTimeout(start, 5000); }); }
start();
