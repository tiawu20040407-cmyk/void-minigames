# VOID 平台

登录、注册、KP 控制台（审核、即时解锁、场景预设、秘密消息、预览视角、系统状态），以及受保护的游戏文件。不依赖任何第三方包，Node 18 以上即可运行，不需要 `npm install`。

## 文件

```
platform/
  server.js        后端入口
  lib/db.js        数据存储（data/db.json，每天自动备份到 data/backup/，保留 14 天）
  lib/auth.js      密码散列、邀请码、登录限流
  lib/entries.js   自动列出 games/ 下的游戏（名字和说明在控制台填写）
  lib/events.js    服务器推送（SSE），让玩家页面和控制台即时更新
  public/          页面
  tools/reset-kp.js  忘记 KP 密码时用
  data/            运行数据（不进仓库）
```

## 地址

| 地址 | 内容 |
|---|---|
| `/` | 登录页 |
| `/register` | 新职员登记（邀请码 + 角色卡） |
| `/intranet` | 警察厅内网（访客可看） |
| `/terminal` | 玩家终端（已审核的仿生人 HO2、HO4 看到 HUD：`hud.html` + `hud.js` + `hud.css`） |
| `/kp/login` | KP 登录（账号 + 密码 + 密令） |
| `/kp` | KP 控制台 |
| `/kp/setup` | KP 初始化，只在还没有 KP 账号时存在 |
| `/games/<游戏>/` | 游戏文件，登录且有权限才能打开，否则 404 |

旧的公开地址 `/hack/`、`/footage/` 平台上线后返回 404。

## 第一次部署（1Panel）

下面的菜单名按 1Panel v1 写的，版本不同可能略有出入；对不上的话截图发给 Claude。

### 1. 拉取代码

```
cd /opt/1panel/apps/openresty/openresty/www/sites/void.xn--rht5f.space/index && git pull
```

### 2. 创建 Node.js 运行环境

1Panel → **网站** → **运行环境** → **Node.js** → **创建运行环境**：

| 项目 | 填写 |
|---|---|
| 名称 | `void-platform` |
| 源码目录 | `/opt/1panel/apps/openresty/openresty/www/sites/void.xn--rht5f.space/index` |
| 启动命令 | 选脚本 `start`（如果要求填写自定义命令：`npm run start`） |
| 应用端口 | `3100` |
| 外部映射端口 | `3100` |
| 端口外部访问 | **关闭**（只让本机的 OpenResty 访问） |
| Node 版本 | 18 以上任选（推荐 20 或 22） |

第一次创建要下载 Node.js 镜像，可能需要几分钟。创建后状态应为“运行中”。**不要**在防火墙里开放 3100 端口，外部访问全部走 443。

### 3. 查看 KP 初始化码

在运行环境列表里点 `void-platform` 的 **日志**，找到这样一行：

```
[VOID] 还没有 KP 账号。KP 初始化码：SETUP-XXXX-XXXX
```

### 4. 把网站转给平台

1Panel → **网站** → 点 `void.xn--rht5f.space` → **反向代理** → **创建**：

| 项目 | 填写 |
|---|---|
| 名称 | `platform` |
| 前端请求路径 | `/` |
| 后端代理地址 | 协议选 `http`，地址框只填 `127.0.0.1:3100`（不要再写 `http://`，否则会报 invalid port in upstream） |

保存。之后整个网站都由平台处理，原来的静态目录不再直接对外。

### 5. 初始化 KP 账号

打开 `https://void.岸山.space/kp/setup`，填初始化码、密码、密令。账号名是 **咕咕**。完成后这个页面会变成 404。

### 6. 检查

- `https://void.岸山.space/` 显示登录页。
- `https://void.岸山.space/hack/` 和 `/games/hack/`（未登录）都是 404。
- KP 登录后，控制台“直接打开游戏”能打开骇入和录像排序。
- 控制台点“重置测试账号”，用 test-ho2 在手机上登录看看。

## 之后更新

- 只改了游戏（`games/` 下）：`git pull` 即可。新游戏一分钟内会出现在控制台“游戏入口”里，默认叫“未命名程序”、对所有人隐藏。
- 改了平台（`platform/` 下）：`git pull` 后在运行环境里 **重启** `void-platform`。

## 常见问题

- **玩家页面不即时更新**（要手动刷新才变）：即时推送用的是 SSE，经过 OpenResty 和 Cloudflare 通常不用额外设置。如果不生效，把浏览器开发者工具里 `/api/events` 这个请求的截图发给 Claude。

- **忘记 KP 密码或密令**：在运行环境的终端（或服务器上源码目录里）执行 `node platform/tools/reset-kp.js`，然后重启平台，日志里会出现新的初始化码。玩家数据不受影响。
- **恢复备份**：停止平台，用 `platform/data/backup/db-日期.json` 覆盖 `platform/data/db.json`，再启动。
- **内存**：启动命令限制了内存上限 256MB，平时占用约 50MB，不影响 SillyTavern。

## 自动测试

改完代码后在本地跑一遍，覆盖登录、注册、审核、解锁推送、游戏访问控制、预设、消息、预览等全部流程：

```
python tools/test/platform_test.py
```

需要 Python 和 playwright（`pip install playwright && python -m playwright install chromium`）。测试使用临时数据目录，不影响正式数据。
