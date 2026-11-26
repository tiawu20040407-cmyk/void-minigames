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
'use strict';
window.VOIDB = (function () {
  const S = window.VOID_SESSION || null;
  const active = !!(S && S.role === 'player');
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

  return {
    session: S, active, kp: !!(S && S.role === 'kp'),
    get official() { return official; },
    async start() {
      if (!active) return { ok: true, official: false };
      try {
        const r = await post('/api/game/start', { game: S.game });
        if (!r.ok) return { ok: false, error: r.error || '无法开始' };
        attempt = r.attempt; official = r.official;
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
