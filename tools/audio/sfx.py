"""生成骇入游戏的音效。运行：python3 tools/audio/sfx.py
输出到 games/hack/audio/。短音效存 wav（无开头空白），长音效存 mp3。"""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from dsp import *

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'games', 'hack', 'audio')


def mix(*parts):
    n = max(len(p) for p in parts)
    return sum(fit(p, n) for p in parts)


def boom(d, f_hi, f_lo, tau, sub_f0=110, sub_f1=32, sub_amp=0.9, crackle=0.0):
    """爆炸：扫频噪声 + 低频冲击 + 碎裂颗粒"""
    nz = noise(d) * expdec(d, tau)
    nz = svf_lp(nz, sweep(f_hi, f_lo, d), q=0.9)
    sub = osc('sine', sweep(sub_f0, sub_f1, d), d) * expdec(d, tau * 0.8) * sub_amp
    parts = [nz * 1.2, sub]
    if crackle:
        c = np.zeros(n_(d))
        g = n_(0.004)
        grain = noise(0.004) * np.hanning(g)
        for s0 in rng.integers(0, int(n_(d) * 0.7), int(40 * crackle)):
            m = min(g, len(c) - s0); c[s0:s0 + m] += grain[:m] * rng.uniform(0.3, 1)
        c = hp(c, 1500) * expdec(d, tau * 1.5) * 0.6 * crackle
        parts.append(c)
    return mix(*parts)


S = {}

# 击中敌人：金属感的短“咔”
d = 0.07
S['hit'] = mix(
    osc('square', sweep(1100, 520, d), d) * expdec(d, 0.012) * 0.5,
    hp(noise(d), 3500) * expdec(d, 0.006) * 0.6,
    osc('sine', sweep(260, 140, d), d) * expdec(d, 0.02) * 0.5,
)

# 击落子弹：玻璃碎裂般的“叮”
d = 0.09
S['pop'] = mix(
    osc('sine', sweep(2600, 1700, d), d) * expdec(d, 0.018) * 0.6,
    bp(noise(d), 4000, 9000) * expdec(d, 0.012) * 0.8,
)

# 小怪击破
d = 0.45
S['small'] = crush(boom(d, 7000, 250, 0.09, 160, 45, 0.8, crackle=0.6), bits=8, hold=2)

# 大型击破（防火墙、扫描器）
d = 1.1
x = boom(d, 9000, 120, 0.22, 95, 28, 1.0, crackle=1.0)
x = mix(x, osc('saw', sweep(420, 70, 0.5), 0.5) * expdec(0.5, 0.15) * 0.15)
S['big'] = reverb(x, d=1.2, decay=0.35, wet=0.25, seed=3)

# 护盾解除 / Boss 阶段转换：冲击 + 能量下坠 + 故障断续
d = 1.6
imp = boom(0.9, 10000, 90, 0.3, 80, 24, 1.1, crackle=1.2)
whine = lp(osc('saw', sweep(1400, 55, d), d) + osc('saw', sweep(1407, 56, d), d), 3000) * expdec(d, 0.5) * 0.25
x = mix(imp, whine)
x = stutter(x, 0.035, 4, start_d=0.35)
S['shield'] = reverb(x, d=2.0, decay=0.6, wet=0.3, seed=5)

# 玩家受伤：刺耳的数字故障
d = 0.32
x = mix(
    osc('square', sweep(340, 70, d), d) * expdec(d, 0.12) * 0.6,
    bp(noise(d), 800, 5000) * expdec(d, 0.06) * 0.7,
    osc('saw', sweep(90, 45, d), d) * expdec(d, 0.1) * 0.5,
)
x = crush(x, bits=4, hold=6)
S['hurt'] = stutter(x, 0.025, 3, start_d=0.02)

# 激光预警：两声短促警报
d = 0.07
beep = lp(osc('square', 1046, d) * 0.5 + osc('square', 1052, d) * 0.5, 5000) * adsr(d - 0.01, 0.003, 0.02, 0.7, 0.01)
gap = np.zeros(n_(0.05))
S['warn'] = np.concatenate([beep, gap, beep]) * 0.7

# 激光发射：充能 + 嗡鸣
d = 1.05
buzz = osc('saw', 110, d) + osc('saw', 110.7, d) * 0.8 + osc('square', 55, d) * 0.4
trem = 0.7 + 0.3 * np.sin(2 * np.pi * 28 * tt(d))
buzz = lp(buzz, 1800) * trem
zap = osc('sine', sweep(3000, 400, 0.12), 0.12) * expdec(0.12, 0.04)
x = mix(zap, buzz * adsr(d - 0.25, 0.02, 0.1, 0.8, 0.25) * 0.5, hp(noise(d), 2500) * 0.06 * trem)
S['laser'] = x

# 开场 LINK START：数字上行琶音 + 扫频
notes = [57, 60, 64, 69, 72, 76]
x = np.zeros(n_(1.2))
for i, m in enumerate(notes):
    dd = 0.18
    v = lp(osc('pulse25', mtof(m), dd), 4000) * expdec(dd, 0.06) * 0.35
    s0 = n_(i * 0.07)
    x[s0:s0 + len(v)] += v[:len(x) - s0]
x = mix(x, lp(noise(1.2), 6000) * np.linspace(0, 1, n_(1.2)) ** 3 * expdec(1.2, 2) * 0.15)
S['link'] = reverb(x, d=1.0, decay=0.3, wet=0.3, seed=9)

# 新一波
d = 0.14
t1 = lp(osc('tri', mtof(76), d) + osc('square', mtof(76), d) * 0.3, 5000) * expdec(d, 0.06)
t2 = lp(osc('tri', mtof(81), 0.25) + osc('square', mtof(81), 0.25) * 0.3, 5000) * expdec(0.25, 0.1)
S['wave'] = reverb(np.concatenate([t1, t2]) * 0.6, d=0.8, decay=0.25, wet=0.25, seed=11)

# 骇入成功：爆炸 + 下行钟声（FM）
d = 2.4
x = boom(1.0, 9000, 100, 0.25, 90, 26, 1.0, crackle=0.8)
bell = np.zeros(n_(d))
for i, m in enumerate([88, 84, 79, 76, 72]):
    bd = 1.4
    tb = tt(bd)
    f = mtof(m)
    v = np.sin(2 * np.pi * f * tb + 2.2 * np.exp(-tb / 0.3) * np.sin(2 * np.pi * f * 3.5 * tb)) * expdec(bd, 0.45) * 0.28
    s0 = n_(0.45 + i * 0.13)
    m_ = min(len(v), len(bell) - s0)
    bell[s0:s0 + m_] += v[:m_]
S['win'] = reverb(mix(x, bell), d=2.2, decay=0.7, wet=0.35, seed=13)

# 骇入失败：断线、下坠、静电
d = 1.6
x = mix(
    lp(osc('saw', sweep(500, 35, d), d) + osc('saw', sweep(503, 36, d), d), 2500) * expdec(d, 0.6) * 0.45,
    bp(noise(d), 1500, 7000) * expdec(d, 0.4) * 0.35,
    osc('square', sweep(180, 40, 0.6), 0.6) * expdec(0.6, 0.2) * 0.4,
)
x = crush(x, bits=5, hold=5)
x = stutter(x, 0.04, 5, start_d=0.1)
S['lose'] = reverb(x, d=1.5, decay=0.5, wet=0.25, seed=17)

# 按钮
d = 0.04
S['click'] = mix(osc('square', 1800, d) * expdec(d, 0.008) * 0.4, hp(noise(d), 5000) * expdec(d, 0.004) * 0.3)

# ---------- 输出 ----------
WAV = {'hit', 'pop', 'small', 'hurt', 'warn', 'wave', 'click'}   # 短音效：wav，无开头空白
os.makedirs(OUT, exist_ok=True)
MAXLEN = {'big': 1.4, 'shield': 2.2, 'link': 1.4, 'wave': 0.6, 'win': 3.0, 'lose': 2.0}
for k, x in S.items():
    x = norm(trim_tail(x, 2e-4), 0.89)
    if k in MAXLEN and len(x) > n_(MAXLEN[k]):
        x = fade_out(x[:n_(MAXLEN[k])], MAXLEN[k] * 0.35)
    x = fade_out(x, 0.01)
    if k in WAV:
        write_wav(os.path.join(OUT, k + '.wav'), x)
    else:
        write_mp3(os.path.join(OUT, k + '.mp3'), x, kbps=96)
    print(k, f'{len(x)/SR:.2f}s')
