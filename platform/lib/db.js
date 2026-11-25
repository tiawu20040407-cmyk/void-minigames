// 数据存储：一个 JSON 文件，写入时先写临时文件再改名，避免写到一半断电损坏。
// 规模很小（几个玩家），整份读进内存即可。
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.VOID_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backup');
const BACKUP_KEEP = 14;

const EMPTY = () => ({
  version: 1,
  nextId: 1,
  users: [],      // {id, username, role:'player'|'kp', pw, secret?, ho, kind, sheet, hpNow, status, test, createdAt}
  invites: [],    // {code, ho, createdAt, usedBy, usedAt, revoked}
  sessions: {},   // token -> {uid, exp}
  unlocks: {},    // uid -> {entryId: 'hidden'|'locked'|'open'}
  loginLog: [],   // {t, ip, username, kind, ok}
});

let db = null;

function load() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = Object.assign(EMPTY(), JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } else {
    db = EMPTY();
    save();
  }
  return db;
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

// 每天一份备份，保留最近 14 天
function backup() {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(BACKUP_DIR, `db-${day}.json`);
    if (!fs.existsSync(file) && fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, file);
    const all = fs.readdirSync(BACKUP_DIR).filter(f => /^db-\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  } catch (e) {
    console.error('[VOID] 备份失败', e.message);
  }
}

module.exports = { load, save, backup, get: () => db, DATA_DIR };
