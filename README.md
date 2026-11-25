# void-minigames

CoC 模组《VOID》的外置小游戏。网页形式，电脑和手机都能玩，用来在部分剧情节点代替骰子判定。

## 目录

```
games/
  hack/          弹幕骇入（拘留所骇入；之后也用于 50 层全息投影、门禁锁、骇入鸣宫）
    index.html   单个文件，直接用浏览器打开即可
docs/
  设计计划.md    全部小游戏的设计计划、剧情位置、开发顺序
```

## 当前进度

| 游戏 | 状态 |
|---|---|
| 弹幕骇入 | 单机版完成：三个关卡、三档难度、练习模式、音效与 BGM；已部署 |
| 录像排序、记忆拼图 | 未开始 |
| 迷宫、潜行 | 未开始 |
| KP 控制台、编辑器 | 未开始 |
| 部署 | 完成（静态网页），国内访问测试通过 |
| 联机 | 未开始 |

## 本地试玩

下载 `games/hack/index.html`，用浏览器打开。

## 部署

- 地址：https://void.岸山.space/hack/
- 服务器：1Panel + OpenResty 静态网站，代号 `void.xn--rht5f.space`；证书使用 Cloudflare 源站证书 `*.xn--rht5f.space`；Cloudflare 代理开启。
- 网站 root：`/opt/1panel/apps/openresty/openresty/www/sites/void.xn--rht5f.space/index`（本仓库克隆在这里）
- 运行目录：`/games`（只公开 games 文件夹，docs、tools、.git 不对外）
- 服务器用只读部署密钥 `~/.ssh/void_deploy` 拉取，SSH 别名 `github-void`

### 更新

```
cd /opt/1panel/apps/openresty/openresty/www/sites/void.xn--rht5f.space/index && git pull
```

建议在两次跑团之间更新，不要在有人正在玩小游戏时更新。
