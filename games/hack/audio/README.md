# 音频文件

| 插槽 | 文件 | 来源 |
|---|---|---|
| shot | shot.wav | 魔王魂 maou_se_system42（剪成 0.13 秒） |
| hit / pop / small / hurt / warn / wave / click | *.wav | `tools/audio/sfx.py` 合成 |
| big / shield / laser / link / win / lose | *.mp3 | `tools/audio/sfx.py` 合成 |
| BGM stage | bgm-stage.mp3（64 秒循环，A 小调 120 BPM） | `tools/audio/bgm.py` 合成 |
| BGM boss | bgm-boss.mp3（51.2 秒循环，D 弗里几亚 150 BPM） | `tools/audio/bgm.py` 合成 |

## 重新生成

```
pip install numpy scipy        # 需要 ffmpeg
python3 tools/audio/sfx.py     # 音效（不会覆盖 shot.wav）
python3 tools/audio/bgm.py     # BGM
```

## 换成自己的文件

把文件放进本目录，在 `index.html` 的 `SOUND_FILES` / `BGM_FILES` 里改文件名；`SOUND_VOL` 调单独音量。
换 BGM 时要同时改 `BGM_LEN`（循环长度，秒）。很短的音效建议用 wav，mp3 开头会自带一小段空白。

直接双击打开 `index.html`（file://）时会改用 `<audio>` 元素播放，延迟稍大；部署到服务器后使用低延迟方式播放，BGM 无缝循环。
