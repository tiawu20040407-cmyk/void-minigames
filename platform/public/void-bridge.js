// 游戏和平台之间的对接。平台发游戏页面时，会在 <head> 里先放 window.VOID_SESSION，再加载这个脚本。
// 游戏单独打开（没有平台）时 VOID_SESSION 不存在，VOIDB.active 为 false，游戏照常是演示版。
//
// 游戏里这样用：
//   VOIDB.active          玩家从平台打开（技能值、设置由平台给，结果上传）
//   VOIDB.kp              KP 从控制台打开（所有选项可调，结果不上传）
//   VOIDB.session         { name, ho, skill, settings, used, allowed, official, ... }
//   await VOIDB.start()   点“开始”时调用，返回 { ok, official } 或 { ok:false, error }
//   VOIDB.report(result)  出结果时调用；断线时先存在浏览器，连上后自动补传
//   VOIDB.statusInto(el)  在 el 里显示上传状态
//   VOIDB.onStatus(fn)    正式局次数有变化（例如 KP“再给一次”）时回调 fn(session)
//
// 观战（第 3d 步）：
//   操作者：VOIDB.live.init(data)  这一轮的素材（中途进来的观众先收到它）
//           VOIDB.live.frame(data) 当前状态；发送中又来新的只保留最新一份
//           VOIDB.live.end(win)    这一局真正结束（观众只看到成功 / 失败）
//   观众：  VOIDB.watching 为 true；VOIDB.onInit(fn) / onFrame(fn) / onEnd(fn)
//           观战条、快捷短语、“本局结束”由这里统一画，游戏只负责画面
'use strict';
window.VOIDB = (function () {
  const S = window.VOID_SESSION || null;
  const active = !!(S && S.role === 'player');
  const watching = !!(S && S.role === 'watch');
  const KEY = 'void_pending_results';
  let attempt = null, official = false, statusEl = null, listeners = [], flushing = false;

  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Void': '1' }, body: JSON.stringify(body) });
    let j = {};
    try { j = await r.json(); } catch {}
    return Object.assign({ status: r.status }, j);
  }
  function pending() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }
  function savePending(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {} }
  function showStatus() {
    if (!statusEl) return;
    const n = pending().length;
    statusEl.textContent = !active ? '' : n ? '结果暂时没有上传成功，连上网后会自动补传，请不要清除浏览器数据。' : '结果已上传给 KP。';
    statusEl.style.display = active ? '' : 'none';
  }
  // 把存着的结果一条条传上去；服务器明确拒收（4xx）的丢掉，网络失败的留着下次再试
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      let list = pending();
      for (const item of list.slice()) {
        try {
          const r = await post('/api/game/result', item);
          if (r.ok || (r.status >= 400 && r.status < 500)) list = list.filter(x => x.rid !== item.rid);
        } catch { break; }
      }
      savePending(list);
    } finally { flushing = false; showStatus(); }
  }
  async function refresh() {
    if (!active) return;
    try {
      const r = await fetch('/api/game/status?game=' + encodeURIComponent(S.game), { credentials: 'same-origin' }).then(x => x.json());
      if (r.ok && (r.used !== S.used || r.allowed !== S.allowed)) {
        Object.assign(S, { used: r.used, allowed: r.allowed, official: r.official });
        for (const fn of listeners) try { fn(S); } catch {}
      }
    } catch {}
  }
  if (active) {
    flush();
    setInterval(flush, 15000);
    setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); flush(); } });
    window.addEventListener('online', flush);
  }

  // ---------- 观战：公用的小界面 ----------
  function css() {
    if (document.getElementById('void-live-css')) return;
    const st = document.createElement('style'); st.id = 'void-live-css';
    st.textContent = `
#vl-bar{width:100%;display:flex;gap:8px;align-items:center;justify-content:center;color:#cfd6dd;font-size:12px;pointer-events:none}
#vl-bar b{color:#fff;font-weight:600}#vl-bar .vl-dot{width:7px;height:7px;border-radius:50%;background:#e04848;animation:vlp 1.2s infinite}
@keyframes vlp{50%{opacity:.25}}
#vl-cheers{position:fixed;left:0;right:0;bottom:0;z-index:9000;display:flex;flex-wrap:wrap;gap:6px;justify-content:center;padding:6px 8px calc(6px + env(safe-area-inset-bottom));
  background:rgba(8,10,12,.82);border-top:1px solid #2a3138;font:13px system-ui,sans-serif}
#vl-cheers button{background:#1b2127;color:#dfe5ea;border:1px solid #39424b;border-radius:14px;padding:4px 11px;font:inherit;cursor:pointer}
#vl-cheers button:disabled{opacity:.4;cursor:default}#vl-cheers .vl-note{color:#8a96a3;width:100%;text-align:center;font-size:12px}
#vl-wait,#vl-end{position:fixed;inset:0;z-index:8990;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;
  background:rgba(5,6,8,.78);color:#cfd6dd;font:15px system-ui,sans-serif;text-align:center}
#vl-end b{font-size:26px;letter-spacing:2px}#vl-end .win{color:#7fd69a}#vl-end .lose{color:#e06a6a}
#vl-op{position:fixed;right:8px;top:52px;z-index:9000;display:flex;flex-direction:column;align-items:flex-end;gap:4px;font:13px system-ui,sans-serif;pointer-events:none}
#vl-op .vl-st{pointer-events:auto;background:rgba(8,10,12,.75);color:#9aa6b2;border:1px solid #2a3138;border-radius:12px;padding:2px 9px;cursor:pointer}
#vl-op .vl-c{background:rgba(8,10,12,.85);color:#fff;border-left:3px solid #6fb7ff;padding:3px 9px;border-radius:3px;animation:vlin .2s}
@keyframes vlin{from{transform:translateX(20px);opacity:0}}
[hidden]{display:none!important}`;
    document.head.appendChild(st);
  }
  function el(tag, attrs, html) { const e = document.createElement(tag); Object.assign(e, attrs || {}); if (html != null) e.innerHTML = html; document.body.appendChild(e); return e; }
  function escH(t) { return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- 观战：操作者这边 ----------
  let liveOn = false, sending = false, nextFrame = null, initQ = null, lastSend = 0, opEs = null, muted = false, opBox = null, opSt = null, watchers = 0;
  async function pump() {
    if (sending || !liveOn) return;
    let kind, data;
    if (initQ) { kind = 'init'; data = initQ; initQ = null; }
    else if (nextFrame) { kind = 'frame'; data = nextFrame; nextFrame = null; }
    else return;
    sending = true;
    try {
      const r = await post('/api/live/frame', { attempt, kind, data });
      lastSend = Date.now();
      if (r.ended) liveOn = false;
      if (typeof r.watchers === 'number') setWatchers(r.watchers);
    } catch { if (kind === 'init' && !initQ) initQ = data; }
    sending = false;
    if (initQ || nextFrame) setTimeout(pump, 0);
  }
  function setWatchers(n) {
    watchers = n;
    if (!opSt) return;
    opSt.hidden = !(liveOn && n > 0);
    opSt.textContent = `${n} 人在看 · 观战提示 ${muted ? '关' : '开'}`;
  }
  function opCheer(d) {
    if (muted || !opBox) return;
    const c = document.createElement('div'); c.className = 'vl-c'; c.textContent = `${d.from}：${d.text}`;
    opBox.appendChild(c);
    while (opBox.querySelectorAll('.vl-c').length > 3) opBox.querySelector('.vl-c').remove();
    setTimeout(() => c.remove(), 2600);
  }
  function startLive() {
    liveOn = true; initQ = null; nextFrame = null;
    css();
    if (!opBox) {
      opBox = el('div', { id: 'vl-op' });
      opSt = document.createElement('div'); opSt.className = 'vl-st'; opSt.hidden = true; opBox.appendChild(opSt);
      opSt.addEventListener('pointerdown', e => e.stopPropagation());
      opSt.onclick = e => {
        e.stopPropagation(); muted = !muted; setWatchers(watchers);
        if (muted) for (const c of opBox.querySelectorAll('.vl-c')) c.remove();
        post('/api/live/mute', { attempt, mute: muted }).catch(() => {});
      };
    }
    setWatchers(0);
    if (opEs) opEs.close();
    opEs = new EventSource('/api/live/stream?as=play&attempt=' + encodeURIComponent(attempt));
    opEs.addEventListener('watchers', ev => { try { setWatchers(JSON.parse(ev.data).n); } catch {} });
    opEs.addEventListener('cheer', ev => { try { opCheer(JSON.parse(ev.data)); } catch {} });
  }
  function stopLive() {
    liveOn = false;
    if (opEs) { opEs.close(); opEs = null; }
    if (opSt) opSt.hidden = true;
  }
  // 心跳：录像排序可能很久没有变化，15 秒没发过东西就报一声“还在”
  if (active) setInterval(() => {
    if (liveOn && !sending && Date.now() - lastSend > 15000) {
      lastSend = Date.now();
      post('/api/live/frame', { attempt, kind: 'beat' }).then(r => { if (r.ended) stopLive(); else if (typeof r.watchers === 'number') setWatchers(r.watchers); }).catch(() => {});
    }
  }, 5000);
  const live = {
    get on() { return liveOn; },
    init(data) { if (!liveOn) return; initQ = data; nextFrame = null; pump(); },
    frame(data) { if (!liveOn) return; nextFrame = data; pump(); },
    end(win) {
      if (!liveOn) return;
      const a = attempt; stopLive();
      post('/api/live/frame', { attempt: a, kind: 'end', data: { win: !!win } }).catch(() => {});
    },
  };

  // ---------- 观战：观众这边 ----------
  const wl = { init: [], frame: [], end: [] };
  let gotFrame = false, ended = false, waitEl = null, endEl = null, cheerBox = null;
  function startWatch() {
    css();
    const op = S.operator || {};
    waitEl = el('div', { id: 'vl-wait' }, '<div>正在接入画面…</div><div style="font-size:12px;color:#8a96a3">操作者开始后这里会同步显示</div>');
    endEl = el('div', { id: 'vl-end', hidden: true });
    cheerBox = el('div', { id: 'vl-cheers' });
    cheerBox.innerHTML = `<div id="vl-bar"><span class="vl-dot"></span><span>观战中 · <b>${escH(op.ho)} ${escH(op.name)}</b> · 只能看，不能操作</span></div>` + (S.cheers || []).map((t, i) => `<button type="button" data-i="${i}">${escH(t)}</button>`).join('') + '<div class="vl-note" hidden></div>';
    let cool = false;
    cheerBox.addEventListener('click', async e => {
      const b = e.target.closest('button'); if (!b || cool || ended) return;
      cool = true; cheerBox.querySelectorAll('button').forEach(x => x.disabled = true);
      setTimeout(() => { cool = false; if (!ended && !muted) cheerBox.querySelectorAll('button').forEach(x => x.disabled = false); }, 2000);
      try { await post('/api/live/cheer', { attempt: S.attempt, i: Number(b.dataset.i) }); } catch {}
    });
    connectWatch();
  }
  function connectWatch() {
    const es = new EventSource('/api/live/stream?as=watch&attempt=' + encodeURIComponent(S.attempt));
    const on = (type, fn) => es.addEventListener(type, ev => { let d = null; try { d = JSON.parse(ev.data); } catch { return; } fn(d); });
    on('init', d => { for (const fn of wl.init) try { fn(d); } catch (x) { console.error(x); } });
    on('frame', d => {
      if (!gotFrame) { gotFrame = true; waitEl.hidden = true; }
      for (const fn of wl.frame) try { fn(d); } catch (x) { console.error(x); }
    });
    on('mute', d => {
      muted = !!d.mute;
      const note = cheerBox.querySelector('.vl-note'); note.hidden = !muted; note.textContent = '操作者关闭了观战提示';
      cheerBox.querySelectorAll('button').forEach(x => x.disabled = muted || ended);
    });
    on('end', d => {
      if (ended) return; ended = true; es.close();
      waitEl.hidden = true; cheerBox.querySelectorAll('button,.vl-note').forEach(x => x.hidden = true);
      endEl.innerHTML = d.grade === 'win' ? '<div>本局结束</div><b class="win">成功</b>'
        : d.grade === 'lose' ? '<div>本局结束</div><b class="lose">失败</b>'
        : '<div>本局结束</div><div style="color:#8a96a3">操作者的连接中断了</div>';
      endEl.innerHTML += '<div style="font-size:12px;color:#8a96a3;margin-top:10px">可以关掉这个页面了</div>';
      // 结束画面延迟一点出现，让最后几帧先播完
      setTimeout(() => { endEl.hidden = false; }, 900);
      for (const fn of wl.end) try { fn(d); } catch {}
    });
    es.onerror = () => { if (es.readyState === EventSource.CLOSED && !ended) setTimeout(connectWatch, 5000); };
  }
  if (watching) { if (document.body) startWatch(); else document.addEventListener('DOMContentLoaded', startWatch); }

  return {
    session: S, active, kp: !!(S && S.role === 'kp'), watching, live,
    onInit(fn) { wl.init.push(fn); }, onFrame(fn) { wl.frame.push(fn); }, onEnd(fn) { wl.end.push(fn); },
    get official() { return official; },
    async start() {
      if (!active) return { ok: true, official: false };
      try {
        const r = await post('/api/game/start', { game: S.game });
        if (!r.ok) return { ok: false, error: r.error || '无法开始' };
        attempt = r.attempt; official = r.official;
        startLive();
        Object.assign(S, { used: r.used, allowed: r.allowed, official: r.used < r.allowed });
        for (const fn of listeners) try { fn(S); } catch {}
        return { ok: true, official };
      } catch {
        return { ok: false, error: '连不上服务器，请检查网络后再点开始。' };
      }
    },
    report(result) {
      if (!active || !attempt || !result) return;
      const rid = attempt + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const list = pending(); list.push({ attempt, rid, result }); savePending(list);
      showStatus();
      flush();
    },
    statusInto(el) { statusEl = el; showStatus(); },
    onStatus(fn) { listeners.push(fn); },
  };
})();
