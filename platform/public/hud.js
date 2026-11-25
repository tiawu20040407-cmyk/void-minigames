// 仿生人 HUD（HO2、HO4）。数据来自 /api/me、/api/hud、/api/entries、/api/messages，服务器推送后重新读取。
// HO2 新型机：圆形主视野布局；HO4 旧型机：老式终端布局。两套布局的元素 id 相同，下面的逻辑共用。
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

let me = null, hud = null, fields = [], messages = [], entries = { entries: [], locked: [] }, sessionT = 0;
let OLD = false, built = null; // built：已生成的布局（'new' / 'old'）
const openMsgs = new Set();

// ---------- 简化特效 ----------
const LOW_KEY = 'void_hud_low';
let lowManual = null;
try { const v = localStorage.getItem(LOW_KEY); if (v !== null) lowManual = v === '1'; } catch {}
let low = lowManual === true;
function setLow(v, manual) {
  low = v;
  document.body.classList.toggle('low', v);
  const b = $('#lowbtn'); if (b) b.classList.toggle('on', v);
  if (manual) { lowManual = v; try { localStorage.setItem(LOW_KEY, v ? '1' : '0'); } catch {} }
  drawBg();
}

// ---------- 布局 ----------
const NAV = `<nav id="nav"><a href="/intranet">警察厅内网</a><a href="#" id="lowbtn">简化特效</a><a href="#" id="out">退出</a></nav>`;
const LAYOUT_NEW = {
  bar: `<span class="model gl" id="model"></span><span class="nm gl" id="nm"></span>
    <span class="seg"><i></i><i></i><i></i><i></i><i></i><i class="o"></i></span>
    <span class="clock" id="clock">--:--:--</span><span class="link gl" id="link">链路建立中</span>${NAV}`,
  main: `<div class="stage" id="stage"><svg id="wires"></svg>
    <div class="col">
      <div class="pn" id="p-scan"><h3>扫描 <small>SCAN</small></h3>
        <button class="scanbtn" id="scanbtn">扫 描</button><span class="newdata" id="newdata" hidden>检测到新数据</span>
        <div id="scanout"></div></div>
    </div>
    <div class="center">
      <div class="eye" id="eye"><svg viewBox="0 0 470 470" id="eyesvg"></svg>
        <div class="heart" id="heart"><svg viewBox="0 0 240 240" id="heartsvg"></svg></div>
        <div class="who gl" id="pname"></div>
        <div class="hr"><b class="gl" id="v-hr">--</b><span class="k">心率 BPM</span></div>
        <div class="bp"><b class="gl" id="v-bp">--</b><span class="k">血压 mmHg</span></div>
        <div class="rr"><b class="gl" id="v-rr">--</b><span class="k">呼吸 /min</span></div>
        <div class="tier gl" id="tier"></div>
      </div>
      <div class="ecg"><span class="lbl">ECG · LEAD II</span><canvas id="ecg"></canvas></div>
    </div>
    <div class="col">
      <div class="pn" id="p-prog"><h3>程序 <small>PROGRAMS</small></h3><div id="progs"></div><div class="msg" id="lm"></div></div>
      <div class="pn" id="p-comm"><h3>通讯记录 <small>COMMS</small></h3><div id="msgs"></div></div>
      <div class="pn" id="p-self"><h3>机体参数 <small>UNIT</small></h3><div id="self"></div></div>
    </div></div>`,
};
const LAYOUT_OLD = {
  bar: `<b class="model gl" id="model"></b><span class="dim">UNIT OS 2.1.7 (LEGACY)</span><span class="nm gl" id="nm"></span>
    <span class="sp"></span><span class="clock" id="clock">--:--:--</span><span class="link" id="link">LINK ...</span>${NAV}`,
  main: `<div class="term"><div class="colL">
      <div class="sec" id="p-mon"><h3>PARTNER MONITOR <span>// 搭档监视 · <span class="gl" id="pname"></span></span></h3>
        <div class="mon"><div class="fig"><span class="lbl">VITAL SIGN</span><canvas id="pheart" width="11" height="11"></canvas></div>
          <div><table class="rd">
            <tr><td>HEART RATE</td><td><b class="gl" id="v-hr">--</b> <small>bpm</small></td><td class="bar" id="b-hr"></td></tr>
            <tr><td>BLOOD PRESS</td><td><b class="gl" id="v-bp">--</b></td><td class="bar" id="b-bp"></td></tr>
            <tr><td>RESPIRATION</td><td><b class="gl" id="v-rr">--</b> <small>/min</small></td><td class="bar" id="b-rr"></td></tr>
            <tr><td>CONDITION</td><td colspan="2"><span class="tier gl" id="tier"></span></td></tr>
            <tr><td>LINK</td><td colspan="2" class="dim" id="plink"></td></tr></table>
            <div class="osc"><span class="l">ECG · 25mm/s</span><canvas id="ecg"></canvas></div></div></div></div>
      <div class="sec" id="p-scan"><h3>SCAN LOG <span>// 扫描记录</span></h3>
        <button class="scanbtn" id="scanbtn">[ F1 执行扫描 ]</button><span class="newdata" id="newdata" hidden>NEW DATA</span>
        <div id="scanout" class="log"></div></div>
    </div><div class="colR">
      <div class="sec" id="p-prog"><h3>PROGRAMS <span>// 程序</span></h3><div id="progs"></div><div class="msg" id="lm"></div></div>
      <div class="sec" id="p-comm"><h3>COMM LOG <span>// 通讯记录</span></h3><div id="msgs"></div></div>
      <div class="sec" id="p-self"><h3>UNIT STATUS <span>// 机体参数</span></h3><div id="self"></div></div>
    </div></div>`,
  fkeys: `<button data-f="1"><b>F1</b>扫描</button><button data-f="2"><b>F2</b>程序</button><button data-f="3"><b>F3</b>通讯</button>
    <button data-f="4"><b>F4</b>机体</button><span class="sp"></span><span class="dim">MEM 640K OK · FW 2.1.7</span>`,
};

function build(old) {
  OLD = old; built = old ? 'old' : 'new';
  const L = old ? LAYOUT_OLD : LAYOUT_NEW;
  document.body.classList.toggle('old', old);
  document.body.classList.toggle('new', !old);
  $('#bar').innerHTML = L.bar;
  $('#main').innerHTML = L.main;
  $('#fkeys').innerHTML = L.fkeys || '';
  $('#fkeys').hidden = !old;
  if (PREVIEW) $('#nav').innerHTML = '<a href="/kp">返回控制台</a>';
  else {
    $('#lowbtn').addEventListener('click', e => { e.preventDefault(); setLow(!low, true); });
    $('#out').addEventListener('click', e => { e.preventDefault(); logout(); });
  }
  $('#scanbtn').addEventListener('click', startScan);
  EW = 0; colors = null; scanned = false; scanning = false;
  if (!old) drawEyeFrame();
  setLow(low, false);
  linkState(linkOn);
  tick();
}

// ---------- 读取 ----------
async function load() {
  const [r, h, ent, msg, meta] = await Promise.all([
    api('/api/me' + Q), api('/api/hud' + Q), api('/api/entries' + Q), api('/api/messages' + Q),
    fields.length ? null : api('/api/meta'),
  ]);
  if (!r.user) return location.replace(AS ? '/kp' : '/');
  // 不是已审核的仿生人（人类、KP 退回修改、换了账号）：回到普通终端，由它再分流
  if (!h.ok || r.user.role !== 'player' || r.user.status !== 'approved' || !(r.user.ho === 'HO2' || r.user.ho === 'HO4')) return location.replace('/terminal' + location.search);
  if (meta) fields = meta.fields || [];
  me = r.user; hud = h; sessionT = r.sessionT || 0;
  entries = ent.ok ? ent : { entries: [], locked: [] };
  messages = msg.messages || [];
  const want = me.ho === 'HO4' ? 'old' : 'new';
  if (built !== want) build(want === 'old');
  if (!booted) { booted = true; maybeBoot(); }
  render();
}
let booted = false, colorKey = '';
function setText(sel, t) { const el = $(sel); if (!el) return; delete el.dataset.orig; el.textContent = t; }

function render() {
  // 颜色或布局变了：重画用到颜色的静态部分（主视野框架、背景、心形）
  const key = built + hud.color;
  if (key !== colorKey) {
    colorKey = key;
    document.body.classList.remove('c-cyan', 'c-grey', 'c-green');
    document.body.classList.add('c-' + hud.color);
    colors = null; heartTier = undefined;
    if (!OLD) drawEyeFrame();
    if (me) drawBg();
  }
  setText('#model', hud.model || (OLD ? '旧型机' : '新型机'));
  setText('#nm', me.sheet.name + (me.test ? ' · 测试' : ''));
  if (PREVIEW) $('#pv').innerHTML = `<div class="preview-bar">预览：${esc(me.username)}（${esc(me.ho)}）看到的画面 · 只读</div>`;
  renderPartner(); renderScan(); renderProgs(); renderMsgs(); renderSelf();
  requestAnimationFrame(wires);
  if (!PREVIEW) showNextUnread();
}

// ---------- 颜色 ----------
let colors = null;
function C() {
  if (!colors) {
    const s = getComputedStyle(document.body), g = k => s.getPropertyValue(k).trim();
    colors = { fg: g('--fg'), hi: g('--hi'), dim: g('--dim'), warn: g('--warn'), bad: g('--bad'), bg: g('--bg'), ok: g('--ok') };
  }
  return colors;
}
function tierColor(t) { const c = C(); return t === null ? c.dim : OLD ? (t === 0 ? c.fg : t === 3 ? c.bad : c.warn) : (t === 0 ? c.fg : t === 1 ? c.warn : c.bad); }

// ---------- HO2 主视野框架 ----------
const EC = 235;
function arcPath(r, a0, a1, sweep) {
  const p = a => [EC + Math.cos(a) * r, EC + Math.sin(a) * r];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 0 ${sweep} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}
// 左边心率弧：从下往上（0–200 次/分）；右边呼吸弧：从上往下（0–40 次/分）
const HR_A = [Math.PI * 1.38, Math.PI * 0.62], RR_A = [-Math.PI * 0.38, Math.PI * 0.38];
function drawEyeFrame() {
  const c = C();
  let g = `<g class="spin"><circle cx="${EC}" cy="${EC}" r="226" fill="none" stroke="${c.dim}"/>`;
  for (let i = 0; i < 120; i++) {
    const a = i / 120 * Math.PI * 2, l = i % 10 === 0 ? 14 : i % 5 === 0 ? 8 : 4;
    g += `<line x1="${(EC + Math.cos(a) * 226).toFixed(1)}" y1="${(EC + Math.sin(a) * 226).toFixed(1)}" x2="${(EC + Math.cos(a) * (226 - l)).toFixed(1)}" y2="${(EC + Math.sin(a) * (226 - l)).toFixed(1)}" stroke="${c.fg}" stroke-opacity="${i % 10 === 0 ? .9 : .4}"/>`;
  }
  g += '</g>';
  g += `<circle cx="${EC}" cy="${EC}" r="196" fill="none" stroke="${c.fg}" stroke-opacity=".25"/>`;
  g += `<circle cx="${EC}" cy="${EC}" r="150" fill="none" stroke="${c.fg}" stroke-opacity=".12" stroke-dasharray="1 6"/>`;
  g += `<path d="${arcPath(206, HR_A[0], HR_A[1], 0)}" fill="none" stroke="${c.fg}" stroke-opacity=".15" stroke-width="6"/>`;
  g += `<path id="hrarc" d="" fill="none" stroke-width="6"/>`;
  g += `<path d="${arcPath(206, RR_A[0], RR_A[1], 1)}" fill="none" stroke="${c.fg}" stroke-opacity=".15" stroke-width="3"/>`;
  g += `<path id="rrarc" d="" fill="none" stroke="${c.fg}" stroke-width="3"/>`;
  g += `<path d="M${EC} 70 V100 M${EC} 370 V400 M70 ${EC} H100 M370 ${EC} H400" stroke="${c.fg}" stroke-opacity=".5"/>`;
  $('#eyesvg').innerHTML = g;
}
const HEART = 'M120 196 C60 150 34 118 40 86 C46 56 82 46 104 66 L120 82 L136 66 C158 46 194 56 200 86 C206 118 180 150 120 196Z';
function drawHeart(t) {
  const c = C(), col = tierColor(t);
  $('#heartsvg').innerHTML = `<circle cx="120" cy="124" r="112" fill="none" stroke="${c.fg}" stroke-opacity=".12"/>
    <circle cx="120" cy="124" r="90" fill="none" stroke="${c.fg}" stroke-opacity=".2"/>
    <circle cx="120" cy="124" r="68" fill="none" stroke="${c.fg}" stroke-opacity=".3"/>
    <g id="pulses"></g>
    <g class="hp"><g transform="translate(120 128) scale(.6) translate(-120 -128)"><path d="${HEART}" fill="${col}" fill-opacity=".1" stroke="${col}" stroke-width="3.5"/></g>
    ${t === null ? `<path d="M72 128 H168" stroke="${c.dim}" stroke-width="2"/>` : `<path d="M72 128 H100 L108 112 L118 146 L128 100 L136 128 H168" fill="none" stroke="${c.hi}" stroke-width="2"/>`}</g>`;
  $('#heart').className = 'heart' + (t === 3 ? ' t3' : '');
}

// HO4：像素心形
const PIX = ['.##...##.', '####.####', '#########', '#########', '.#######.', '..#####..', '...###...', '....#....'];
function drawPixHeart(bright) {
  const cv = $('#pheart'); if (!cv) return;
  const g = cv.getContext('2d'), p = hud && hud.partner, t = p && p.connected ? p.tier : null, c = C();
  g.clearRect(0, 0, 11, 11);
  const miss = t === 2 ? 1 : t === 3 ? 2 : 0, gone = new Set();
  for (let k = 0; k < miss; k++) gone.add(Math.floor(Math.random() * PIX.length));
  g.fillStyle = t === null ? c.dim : bright ? c.hi : tierColor(t);
  PIX.forEach((r, y) => { if (gone.has(y)) return; for (let x = 0; x < r.length; x++) if (r[x] === '#') g.fillRect(x + 1, y + 2, 1, 1); });
}

// ---------- 搭档体征 ----------
const V = { hr: 72, sys: 115, dia: 75, rr: 15, tgt: null, tier: null };
function rnd(a, b) { return a + Math.random() * (b - a); }
function newTargets() {
  const p = hud && hud.partner;
  if (!p || !p.connected) return;
  const t = TIERS[p.tier];
  V.tgt = { hr: rnd(t.hr[0], t.hr[1]), sys: t.bp[0] + rnd(-4, 4), dia: t.bp[1] + rnd(-3, 3), rr: rnd(t.rr[0], t.rr[1]) };
}
function renderPartner() {
  const p = hud.partner, tier = $('#tier');
  const t = p.connected ? p.tier : null;
  if (!p.connected) {
    setText('#pname', OLD ? `${p.ho} 未连接` : `${p.ho} · 未连接`);
    tier.className = 'tier gl none'; setText('#tier', 'NO LINK');
    for (const k of ['hr', 'bp', 'rr']) { setText('#v-' + k, '--'); $('#v-' + k).classList.remove('ov'); }
    if (OLD) { setText('#plink', 'NO CARRIER · 搭档未登记'); for (const k of ['hr', 'bp', 'rr']) $('#b-' + k).textContent = ''; }
    V.tier = null;
  } else {
    setText('#pname', OLD ? `${p.ho} ${p.name}` : `${p.ho} · ${p.name}`);
    tier.className = 'tier gl t' + p.tier; setText('#tier', TIERS[p.tier].name);
    if (OLD) setText('#plink', `CH-0${p.ho.slice(2)} · ${p.tier === 3 ? '信号微弱' : '信号稳定'}`);
    if (!V.tgt || V.tier !== p.tier) { V.tier = p.tier; newTargets(); Object.assign(V, { hr: V.tgt.hr, sys: V.tgt.sys, dia: V.tgt.dia, rr: V.tgt.rr }); }
    showVitals();
  }
  if (OLD) drawPixHeart(false); else if (heartTier !== t || !$('#heartsvg').firstChild) { heartTier = t; drawHeart(t); }
  if (!OLD) { const a = $('#hrarc'); if (a) a.setAttribute('stroke', tierColor(t)); }
}
let heartTier = undefined;
const textBar = (v, n) => '[' + '|'.repeat(Math.max(0, Math.min(n, Math.round(v * n)))) + '.'.repeat(n - Math.max(0, Math.min(n, Math.round(v * n)))) + ']';
function showVitals() {
  const p = hud && hud.partner;
  if (!p || !p.connected || !$('#v-hr')) return;
  const ov = p.vitals || {};
  const val = (k, auto) => ov[k] !== null && ov[k] !== undefined ? ov[k] : auto;
  const set = (k, auto) => {
    const el = $('#v-' + k), o = ov[k], has = o !== null && o !== undefined;
    if (el.dataset.orig === undefined) el.textContent = has ? o : auto;
    el.classList.toggle('ov', has);
  };
  set('hr', Math.round(V.hr)); set('bp', `${Math.round(V.sys)}/${Math.round(V.dia)}`); set('rr', Math.round(V.rr));
  const hr = Number(val('hr', V.hr)) || 0, rr = Number(val('rr', V.rr)) || 0;
  const sys = Number(String(val('bp', Math.round(V.sys))).split('/')[0]) || 0;
  if (OLD) {
    $('#b-hr').textContent = textBar(hr / 200, 20); $('#b-bp').textContent = textBar(sys / 200, 20); $('#b-rr').textContent = textBar(rr / 40, 20);
  } else {
    const a = $('#hrarc'), b = $('#rrarc');
    const k = Math.max(0.01, Math.min(1, hr / 200)), j = Math.max(0.01, Math.min(1, rr / 40));
    if (a) a.setAttribute('d', arcPath(206, HR_A[0], HR_A[0] - (HR_A[0] - HR_A[1]) * k, 0));
    if (b) b.setAttribute('d', arcPath(206, RR_A[0], RR_A[0] + (RR_A[1] - RR_A[0]) * j, 1));
  }
}
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
// 每跳一下：HO2 心形放大并扩散一圈波纹；HO4 像素心形闪一下
function onBeat() {
  const p = hud && hud.partner;
  if (!p || !p.connected || document.hidden) return;
  if (OLD) { drawPixHeart(true); setTimeout(() => drawPixHeart(false), 120); return; }
  const h = $('#heart'); if (!h) return;
  h.classList.add('beat'); setTimeout(() => h.classList.remove('beat'), 110);
  if (low) return;
  const g = $('#pulses'); if (!g) return;
  const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  c.setAttribute('cx', 120); c.setAttribute('cy', 124); c.setAttribute('r', 70); c.setAttribute('class', 'pulse'); c.setAttribute('stroke', tierColor(p.tier));
  g.appendChild(c); setTimeout(() => c.remove(), 1000);
}

// 心电图：旧的波形慢慢变淡（像示波器余辉）
let EW = 0, EH = 0, ex = 0, ey = null, simT = 0, beatStart = -10, nextBeat = 0, ctx = null;
function sizeEcg() {
  const cv = $('#ecg'); if (!cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  EW = cv.clientWidth; EH = cv.clientHeight;
  cv.width = Math.round(EW * dpr); cv.height = Math.round(EH * dpr);
  ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, EW, EH); ex = 0; ey = null;
}
window.addEventListener('resize', () => { const cv = $('#ecg'); if (cv && (cv.clientWidth !== EW || cv.clientHeight !== EH)) sizeEcg(); wires(); drawBg(); });
function beatShape(t, amp) {
  let y = 0;
  if (t > 0.04 && t < 0.12) y = 0.1 * Math.sin((t - 0.04) / 0.08 * Math.PI);
  else if (t >= 0.16 && t < 0.18) y = -0.15 * (t - 0.16) / 0.02;
  else if (t >= 0.18 && t < 0.205) y = -0.15 + 1.15 * (t - 0.18) / 0.025;
  else if (t >= 0.205 && t < 0.235) y = 1 - 1.3 * (t - 0.205) / 0.03;
  else if (t >= 0.235 && t < 0.26) y = -0.3 + 0.3 * (t - 0.235) / 0.025;
  else if (t > 0.34 && t < 0.5) y = 0.25 * Math.sin((t - 0.34) / 0.16 * Math.PI);
  return y * amp;
}
let lastFrame = 0, perfAcc = 0, perfN = 0, perfT = 0, skip = false;
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = lastFrame ? Math.min(0.1, (ts - lastFrame) / 1000) : 0.016;
  lastFrame = ts;
  // 卡顿检测：平均帧耗时超过 30ms 持续 1 秒，自动切简化特效
  if (!low && lowManual === null && !document.hidden) {
    perfAcc += dt; perfN++; perfT += dt;
    if (perfT >= 1) { if (perfAcc / perfN > 0.03) setLow(true, false); perfAcc = perfN = perfT = 0; }
  }
  rainStep(dt);
  if (!built) return;
  if (low) { skip = !skip; if (skip) { stepBeats(dt); return; } }
  if (!EW || !ctx) sizeEcg();
  if (!EW) return;
  const p = hud && hud.partner, on = !!(p && p.connected), c = C();
  // 余辉：整体擦淡一点
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = `rgba(0,0,0,${(1 - Math.pow(OLD ? 0.35 : 0.2, dt)).toFixed(4)})`;
  ctx.fillRect(0, 0, EW, EH);
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = on ? c.fg : c.dim; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
  const speed = 70, steps = Math.max(1, Math.round(dt * speed / 2)), stepT = dt / steps;
  const mid = EH * 0.58, amp = EH * 0.42;
  ctx.beginPath();
  if (ey !== null) ctx.moveTo(ex, ey);
  for (let i = 0; i < steps; i++) {
    simT += stepT;
    const y = on ? beatAt() + rnd(-0.015, 0.015) : rnd(-0.01, 0.01);
    const nx = ex + 2, ny = mid - y * amp;
    if (ey === null) ctx.moveTo(ex, ny); else ctx.lineTo(nx, ny);
    ex = nx; ey = ny;
    if (ex > EW) { ctx.stroke(); ctx.beginPath(); ex = 0; ey = null; }
  }
  ctx.stroke();
  ctx.clearRect(ex + 1, 0, 14, EH);
}
// 推进心跳时间；到点触发 onBeat
function beatAt() {
  const p = hud.partner, hr = currentHr();
  if (hr <= 0) return 0;
  if (simT >= nextBeat) {
    beatStart = simT;
    let iv = 60 / hr;
    if (p.tier === 3) iv *= rnd(0.7, 1.5); // 濒死：不规则
    nextBeat = simT + iv;
    onBeat();
  }
  return beatShape(simT - beatStart, p.tier === 3 ? 0.55 : 1);
}
function stepBeats(dt) { simT += dt; const p = hud && hud.partner; if (p && p.connected) beatAt(); }
requestAnimationFrame(frame);

// 背景：HO2 六角网格 + 缓慢下落的十六进制数据流；HO4 没有背景
const bg = $('#bgc'), bgx = bg.getContext('2d');
let rain = [], rainAcc = 0;
function drawBg() {
  bg.width = innerWidth; bg.height = innerHeight;
  bgx.clearRect(0, 0, bg.width, bg.height);
  if (!built || OLD) { rain = []; return; }
  const c = C();
  bgx.strokeStyle = c.fg; bgx.globalAlpha = .045; bgx.lineWidth = 1;
  const R = 22, hh = R * Math.sqrt(3);
  for (let y = 0, row = 0; y < bg.height + hh; y += hh / 2, row++) for (let x = (row % 2) * R * 1.5; x < bg.width + R * 3; x += R * 3) {
    bgx.beginPath(); for (let i = 0; i <= 6; i++) { const a = i / 6 * Math.PI * 2; bgx.lineTo(x + Math.cos(a) * R, y + Math.sin(a) * R); } bgx.stroke();
  }
  bgx.globalAlpha = 1;
  bgStatic = bgx.getImageData(0, 0, bg.width, bg.height);
  rain = low ? [] : Array.from({ length: Math.round(bg.width / 60) }, () => ({ x: Math.random() * bg.width, y: Math.random() * bg.height, v: rnd(18, 40), n: Math.round(rnd(6, 16)) }));
}
let bgStatic = null;
function rainStep(dt) {
  if (!rain.length || !bgStatic || document.hidden) return;
  rainAcc += dt;
  if (rainAcc < 0.08) return; // 约 12 帧/秒，够用且省电
  const step = rainAcc; rainAcc = 0;
  bgx.putImageData(bgStatic, 0, 0);
  bgx.font = '11px monospace'; bgx.fillStyle = C().fg;
  for (const d of rain) {
    d.y += d.v * step;
    if (d.y - d.n * 14 > bg.height) { d.y = -10; d.x = Math.random() * bg.width; }
    for (let i = 0; i < d.n; i++) { bgx.globalAlpha = 0.12 * (1 - i / d.n); bgx.fillText('0123456789ABCDEF'[(Math.floor(d.y / 14) + i * 7) & 15], d.x, d.y - i * 14); }
  }
  bgx.globalAlpha = 1;
}

// HO2：面板到主视野的连接线
function wires() {
  const w = $('#wires'), eye = $('#eye'), st = $('#stage');
  if (!w || !eye || !st || getComputedStyle(w).display === 'none') return;
  const s = st.getBoundingClientRect(), e = eye.getBoundingClientRect(), c = C();
  const cx = e.left + e.width / 2 - s.left, cy = e.top + e.height / 2 - s.top, r = e.width / 2 - 4;
  let out = '';
  for (const [id, side] of [['p-scan', 1], ['p-prog', -1], ['p-comm', -1], ['p-self', -1]]) {
    const el = $('#' + id); if (!el) continue;
    const b = el.getBoundingClientRect();
    const x0 = (side > 0 ? b.right : b.left) - s.left, y0 = b.top + 22 - s.top;
    const a = Math.atan2(y0 - cy, x0 - cx), x1 = cx + Math.cos(a) * r, y1 = cy + Math.sin(a) * r;
    out += `<path d="M${x0} ${y0} H${x0 + side * 26} L${x1} ${y1}" fill="none" stroke="${c.fg}" stroke-opacity=".28"/><circle cx="${x1}" cy="${y1}" r="2.5" fill="${c.fg}"/><circle cx="${x0}" cy="${y0}" r="2" fill="${c.fg}"/>`;
  }
  w.innerHTML = out;
}

// ---------- 扫描 ----------
let scanned = false, scanning = false, scannedIds = new Set(), ambientLine = '', fresh = false;
const openScans = new Set();
const SEEN_KEY = () => 'void_scan_seen_' + me.id;
function seenMap() { try { return JSON.parse(localStorage.getItem(SEEN_KEY()) || '{}'); } catch { return {}; } }
function markSeen(s) {
  if (PREVIEW) return;
  const m = seenMap(); m[s.id] = s.updatedAt;
  try { localStorage.setItem(SEEN_KEY(), JSON.stringify(m)); } catch {}
}
function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function hexOf(id) { const h = hash(id), b = n => ((h >>> n) & 255).toString(16).toUpperCase().padStart(2, '0'); return `0x${b(0)} ${b(8)} ${b(16)} · ${b(24)} ${b(4)} ${b(12)}`; }

function startScan() {
  if (scanning || !hud) return;
  scanning = true;
  const list = hud.scans.slice(), dur = low ? 700 : 1600, t0 = performance.now();
  const finish = () => {
    scanning = false; scanned = true; fresh = true;
    scannedIds = new Set(hud.scans.map(s => s.id));
    const pool = hud.ambient && hud.ambient.length ? hud.ambient : ['未检测到威胁。'];
    ambientLine = pool[Math.floor(Math.random() * pool.length)];
    renderScan(); fresh = false;
  };
  if (OLD) {
    $('#scanout').innerHTML = '<div class="p">&gt; scan --area --depth 2</div><div class="dim" id="sprog"></div>';
    const iv = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / dur), el = $('#sprog');
      if (el) el.textContent = `  ${textBar(k, 20)} ${Math.round(k * 100)}%`;
      if (k >= 1) { clearInterval(iv); finish(); }
    }, 60);
    return;
  }
  const eye = $('#eye');
  eye.classList.add('scanning');
  eye.insertAdjacentHTML('beforeend', '<div class="radar" data-scanfx></div><div class="pct" data-scanfx id="pct">SCANNING 0%</div>');
  // 每个已开放的条目在视野里出现一个锁定框（位置由条目 id 决定，每次一样）
  list.forEach((s, i) => setTimeout(() => {
    if (!scanning) return;
    const h = hash(s.id), a = (h % 360) / 180 * Math.PI, rr = 0.18 + ((h >>> 9) % 100) / 100 * 0.2;
    eye.insertAdjacentHTML('beforeend', `<div class="lockbox" data-scanfx style="left:${(50 + Math.cos(a) * rr * 100).toFixed(1)}%;top:${(50 + Math.sin(a) * rr * 100).toFixed(1)}%">
      <i></i><i></i><i></i><i></i><span>TGT-${String(i + 1).padStart(2, '0')} ${esc(s.title)}</span></div>`);
  }, (i + 1) * dur / (list.length + 1.5)));
  const iv = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / dur), el = $('#pct');
    if (el) el.textContent = `SCANNING ${Math.round(k * 100)}%`;
    if (k >= 1) {
      clearInterval(iv);
      setTimeout(() => { for (const x of $$('[data-scanfx]', eye)) x.remove(); eye.classList.remove('scanning'); }, low ? 0 : 500);
      finish();
    }
  }, 60);
}
function renderScan() {
  // 被隐藏的条目从“已扫描”里去掉：再开放时要重新扫描
  const openIds = new Set(hud.scans.map(s => s.id));
  for (const id of scannedIds) if (!openIds.has(id)) scannedIds.delete(id);
  $('#newdata').hidden = !hud.scans.some(s => !scannedIds.has(s.id));
  if (scanning) return;
  const out = $('#scanout');
  if (!scanned) {
    out.innerHTML = OLD ? '<div class="p">&gt; <span class="cur"></span></div><div class="dim">按 F1 或点上面的按钮开始扫描。</div>' : '<div class="hint">点击“扫描”读取周边数据。</div>';
    return;
  }
  let n = 0;
  const tw = () => fresh ? ` tw" style="animation-delay:${(n++ * 0.12).toFixed(2)}s` : '';
  const seen = seenMap();
  const list = hud.scans.filter(s => scannedIds.has(s.id));
  let html = OLD ? `<div class="p${tw()}">&gt; scan --area --depth 2</div><div class="dim${tw()}">  ... ${hexOf(me.id + ambientLine)} ... 解码完成</div>` : '';
  if (!list.length) {
    const p = hud.partner;
    const ps = p.connected ? `搭档 ${p.name}：${TIERS[p.tier].name}，心率 ${Math.round(currentHr())}。` : '搭档链路未连接。';
    html += `<div class="ambient${tw()}"><div class="gl">${esc(ambientLine)}</div><div class="p">${esc(ps)}</div></div>`;
  } else {
    html += list.map((s, i) => {
      const isNew = !PREVIEW && !(seen[s.id] >= s.updatedAt);
      const title = OLD ? `[${String(i + 1).padStart(2, '0')}] ${s.title}` : s.title;
      return `<div class="sitem ${openScans.has(s.id) ? 'open' : ''}" data-sid="${esc(s.id)}">
        <div class="h${tw()}"><span class="tt gl">${esc(title)}</span>${isNew ? `<span class="new">${OLD ? 'NEW' : '新'}</span>` : ''}</div>
        <div class="d">${OLD ? '' : `<div class="hex">${hexOf(s.id)} · DECODED</div>`}${esc(s.lines) || '<span class="dim">（无数据）</span>'}</div></div>`;
    }).join('');
  }
  if (OLD) html += `<div class="p">&gt; <span class="cur"></span></div>`;
  out.innerHTML = html;
}

// ---------- 程序、通讯、机体参数 ----------
function renderProgs() {
  let i = 0;
  const num = () => OLD ? `<span class="n">[${++i}]</span>` : '';
  const progs = (entries.entries || []).map(e =>
    `<div class="prog"><span>${num()}${esc(e.name)}${e.desc ? `<span class="desc">${esc(e.desc)}</span>` : ''}</span>` +
    (PREVIEW ? '<span class="tag">可启动</span>' : `<a class="btn small" href="${esc(e.url)}" target="_blank" rel="noopener">启动</a>`) + '</div>').join('');
  const locked = (entries.locked || []).map(e =>
    `<div class="prog locked" data-locked><span>${OLD ? '<span class="n">[x]</span>' : ''}${esc(e.name)}</span><span class="st">LOCKED</span></div>`).join('');
  $('#progs').innerHTML = (progs || locked ? progs + locked : '<div class="dim" style="margin-bottom:8px">暂无可用程序。</div>') +
    `<div class="prog locked" style="cursor:default"><span>${OLD ? '<span class="n">[-]</span>' : ''}其他程序</span><span class="st">ACCESS DENIED · 权限不足</span></div>`;
}
function renderMsgs() {
  $('#msgs').innerHTML = messages.length ? messages.map(m =>
    `<div class="msgitem ${m.read ? '' : 'unread'} ${openMsgs.has(m.id) ? 'open' : ''}" data-mid="${esc(m.id)}">
      <div class="t">${fmtTime(m.t)}${m.read ? '' : ' · 未读'}</div><div class="s">${esc(m.title)}</div><div class="body">${esc(m.body)}</div></div>`).join('')
    : '<div class="dim">无通讯记录。</div>';
}
function renderSelf() {
  const s = me.sheet, max = Math.max(1, s.hp), pct = Math.round(Math.max(0, Math.min(me.hpNow, max)) / max * 100);
  const rows = fields.filter(f => f.key !== 'hp');
  if (OLD) {
    $('#self').innerHTML = `<div class="ustat"><span class="k">识别名</span><span class="b gl">${esc(s.name)} · ${esc(me.ho)}</span></div>` +
      `<div class="ustat"><span class="k">机体完整度</span><span class="b">${textBar(pct / 100, 14)}</span><span class="v">${me.hpNow}/${s.hp}</span></div>` +
      rows.map(f => `<div class="ustat"><span class="k">${esc(f.label)}</span><span class="b">${textBar((s[f.key] || 0) / 100, 14)}</span><span class="v gl">${esc(s[f.key])}</span></div>`).join('');
    return;
  }
  $('#self').innerHTML = `<div class="idline">型号 ${esc(hud.model || '新型机')} · 识别名 ${esc(s.name)} · ${esc(me.ho)} ${esc(me.kind)}</div>
    <div class="integ"><span class="dim">机体完整度</span><b class="gl">${me.hpNow} / ${s.hp} · ${pct}%</b></div>` +
    rows.map(f => `<div class="stat"><span>${esc(f.label)}</span><span class="b"><i style="width:${Math.min(100, s[f.key] || 0)}%"></i></span><b class="gl">${esc(s[f.key])}</b></div>`).join('');
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
  const fk = e.target.closest('[data-f]');
  if (fk) fkey(Number(fk.dataset.f));
});
// HO4 功能键：F1 扫描，F2–F4 跳到对应区块
function fkey(n) {
  if (!OLD) return;
  if (n === 1) return startScan();
  const sec = $({ 2: '#p-prog', 3: '#p-comm', 4: '#p-self' }[n]);
  if (!sec) return;
  sec.scrollIntoView({ block: 'nearest', behavior: low ? 'auto' : 'smooth' });
  sec.classList.remove('flash'); void sec.offsetWidth; sec.classList.add('flash');
}
document.addEventListener('keydown', e => {
  if (!OLD || $('#modal').firstChild) return;
  const m = /^F([1-4])$/.exec(e.key);
  if (m) { e.preventDefault(); fkey(Number(m[1])); }
});

// 未读通讯：一条一条弹出，先解码约 1 秒，解码完才能点“确认”
const GLYPHS = '#%&@$*+=?!<>/\\|01アカサタナ░▒▓';
let showing = false;
function showNextUnread() {
  if (showing || bootOn) return;
  const m = messages.slice().reverse().find(x => !x.read);
  if (!m) return;
  showing = true;
  beep();
  $('#modal').innerHTML = `<div class="modal-bg"><div class="modal">
    <div class="kicker">接收到加密通讯 · ${fmtTime(m.t)}</div>
    <h2>${esc(m.title)}</h2><div class="body" id="mbody"></div><div class="bar2"><i id="mbar"></i></div>
    <div class="row"><button class="primary full" id="ack" disabled>解码中…</button></div></div></div>`;
  const text = Array.from(m.body), total = low ? 300 : 1000, t0 = performance.now();
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / total), n = Math.floor(text.length * k);
    const rest = text.slice(n).map(ch => ch === '\n' || ch === ' ' ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join('');
    const b = $('#mbody'); if (!b) return;
    b.innerHTML = esc(text.slice(0, n).join('')) + (rest ? `<span class="dim">${esc(rest)}</span>` : '');
    $('#mbar').style.width = (k * 100) + '%';
    if (k < 1) return setTimeout(step, 40);
    const ack = $('#ack');
    ack.disabled = false; ack.textContent = '确认';
    ack.addEventListener('click', async () => {
      await api('/api/messages/read', { id: m.id });
      m.read = true;
      $('#modal').innerHTML = '';
      showing = false;
      renderMsgs();
      showNextUnread();
    });
  };
  step();
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
  const p = hud.partner, model = hud.model || (OLD ? '旧型机' : '新型机');
  let lines, step;
  if (OLD) {
    lines = [['UNIT OS 2.1.7 (LEGACY)', 'hi'], ['MEMORY TEST ........ 640K OK'], ['DRIVE SYSTEM ....... OK'], ['OPTICAL SENSOR ..... OK'],
      ['MEMORY STACK ....... OK'], ['COMM MODULE ........ OK'], [`PARTNER LINK ....... ${p.connected ? 'CH-0' + p.ho.slice(2) : 'NO CARRIER'}`], [''], [`UNIT ${model} // ${me.sheet.name}`, 'hi']];
    box.innerHTML = '<div id="bl"></div><div class="skip">点击跳过</div>';
    step = 300;
  } else {
    lines = [['驱动系统'], ['光学传感器'], ['记忆堆栈'], ['通讯模块'], [`搭档链路 ${p.connected ? p.ho : '未连接'}`], [`${model} · ${me.sheet.name}`, 'hi']];
    box.innerHTML = `<svg class="emb" viewBox="0 0 120 120"><path d="M60 6 L107 33 L107 87 L60 114 L13 87 L13 33Z"/><path class="e2" d="M36 40 L60 84 L84 40"/></svg>
      <div class="lines" id="bl"></div><div class="skip">点击跳过</div>`;
    step = 300;
  }
  let i = 0;
  const iv = setInterval(() => {
    if (i < lines.length) {
      const [t, c] = lines[i++], last = i === lines.length;
      $('#bl').insertAdjacentHTML('beforeend', OLD || last ? `<div class="ln ${c || ''}">${esc(t) || '&nbsp;'}</div>`
        : `<div class="ln ${c || ''}"><span>${esc(t)}</span><span class="pb"><i></i></span><span>OK</span></div>`);
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

// ---------- 旧型机：字符错位、整行闪一下 ----------
function scramble(el, n) {
  const t = el.textContent;
  if (!t || el.dataset.orig !== undefined) return;
  el.dataset.orig = t;
  const arr = Array.from(t);
  for (let k = 0; k < n; k++) arr[Math.floor(Math.random() * arr.length)] = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  el.textContent = arr.join('');
}
function restore(el) { if (el.dataset.orig !== undefined) { el.textContent = el.dataset.orig; delete el.dataset.orig; } }
function oldNoise() {
  setTimeout(oldNoise, rnd(8000, 20000));
  if (!OLD || low || document.hidden || bootOn) return;
  const els = $$('.gl').filter(x => x.offsetParent && x.textContent.trim());
  if (!els.length) return;
  const el = els[Math.floor(Math.random() * els.length)];
  scramble(el, 1 + Math.floor(Math.random() * 3));
  el.classList.add('jit');
  setTimeout(() => { restore(el); el.classList.remove('jit'); }, 140);
}
setTimeout(oldNoise, 9000);
function rowFlash() {
  setTimeout(rowFlash, rnd(15000, 35000));
  if (!OLD || low || document.hidden || bootOn) return;
  const r = $('#rowflash');
  r.style.top = Math.round(rnd(0.1, 0.9) * innerHeight) + 'px';
  r.hidden = false;
  setTimeout(() => { r.hidden = true; }, 120);
}
setTimeout(rowFlash, 15000);

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
function tick() {
  const el = $('#clock'); if (!el) return;
  const d = new Date(), p = n => String(n).padStart(2, '0');
  el.textContent = OLD ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : `${p(d.getHours())} : ${p(d.getMinutes())} : ${p(d.getSeconds())}`;
}
setInterval(tick, 1000);
let linkOn = true;
function linkState(on) {
  linkOn = on;
  const l = $('#link'); if (!l) return;
  l.classList.toggle('off', !on);
  setText('#link', OLD ? (on ? 'LINK OK' : 'LINK LOST') : (on ? '链路正常' : '信号中断'));
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
load().then(() => { if (me) { drawBg(); connect(); } });
