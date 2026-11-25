# 音频文件

把 mp3 或 wav 放在这个目录（很短的音效建议用 wav，没有 mp3 开头的空白），然后在 `index.html` 的 `SOUND_FILES` / `BGM_FILES` 里填上文件名。
没填的插槽会使用代码合成的占位音。

| 插槽 | 用途 |
|---|---|
| shot | 射击（最频繁，要轻、短） |
| hit | 击中敌人 |
| pop | 击落橙色子弹 |
| small | 小怪击破 |
| big | 防火墙、扫描器击破 |
| shield | 护盾解除、Boss 阶段转换 |
| hurt | 玩家受伤 |
| warn | 激光预警 |
| laser | 激光发射 |
| link | 开场 LINK START |
| wave | 新一波敌人 |
| win | 骇入成功 |
| lose | 骇入失败 |
| click | 按钮 |
| BGM: stage | 普通关卡（循环） |
| BGM: boss | Boss 关卡（循环） |

直接双击打开 `index.html`（file://）时，会改用 `<audio>` 元素播放，延迟稍大；部署到服务器后使用低延迟的方式播放。
