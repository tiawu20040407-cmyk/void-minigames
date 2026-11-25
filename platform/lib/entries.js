// 游戏入口：自动列出 games/ 下含 index.html 的文件夹。
// 名字和说明由 KP 在控制台填写，存在数据库 db.entries 里；新发现的游戏默认叫“未命名程序”，对所有人隐藏。
'use strict';
const fs = require('fs');
const path = require('path');

// 第一次发现时用的默认名字（之后以 KP 填写的为准）
const DEFAULT_NAMES = {
  hack: '骇入程序（演示）',
  footage: '监控录像分析',
};

function scan(gamesDir) {
  try {
    return fs.readdirSync(gamesDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^[a-z0-9_-]+$/.test(d.name) && fs.existsSync(path.join(gamesDir, d.name, 'index.html')))
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
}

// 把磁盘上的游戏和数据库里的记录对齐。返回是否有变化。
function sync(db, gamesDir) {
  db.entries = db.entries || {};
  const found = scan(gamesDir);
  let changed = false;
  for (const dir of found) {
    if (!db.entries[dir]) {
      db.entries[dir] = { name: DEFAULT_NAMES[dir] || '未命名程序', desc: '', createdAt: Date.now() };
      changed = true;
    }
  }
  for (const dir of Object.keys(db.entries)) {
    const missing = !found.includes(dir);
    if (!!db.entries[dir].missing !== missing) { db.entries[dir].missing = missing; changed = true; }
  }
  return changed;
}

// 当前可用的入口列表（服务器上文件已删除的不列出）
function list(db) {
  return Object.entries(db.entries || {})
    .filter(([, e]) => !e.missing)
    .map(([id, e]) => ({ id, dir: id, name: e.name, desc: e.desc || '' }));
}

module.exports = { sync, list };
