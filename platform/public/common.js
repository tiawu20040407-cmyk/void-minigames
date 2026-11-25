// 页面共用：调用后端、取表单、显示消息
'use strict';
async function api(path, body) {
  const opt = body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Void': '1' }, body: JSON.stringify(body) };
  let r;
  try { r = await fetch(path, opt); } catch { return { ok: false, error: '连接不到服务器' }; }
  try { return await r.json(); } catch { return { ok: false, error: '服务器返回异常（' + r.status + '）' }; }
}

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function say(el, text, kind = 'bad') {
  el = typeof el === 'string' ? $(el) : el;
  el.textContent = text || '';
  el.className = 'msg ' + (text ? kind : '');
}

// 角色卡表单：根据后端给的字段生成输入框
function sheetInputs(container, fields, sheet = {}, disabled = false) {
  container.innerHTML =
    `<label>角色姓名</label><input name="name" maxlength="30" value="${esc(sheet.name || '')}" ${disabled ? 'disabled' : ''}>` +
    '<div class="grid">' + fields.map(f =>
      `<div><label>${esc(f.label)}</label><input name="${f.key}" type="number" inputmode="numeric" min="${f.min}" max="${f.max}" value="${sheet[f.key] ?? ''}" ${disabled ? 'disabled' : ''}></div>`
    ).join('') + '</div>';
}

function readSheet(container, fields) {
  const out = { name: $('[name=name]', container).value.trim() };
  for (const f of fields) {
    const v = $(`[name=${f.key}]`, container).value.trim();
    out[f.key] = v === '' ? NaN : Number(v);
  }
  return out;
}

function fmtTime(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function logout(kind = 'player') {
  await api('/api/logout', { kind });
  location.href = kind === 'kp' ? '/kp/login' : '/';
}

// 页面脚本出错时不要只剩空白：在顶部显示一行提示，玩家可以截图发给 KP
window.addEventListener('error', e => {
  if (document.getElementById('void-err')) return;
  const d = document.createElement('div');
  d.id = 'void-err';
  d.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9999;background:#7a1f24;color:#fff;font:13px/1.5 monospace;padding:8px 12px;white-space:pre-wrap';
  d.textContent = '页面出错，请刷新（电脑按 Ctrl+F5）。还不行的话把这行截图发给 KP：\n' + (e.message || '') + ' @ ' + String(e.filename || '').split('/').pop() + ':' + (e.lineno || '');
  (document.body || document.documentElement).appendChild(d);
});
