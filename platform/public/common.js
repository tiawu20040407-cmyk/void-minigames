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
