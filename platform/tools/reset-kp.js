// 忘记 KP 密码或密令时使用：删除 KP 账号，重启平台后日志里会出现新的初始化码。
//   node platform/tools/reset-kp.js
'use strict';
const DB = require('../lib/db');
const db = DB.load();
const before = db.users.length;
const kpIds = db.users.filter(u => u.role === 'kp').map(u => u.id);
db.users = db.users.filter(u => u.role !== 'kp');
for (const [k, s] of Object.entries(db.sessions)) if (kpIds.includes(s.uid)) delete db.sessions[k];
DB.save();
console.log(before === db.users.length ? '没有 KP 账号，无需重置。' : 'KP 账号已删除。请重启平台，在日志里查看新的初始化码。');
