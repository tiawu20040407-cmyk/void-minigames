# void-minigames

CoC 模组《VOID》的外置小游戏。网页形式，电脑和手机都能玩，用来在部分剧情节点代替骰子判定。

## 目录

```
games/
  hack/          弹幕骇入（拘留所骇入；之后也用于 50 层全息投影、门禁锁、骇入鸣宫）
    index.html   单个文件，直接用浏览器打开即可
  footage/       录像排序（第二现场）
    index.html   单个文件；替换图片放进 footage/assets/（见 docs/素材-录像排序.md）
platform/        平台：登录、注册、KP 控制台、受保护的游戏文件（见 platform/README.md）
tools/test/       自动测试（platform_test.py）
docs/
  设计计划.md    全部小游戏的设计计划、剧情位置、开发顺序
  平台计划.md    平台的整体计划和开发顺序
```

## 当前进度

| 游戏 | 状态 |
|---|---|
| 弹幕骇入 | 单机版完成：三个关卡、三档难度、练习模式、音效与 BGM；已部署 |
| 录像排序 | 第二版完成：新破绽、教学关卡、一羽小助手、演出效果；占位图，可替换 |
| 记忆拼图、梦境组装 | 未开始 |
| 迷宫、潜行 | 未开始 |
| KP 控制台、编辑器 | 未开始 |
| 部署 | 完成（静态网页），国内访问测试通过 |
| 联机 | 未开始 |
| 平台第 1 步（账号系统） | 完成：登录、邀请码注册、KP 登录与控制台、测试账号、游戏文件受保护 |
| 平台第 2 步（解锁与控制台） | 完成：即时推送、隐藏/锁定/开放、场景预设、秘密消息与已读、预览视角、入口自动发现、系统状态 |

## 本地试玩

下载 `games/hack/index.html` 或 `games/footage/index.html`，用浏览器打开。

## 部署

- 地址：https://void.岸山.space/ （平台上线后，游戏只能登录后从终端打开；旧地址 /hack/、/footage/ 返回 404）
- 平台的部署和更新步骤见 `platform/README.md`。
- 服务器：1Panel + OpenResty 静态网站，代号 `void.xn--rht5f.space`；证书使用 Cloudflare 源站证书 `*.xn--rht5f.space`；Cloudflare 代理开启。
- 网站 root：`/opt/1panel/apps/openresty/openresty/www/sites/void.xn--rht5f.space/index`（本仓库克隆在这里）
- 运行目录：`/games`（平台上线前的静态部署设置；上线后整个网站反向代理到平台 127.0.0.1:3100，只有平台允许的文件对外）
- 服务器用只读部署密钥 `~/.ssh/void_deploy` 拉取，SSH 别名 `github-void`

### 更新

```
cd /opt/1panel/apps/openresty/openresty/www/sites/void.xn--rht5f.space/index && git pull
```

改了 `platform/` 下的文件，pull 之后还要在 1Panel 运行环境里重启 `void-platform`。

建议在两次跑团之间更新，不要在有人正在玩小游戏时更新。
