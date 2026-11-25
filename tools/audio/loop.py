"""给现成的曲子找循环点，做成“前奏 + 循环”的 BGM。
用法：python3 tools/audio/loop.py 输入.mp3 输出.mp3 --a-min 4 --a-max 60 --b-min 90 --b-max 116 --min-len 45

找法：
1. 把曲子切成每帧约 23ms，每帧算 24 个频带的对数能量（音色 + 和声的大致轮廓）。
2. 对每个候选循环长度 L，算“第 t 帧之后 6 秒”和“第 t+L 帧之后 6 秒”的平均相似度。
   相似度最高的一对 (A, B=A+L) 就是：播放到 B 时跳回 A，接下来的音乐和原本 B 之后的几乎一样。
3. 在采样级别微调 A，让两处波形的相位对齐。
4. 把 B 前面一小段和 A 前面一小段交叉淡化，写进文件里。这样从 B 跳回 A 时没有断点。
输出文件到 B 为止（结尾淡出部分被丢掉），并打印 loopStart / loopEnd（秒）。"""
import argparse, os, sys, subprocess
import numpy as np
import scipy.signal as ss
sys.path.insert(0, os.path.dirname(__file__))
from dsp import SR, write_mp3

p = argparse.ArgumentParser()
p.add_argument('src'); p.add_argument('dst')
p.add_argument('--a-min', type=float, required=True); p.add_argument('--a-max', type=float, required=True)
p.add_argument('--b-min', type=float, required=True); p.add_argument('--b-max', type=float, required=True)
p.add_argument('--min-len', type=float, default=40)
p.add_argument('--win', type=float, default=6.0, help='比较窗口（秒）')
p.add_argument('--xfade', type=float, default=0.08, help='接缝交叉淡化（秒）')
p.add_argument('--kbps', type=int, default=128)
a = p.parse_args()

raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', a.src, '-ac', '2', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
x = np.frombuffer(raw, np.float32).reshape(-1, 2).T.astype(np.float64).copy()
m = x.mean(0)

# 1. 帧特征
hop, nfft = 1024, 4096
_, _, S = ss.stft(m, SR, nperseg=nfft, noverlap=nfft - hop)
S = np.abs(S) ** 2
edges = np.geomspace(40, 12000, 25)
fr = np.fft.rfftfreq(nfft, 1 / SR)
F = np.stack([S[(fr >= lo) & (fr < hi)].sum(0) for lo, hi in zip(edges[:-1], edges[1:])])
F = np.log(F + 1e-8)
F = (F - F.mean(1, keepdims=True))
F /= np.linalg.norm(F, axis=0, keepdims=True) + 1e-9          # 每帧单位向量 → 点积即余弦相似度
fps = SR / hop
W = int(a.win * fps)

def fi(t): return int(round(t * fps))
best = (-1, 0, 0)
for L in range(fi(a.min_len), fi(a.b_max - a.a_min) + 1):
    sim = np.einsum('ij,ij->j', F[:, :-L], F[:, L:])            # sim[t] = cos(F[t], F[t+L])
    win = np.convolve(sim, np.ones(W) / W, 'valid')             # 窗口平均：t 之后 W 帧
    lo = max(fi(a.a_min), fi(a.b_min) - L); hi = min(fi(a.a_max), fi(a.b_max) - L, len(win) - 1)
    if hi <= lo: continue
    t = lo + int(np.argmax(win[lo:hi])); v = win[t]
    if v > best[0]: best = (v, t, t + L)
score, fa, fb = best
A, B = int(fa * hop), int(fb * hop)

# 3. 采样级对齐：在 ±hop 内找让 A、B 附近波形最相关的偏移
seg = 4096
ref = m[B - seg:B + seg]
cand = m[A - seg - hop:A + seg + hop]
cc = ss.correlate(cand, ref, 'valid')
A = A - hop + int(np.argmax(cc))

# 4. 交叉淡化写进文件
c = int(a.xfade * SR)
t = np.linspace(0, np.pi / 2, c)
fo, fin = np.cos(t), np.sin(t)
y = x[:, :B].copy()
y[:, B - c:B] = x[:, B - c:B] * fo + x[:, A - c:A] * fin
y = np.clip(y, -1, 1)
write_mp3(a.dst, y, kbps=a.kbps, stereo=True)
print(f'similarity {score:.3f}  loopStart {A / SR:.4f}s  loopEnd {B / SR:.4f}s  loop length {(B - A) / SR:.2f}s  file {B / SR:.2f}s')
