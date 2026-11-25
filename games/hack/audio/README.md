# 音频文件

| 插槽 | 文件 | 来源 |
|---|---|---|
| shot | shot.wav | 魔王魂 maou_se_system42（剪成 0.13 秒） |
| hit / pop / small / hurt / warn / wave / click | *.wav | `tools/audio/sfx.py` 合成 |
| big / shield / laser / link / win / lose | *.mp3 | `tools/audio/sfx.py` 合成 |
| BGM stage（防火墙、数据流） | bgm-stage.mp3：前奏 0–22.55 秒，循环 22.55–84.89 秒 | HACK_NORMAL，`tools/audio/loop.py` 处理 |
| BGM boss（守卫程序） | bgm-boss.mp3：前奏 0–51.76 秒，循环 51.76–150.05 秒 | HACK_BOSS，`tools/audio/loop.py` 处理 |

原曲保存在 `tools/audio/src/`。`tools/audio/bgm.py` 可生成合成版 BGM（备用）。

## 重新生成

```
pip install numpy scipy        # 需要 ffmpeg
python3 tools/audio/sfx.py     # 音效（不会覆盖 shot.wav）
python3 tools/audio/bgm.py     # 合成版 BGM（备用）
python3 tools/audio/loop.py tools/audio/src/HACK_NORMAL.mp3 games/hack/audio/bgm-stage.mp3 --a-min 4 --a-max 70 --b-min 80 --b-max 116 --min-len 45
python3 tools/audio/loop.py tools/audio/src/HACK_BOSS.mp3 games/hack/audio/bgm-boss.mp3 --a-min 20 --a-max 100 --b-min 110 --b-max 153 --min-len 50
```

## 换成自己的文件

把文件放进本目录，在 `index.html` 的 `SOUND_FILES` / `BGM` 里改文件名；`SOUND_VOL` 调单独音量。
换 BGM 时用 `tools/audio/loop.py` 找循环点，把打印出的 loopStart / loopEnd 填进 `index.html` 的 `BGM`。很短的音效建议用 wav，mp3 开头会自带一小段空白。

直接双击打开 `index.html`（file://）时会改用 `<audio>` 元素播放，延迟稍大；部署到服务器后使用低延迟方式播放，BGM 无缝循环。
