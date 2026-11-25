// 仿生人 HUD（HO2、HO4）。数据来自 /api/me、/api/hud、/api/entries、/api/messages，服务器推送后重新读取。
'use strict';
const AS = new URLSearchParams(location.search).get('as'); // KP 预览：只读
const Q = AS ? '?as=' + encodeURIComponent(AS) : '';
const PREVIEW = !!AS;

// 伤情档对应的体征范围：心率、血压（收缩/舒张）、呼吸
const TIERS = [
  { name: '无伤', hr: [65, 80], bp: [115, 75], rr: [14, 16] },
  { name: '轻伤', hr: [85, 100], bp: [125, 85], rr: [18, 20] },
  { name: '重伤', hr: [110, 130], bp: [95, 60], rr: [24, 28] },
  { name: '濒死', hr: [40, 50], bp: [70, 40], rr: [6, 8] },
];

let me = null, hud = null, fields = [], messages = [], entries = { entries: [], locked: [] };
let sessionT = 0;
const openMsgs = new Set();

// ---------- 简化特效 ----------
const LOW_KEY = 'void_hud_low';
let lowManual = null;
try { const v = localStorage.getItem(LOW_KEY); if (v !== null) lowManual = v === '1'; } catch {}
let low = lowManual === true;
function setLow(v, manual) {
  low = v;
  document.body.classList.toggle('low', v);
  $('#lowbtn').classList.toggle('on', v);
  if (manual) { lowManual = v; try { localStorage.setItem(LOW_KEY, v ? '1' : '0'); } catch {} }
}
$('#lowbtn').addEventListener('click', e => { e.preventDefault(); setLow(!low, true); });
setLow(low, false);
$('#out').addEventListener('click', e => { e.preventDefault(); logout(); });

// ---------- 读取 ----------
async function load() {
  const [r, h, ent, msg, meta] = await Promise.all([
    api('/api/me' + Q), api('/api/hud' + Q), api('/api/entries' + Q), api('/api/messages' + Q),
    fields.length ? null : api('/api/meta'),
  ]);
  if (!r.user) return location.replace(AS ? '/kp' : '/');
  // 不是已审核的仿生人（人类、KP 退回修改、换了账号）：回到普通终端
  if (!h.ok || r.user.role !== 'player' || r.user.status !== 'approved' || !(r.user.ho === 'HO2' || r.user.ho === 'HO4')) return location.replace('/terminal' + location.search);
  if (meta) fields = meta.fields || [];
  me = r.user; hud = h; sessionT = r.sessionT || 0;
  entries = ent.ok ? ent : { entries: [], locked: [] };
  messages = msg.messages || [];
  if (!booted) { booted = true; maybeBoot(); }
  render();
}
let booted = false;
function setText(sel, t) { const el = $(sel); delete el.dataset.orig; el.textContent = t; }

function render() {
  const cls = 'c-' + hud.color;
  document.body.classList.remove('c-cyan', 'c-amber', 'c-green');
  document.body.classList.add(cls);
  document.body.classList.toggle('old', me.ho === 'HO4');
  colors = null;
  setText('#model', hud.model || (me.ho === 'HO2' ? '新型机' : '旧型机'));
  setText('#nm', me.sheet.name + (me.test ? ' · 测试' : ''));
  if (PREVIEW) {
    $('#pv').innerHTML = `<div class="preview-bar">预览：${esc(me.username)}（${esc(me.ho)}）看到的画面 · 只读</div>`;
    $('#nav').innerHTML = '<a href="/kp">返回控制台</a>';
  }
  renderPartner(); renderScan(); renderProgs(); renderMsgs(); renderSelf();
  if (!PREVIEW) showNextUnread();
}

// ---------- 搭档体征 ----------
const V = { hr: 72, sys: 115, dia: 75, rr: 15, tgt: null };
function rnd(a, b) { return a + Math.random() * (b - a); }
function newTargets() {
  const p = hud && hud.partner;
  if (!p || !p.connected) return;
  const t = TIERS[p.tier];
  V.tgt = { hr: rnd(t.hr[0], t.hr[1]), sys: t.bp[0] + rnd(-4, 4), dia: t.bp[1] + rnd(-3, 3), rr: rnd(t.rr[0], t.rr[1]) };
}
function renderPartner() {
  const p = hud.partner;
  const tier = $('#tier');
  if (!p.connected) {
    setText('#pname', `${p.ho} · 未连接`);
    tier.className = 'tier gl none'; setText('#tier', 'NO LINK');
    for (const k of ['hr', 'bp', 'rr']) { $('#v-' + k).textContent = '--'; $('#v-' + k).classList.remove('ov'); }
    return;
  }
  setText('#pname', `${p.ho} · ${p.name}`);
  tier.className = 'tier gl t' + p.tier; setText('#tier', TIERS[p.tier].name);
  if (!V.tgt || V.tier !== p.tier) { V.tier = p.tier; newTargets(); Object.assign(V, { hr: V.tgt.hr, sys: V.tgt.sys, dia: V.tgt.dia, rr: V.tgt.rr }); }
  showVitals();
}
function showVitals() {
  const p = hud && hud.partner;
  if (!p || !p.connected) return;
  const ov = p.vitals || {};
  const set = (k, auto) => {
    const el = $('#v-' + k), o = ov[k];
    el.textContent = o !== null && o !== undefined ? o : auto;
    el.classList.toggle('ov', o !== null && o !== undefined);
  };
  set('hr', Math.round(V.hr)); set('bp', `${Math.round(V.sys)}/${Math.round(V.dia)}`); set('rr', Math.round(V.rr));
}
// 数值每 2 秒换一个目标，慢慢靠过去
setInterval(newTargets, 2000);
setInterval(() => {
  if (!V.tgt) return;
  for (const k of ['hr', 'sys', 'dia', 'rr']) V[k] += (V.tgt[k] - V[k]) * 0.25;
  showVitals();
}, 500);
function currentHr() {
  const p = hud && hud.partner;
  if (!p || !p.connected) return 0;
  const o = p.vitals && p.vitals.hr;
  return o !== null && o !== undefined ? o : V.hr;
}

// 心电图：从左往右画，前方擦出一段空白，像监护仪那样
const ecg = $('#ecg'), ctx = ecg.getContext('2d');
let EW = 0, EH = 0, ex = 0, ey = null, simT = 0, beatStart = -10, nextBeat = 0;
function sizeEcg() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  EW = ecg.clientWidth; EH = ecg.clientHeight;
  ecg.width = Math.round(EW * dpr); ecg.height = Math.round(EH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, EW, EH); ex = 0; ey = null;
}
// 只在宽度变化时重画（手机滚动时地址栏收起也会触发 resize）
window.addEventListener('resize', () => { if (ecg.clientWidth !== EW || ecg.clientHeight !== EH) sizeEcg(); });
function beatShape(t, amp) {
  // t：距离这一拍开始的秒数
  let y = 0;
  if (t > 0.04 && t < 0.12) y = 0.1 * Math.sin((t - 0.04) / 0.08 * Math.PI);
  else if (t >= 0.16 && t < 0.18) y = -0.15 * (t - 0.16) / 0.02;
  else if (t >= 0.18 && t < 0.205) y = -0.15 + 1.15 * (t - 0.18) / 0.025;
  else if (t >= 0.205 && t < 0.235) y = 1 - 1.3 * (t - 0.205) / 0.03;
  else if (t >= 0.235 && t < 0.26) y = -0.3 + 0.3 * (t - 0.235) / 0.025;
  else if (t > 0.34 && t < 0.5) y = 0.25 * Math.sin((t - 0.34) / 0.16 * Math.PI);
  return y * amp;
}
let colors = null;
let lastFrame = 0, perfAcc = 0, perfN = 0, perfT = 0, skip = false;
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = lastFrame ? Math.min(0.1, (ts - lastFrame) / 1000) : 0.016;
  lastFrame = ts;
  // 卡顿检测：特效开着时，平均帧耗时超过 30ms 持续 1 秒，自动切简化特效
  if (!low && lowManual === null && !document.hidden) {
    perfAcc += dt; perfN++; perfT += dt;
    if (perfT >= 1) { if (perfAcc / perfN > 0.03) setLow(true, false); perfAcc = perfN = perfT = 0; }
  }
  if (low) { skip = !skip; if (skip) { simT += dt; return; } }
  if (!EW) sizeEcg();
  if (!EW) return;
  const p = hud && hud.partner, on = !!(p && p.connected);
  const speed = 70; // 像素/秒
  if (!colors) { const css = getComputedStyle(document.body); colors = { fg: css.getPropertyValue('--fg'), dim: css.getPropertyValue('--dim') }; }
  ctx.strokeStyle = on ? colors.fg : colors.dim;
  ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
  const steps = Math.max(1, Math.round(dt * speed / 2));
  const stepT = dt / steps;
  const mid = EH * 0.58, amp = EH * 0.42;
  ctx.beginPath();
  if (ey !== null) ctx.moveTo(ex, ey);
  for (let i = 0; i < steps; i++) {
    simT += stepT;
    let y = 0;
    const hr = currentHr();
    if (on && hr > 0) {
      if (simT >= nextBeat) {
        beatStart = simT;
        let iv = 60 / hr;
        if (p.tier === 3) iv *= rnd(0.7, 1.5); // 濒死：不规则
        nextBeat = simT + iv;
      }
      y = beatShape(simT - beatStart, p.tier === 3 ? 0.55 : 1) + rnd(-0.015, 0.015);
    } else y = rnd(-0.01, 0.01);
    const nx = ex + 2, ny = mid - y * amp;
    if (ey === null) ctx.moveTo(ex, ny); else ctx.lineTo(nx, ny);
    ex = nx; ey = ny;
    if (ex > EW) { ctx.stroke(); ctx.beginPath(); ex = 0; ey = null; }
  }
  ctx.stroke();
  ctx.clearRect(ex + 1, 0, 14, EH);
}
requestAnimationFrame(frame);

// ---------- 扫描 ----------
let scanned = false, scanning = false, scannedIds = new Set(), ambientLine = '';
const openScans = new Set();
const SEEN_KEY = () => 'void_scan_seen_' + me.id;
function seenMap() { try { return JSON.parse(localStorage.getItem(SEEN_KEY()) || '{}'); } catch { return {}; } }
function markSeen(s) {
  if (PREVIEW) return;
  const m = seenMap(); m[s.id] = s.updatedAt;
  try { localStorage.setItem(SEEN_KEY(), JSON.stringify(m)); } catch {}
}
$('#scanbtn').addEventListener('click', () => {
  if (scanning) return;
  scanning = true;
  $('#scanout').innerHTML = '<div class="scanning"><div class="beam"></div><div class="pc" id="pc">SCANNING 0%</div></div>';
  const t0 = performance.now(), dur = 1300;
  const iv = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / dur);
    const pc = $('#pc'); if (pc) pc.textContent = `SCANNING ${Math.round(k * 100)}%`;
    if (k >= 1) {
      clearInterval(iv);
      scanning = false; scanned = true;
      scannedIds = new Set(hud.scans.map(s => s.id));
      const pool = hud.ambient && hud.ambient.length ? hud.ambient : ['未检测到威胁。'];
      ambientLine = pool[Math.floor(Math.random() * pool.length)];
      renderScan();
    }
  }, 60);
});
function renderScan() {
  // 被隐藏的条目从“已扫描”里去掉：再开放时要重新扫描
  const openIds = new Set(hud.scans.map(s => s.id));
  for (const id of scannedIds) if (!openIds.has(id)) scannedIds.delete(id);
  const newer = hud.scans.some(s => !scannedIds.has(s.id));
  $('#newdata').hidden = !newer;
  if (scanning) return;
  if (!scanned) { $('#scanout').innerHTML = '<div class="hint">点击“扫描”读取周边数据。</div>'; return; }
  const seen = seenMap();
  const list = hud.scans.filter(s => scannedIds.has(s.id));
  if (!list.length) {
    const p = hud.partner;
    const ps = p.connected ? `搭档 ${p.name}：${TIERS[p.tier].name}，心率 ${Math.round(currentHr())}。` : '搭档链路未连接。';
    $('#scanout').innerHTML = `<div class="ambient"><div class="gl">${esc(ambientLine)}</div><div class="p">${esc(ps)}</div></div>`;
    return;
  }
  $('#scanout').innerHTML = list.map(s => {
    const isNew = !PREVIEW && !(seen[s.id] >= s.updatedAt);
    return `<div class="sitem ${openScans.has(s.id) ? 'open' : ''}" data-sid="${esc(s.id)}">
      <div class="h"><span class="gl">${esc(s.title)}</span>${isNew ? '<span class="new">新</span>' : ''}</div>
      <div class="d">${esc(s.lines) || '<span class="dim">（无数据）</span>'}</div></div>`;
  }).join('');
}

// ---------- 程序、通讯、机体参数 ----------
function renderProgs() {
  const progs = (entries.entries || []).map(e =>
    `<div class="prog"><span>${esc(e.name)}${e.desc ? `<span class="desc">${esc(e.desc)}</span>` : ''}</span>` +
    (PREVIEW ? '<span class="tag">可启动</span>' : `<a class="btn small" href="${esc(e.url)}" target="_blank" rel="noopener">启动</a>`) + '</div>').join('');
  const locked = (entries.locked || []).map(e =>
    `<div class="prog locked" data-locked><span>${esc(e.name)}</span><span>LOCKED</span></div>`).join('');
  $('#progs').innerHTML = (progs || locked ? progs + locked : '<div class="dim" style="margin-bottom:8px">暂无可用程序。</div>') +
    '<div class="prog locked" style="cursor:default"><span>其他程序</span><span>ACCESS DENIED · 权限不足</span></div>';
}
function renderMsgs() {
  $('#msgs').innerHTML = messages.length ? messages.map(m =>
    `<div class="msgitem ${m.read ? '' : 'unread'} ${openMsgs.has(m.id) ? 'open' : ''}" data-mid="${esc(m.id)}">
      <div class="t">${fmtTime(m.t)}${m.read ? '' : ' · 未读'}</div><div>${esc(m.title)}</div><div class="body">${esc(m.body)}</div></div>`).join('')
    : '<div class="dim">无通讯记录。</div>';
}
function renderSelf() {
  const s = me.sheet;
  const rows = [['识别名', s.name], ['型号', hud.model || '—'], ['编号', me.ho], ['种类', me.kind], ['机体耐久（HP）', `${me.hpNow} / ${s.hp}`]]
    .concat(fields.filter(f => f.key !== 'hp').map(f => [f.label, s[f.key]]));
  $('#self').innerHTML = '<table class="selft">' + rows.map(([k, v]) => `<tr><td class="dim">${esc(k)}</td><td class="gl">${esc(v)}</td></tr>`).join('') + '</table>';
}

document.addEventListener('click', e => {
  const si = e.target.closest('.sitem');
  if (si) {
    const id = si.dataset.sid;
    if (openScans.has(id)) openScans.delete(id); else { openScans.add(id); const s = hud.scans.find(x => x.id === id); if (s) markSeen(s); }
    return renderScan();
  }
  const it = e.target.closest('.msgitem');
  if (it) { const id = it.dataset.mid; openMsgs.has(id) ? openMsgs.delete(id) : openMsgs.add(id); return renderMsgs(); }
  if (e.target.closest('[data-locked]')) say('#lm', '权限不足。');
});

// 未读消息：一条一条弹出，点“确认”才关闭
let showing = false;
function showNextUnread() {
  if (showing || bootOn) return;
  const m = messages.slice().reverse().find(x => !x.read);
  if (!m) return;
  showing = true;
  beep();
  $('#modal').innerHTML = `<div class="modal-bg"><div class="modal">
    <div class="kicker">接收到加密通讯 · ${fmtTime(m.t)}</div>
    <h2>${esc(m.title)}</h2><div class="body">${esc(m.body)}</div>
    <div class="row"><button class="primary full" id="ack">确认</button></div></div></div>`;
  $('#ack').addEventListener('click', async () => {
    await api('/api/messages/read', { id: m.id });
    m.read = true;
    $('#modal').innerHTML = '';
    showing = false;
    renderMsgs();
    showNextUnread();
  });
}

// ---------- 声音 ----------
let actx = null;
function tone(seq, type = 'square', vol = 0.07) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const t0 = actx.currentTime;
    for (const [dt, f, len] of seq) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(vol, t0 + dt + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + len);
      o.connect(g).connect(actx.destination);
      o.start(t0 + dt); o.stop(t0 + dt + len + 0.02);
    }
  } catch {}
}
function beep() { tone([[0, 880, 0.11], [0.14, 1320, 0.11]]); if (navigator.vibrate) navigator.vibrate(80); }
document.addEventListener('pointerdown', () => { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch {} }, { once: true });

// ---------- 开机自检（每次登录只播一次，预览不播） ----------
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
  box.hidden = false;
  const p = hud.partner;
  const lines = [
    ['VOID UNIT OS  //  BOOT SEQUENCE', 'hi'],
    [`型号 ........ ${hud.model || (me.ho === 'HO2' ? '新型机' : '旧型机')}`],
    ['驱动系统 .... OK'],
    ['光学传感器 .. OK'],
    ['记忆堆栈 .... OK'],
    ['通讯模块 .... OK'],
    [`搭档链路 .... ${p.connected ? '已连接 ' + p.ho : '未连接'}`],
    [`识别名：${me.sheet.name}`, 'hi'],
  ];
  box.innerHTML = '<div id="bl"></div><div class="bar2"><i id="bb"></i></div><div class="skip">点击跳过</div>';
  let i = 0;
  const step = me.ho === 'HO4' ? 340 : 280;
  const iv = setInterval(() => {
    if (i < lines.length) {
      const [t, c] = lines[i++];
      $('#bl').insertAdjacentHTML('beforeend', `<div class="ln ${c || ''}">${esc(t)}</div>`);
      $('#bb').style.width = Math.round(i / lines.length * 100) + '%';
    } else end();
  }, step);
  function end() {
    clearInterval(iv);
    if (!bootOn) return;
    bootOn = false;
    box.hidden = true; box.innerHTML = '';
    showNextUnread();
  }
  box.addEventListener('click', end, { once: true });
}

// ---------- 旧型机的噪点和字符错位 ----------
const GLYPHS = '#%&@$*+=?!<>/\\|01アカサタナ░▒▓';
function scramble(el, n) {
  const t = el.textContent;
  if (!t || el.dataset.orig) return;
  el.dataset.orig = t;
  const arr = Array.from(t);
  for (let k = 0; k < n; k++) arr[Math.floor(Math.random() * arr.length)] = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  el.textContent = arr.join('');
}
function restore(el) { if (el.dataset.orig !== undefined) { el.textContent = el.dataset.orig; delete el.dataset.orig; } }
function oldNoise() {
  setTimeout(oldNoise, rnd(8000, 20000));
  if (!me || me.ho !== 'HO4' || low || document.hidden || bootOn) return;
  const els = $$('.gl').filter(x => x.offsetParent && x.textContent.trim());
  if (!els.length) return;
  const el = els[Math.floor(Math.random() * els.length)];
  scramble(el, 1 + Math.floor(Math.random() * 3));
  el.classList.add('jit');
  setTimeout(() => { restore(el); el.classList.remove('jit'); }, 140);
}
setTimeout(oldNoise, 9000);

// ---------- 界面故障（KP 触发） ----------
let glitchOn = false;
function glitch(d) {
  if (glitchOn) return;
  glitchOn = true;
  const text = d.text || '';
  const finish = () => {
    for (const el of $$('.gl')) restore(el);
    document.body.classList.remove('shake');
    $('#snow').hidden = true; $('#black').hidden = true; $('#gtext').hidden = true;
    glitchOn = false;
  };
  tone([[0, 90, 0.25], [0.05, 140, 0.3]], 'sawtooth', 0.05);
  if (d.effect === 'black') {
    $('#blackt').textContent = text;
    $('#black').hidden = false;
    setTimeout(finish, 3000);
    return;
  }
  // 雪花 + 错字，2 秒
  const c = $('#snow'), g = c.getContext('2d');
  c.width = 160; c.height = 100; c.hidden = false;
  if (text) { $('#gtext').textContent = text; $('#gtext').hidden = false; }
  if (!low) document.body.classList.add('shake');
  const img = g.createImageData(160, 100);
  const t0 = performance.now();
  (function snowFrame() {
    if (performance.now() - t0 > 2000) return finish();
    for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255 | 0; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0);
    for (const el of $$('.gl')) { restore(el); if (Math.random() < 0.5) scramble(el, 2 + Math.floor(Math.random() * 4)); }
    setTimeout(snowFrame, low ? 120 : 60);
  })();
}

// ---------- 时钟、推送 ----------
function tick() { const d = new Date(), p = n => String(n).padStart(2, '0'); $('#clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
setInterval(tick, 1000); tick();

function linkState(onl) {
  const l = $('#link');
  l.classList.toggle('off', !onl);
  l.textContent = onl ? '链路正常' : '信号中断';
}
let timer = null;
function refreshSoon() { clearTimeout(timer); timer = setTimeout(load, 150); }
function connect() {
  const es = new EventSource(PREVIEW ? '/api/events?kp=1' : '/api/events');
  es.onopen = () => linkState(true);
  es.addEventListener('refresh', refreshSoon);
  es.addEventListener('message', refreshSoon);
  es.addEventListener('state', refreshSoon); // 预览模式下收到的是 KP 的推送
  es.addEventListener('glitch', ev => { try { glitch(JSON.parse(ev.data)); } catch {} });
  es.addEventListener('logout', () => { es.close(); if (!PREVIEW) location.replace('/'); });
  es.onerror = () => {
    linkState(false);
    if (es.readyState === EventSource.CLOSED) setTimeout(() => load().then(connect), 5000);
  };
}
load().then(() => { if (me) connect(); });
