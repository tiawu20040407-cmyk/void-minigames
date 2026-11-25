"""生成两首可无缝循环的 BGM。运行：python3 tools/audio/bgm.py
输出 games/hack/audio/bgm-stage.mp3、bgm-boss.mp3。

无缝循环的做法：把整首曲子连续渲染两遍，混响、延迟的尾巴会从第一遍延续到第二遍，
然后只截取第二遍。这样截下来的开头已经带着“上一轮”的尾巴，循环接缝处听不出断点。"""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from dsp import *

OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'games', 'hack', 'audio')


# ---------------- 乐器 ----------------
def kick(hard=False):
    d = 0.38
    body = osc('sine', np.concatenate([sweep(170 if hard else 150, 42, 0.12), np.full(n_(d) - n_(0.12), 42.0)]), d)
    x = body * expdec(d, 0.16 if hard else 0.13)
    click = hp(noise(0.004), 3000) * 0.5
    x[:len(click)] += click
    return soft(x * (1.6 if hard else 1.2), 2.0) * 0.9


def snare():
    d = 0.25
    return bp(noise(d), 1200, 7000) * expdec(d, 0.07) * 0.6 + osc('tri', 190, d) * expdec(d, 0.04) * 0.5


def clap():
    d = 0.3
    x = np.zeros(n_(d))
    for k in range(3):
        b = bp(noise(0.012), 900, 3500) * 0.7
        s0 = n_(k * 0.011); x[s0:s0 + len(b)] += b
    tail = bp(noise(d), 900, 3500) * expdec(d, 0.09) * 0.45
    return x + tail


def hat(open_=False):
    d = 0.2 if open_ else 0.05
    return hp(noise(d), 8000, 4) * expdec(d, 0.07 if open_ else 0.014) * 0.32


def bass(m, d, cut=700, drive=1.0):
    f = mtof(m)
    x = osc('saw', f, d + 0.06) + osc('square', f / 2, d + 0.06) * 0.5
    x = lp(x, cut, 4) * adsr(d, 0.004, 0.12, 0.75, 0.06)[:n_(d + 0.06)]
    return soft(x * drive, 1.5) * 0.55


def pad(ms, d, cut=1500, att=0.5, rel=1.0):
    """返回 (左, 右)"""
    n = n_(d + rel)
    L = np.zeros(n); R = np.zeros(n)
    env = adsr(d, att, 0.4, 0.8, rel)[:n]
    for i, m in enumerate(ms):
        for j, det in enumerate((-0.11, 0.0, 0.12)):
            v = osc('saw', mtof(m + det), d + rel, ph0=rng.random())
            v = fit(v, n)
            if (i + j) % 2: L += v
            else: R += v
    L = lp(L, cut, 2) * env * 0.11; R = lp(R, cut, 2) * env * 0.11
    return L, R


def pluck(m, d=0.2, cut=3500):
    x = osc('pulse25', mtof(m), d) * 0.6 + osc('saw', mtof(m) * 1.003, d) * 0.4
    return lp(x, cut, 2) * expdec(d, 0.09) * 0.32


def lead(m, d, cut=2600, dist=0.0):
    t = tt(d + 0.2)
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.5 * t) * np.clip((t - 0.15) / 0.2, 0, 1)
    f = mtof(m) * vib
    x = osc('saw', f, d + 0.2) + osc('saw', f * 1.005, d + 0.2) * 0.8 + osc('square', f / 2, d + 0.2) * 0.25
    x = lp(x, cut, 2) * adsr(d, 0.015, 0.15, 0.75, 0.2)[:len(x)]
    if dist: x = soft(x * (1 + dist * 4), 1 + dist * 2)
    return x * 0.22


def stab(ms, d=0.18, cut=2200):
    x = sum(osc('saw', mtof(m), d) + osc('saw', mtof(m) * 1.006, d) for m in ms)
    return soft(lp(x, cut, 2) * expdec(d, 0.07) * 0.25, 2.5) * 0.5


def riser(d):
    t = np.linspace(0, 1, n_(d))
    x = noise(d)
    x = svf_lp(x, 300 * (40 ** t), q=1.2)
    return x * t ** 2 * 0.35


# ---------------- 混音器 ----------------
class Song:
    def __init__(self, bpm, bars):
        self.beat = 60 / bpm
        self.bar = self.beat * 4
        self.L = self.bar * bars
        self.N = n_(self.L * 2) + n_(4)          # 两遍 + 4 秒余量
        self.bus = {k: np.zeros((2, self.N)) for k in ('drums', 'bass', 'pad', 'lead', 'fx')}
        self.kicks = []

    def add(self, bus, sig, t, pan=0.0, gain=1.0):
        s0 = n_(t)
        if isinstance(sig, tuple):
            l, r = sig
        else:
            a = (pan + 1) * np.pi / 4
            l, r = sig * np.cos(a) * 1.41, sig * np.sin(a) * 1.41
        m = min(len(l), self.N - s0)
        if m <= 0: return
        self.bus[bus][0, s0:s0 + m] += l[:m] * gain
        self.bus[bus][1, s0:s0 + m] += r[:m] * gain

    def kick(self, t, hard=False):
        self.add('drums', kick(hard), t); self.kicks.append(t)

    def render(self, duck=0.55, pad_wet=0.35, lead_wet=0.25, delay_beats=0.75, delay_fb=0.35):
        N = self.N
        # 侧链压缩：底鼓响时压低贝斯、铺底和主旋律
        env = np.ones(N)
        tt_ = np.arange(N) / SR
        for t in self.kicks:
            s0 = n_(t); m = min(n_(0.35), N - s0)
            if m > 0:
                env[s0:s0 + m] = np.minimum(env[s0:s0 + m], 1 - duck * np.exp(-np.arange(m) / SR / 0.11))
        for k in ('bass', 'pad', 'lead'):
            self.bus[k] *= env
        # 主旋律：乒乓延迟
        dl = n_(self.beat * delay_beats)
        ld = self.bus['lead']
        mono = ld[0] + ld[1]
        out = ld.copy()
        for i in range(1, 6):
            sh = np.zeros(N)
            sh[dl * i:] = mono[:N - dl * i] * (delay_fb ** i) * 0.5
            out[i % 2] += lp(sh, 4000)            # 奇数次回声在右，偶数次在左
        self.bus['lead'] = out
        # 混响
        def rev(x, wet, seed, d=2.4, decay=0.7):
            irL = make_ir(d, decay, seed); irR = make_ir(d, decay, seed + 1)
            yl = ss.fftconvolve(x[0], irL)[:N]; yr = ss.fftconvolve(x[1], irR)[:N]
            return x * (1 - wet * 0.5) + np.stack([yl, yr]) * wet
        self.bus['pad'] = rev(self.bus['pad'], pad_wet, 21)
        self.bus['lead'] = rev(self.bus['lead'], lead_wet, 23)
        self.bus['fx'] = rev(self.bus['fx'], 0.4, 25)
        self.bus['drums'] = rev(self.bus['drums'], 0.07, 27, d=1.0, decay=0.25)
        mix = sum(self.bus.values())
        mix = np.stack([hp(mix[0], 28), hp(mix[1], 28)])
        # 截取第二遍
        a, b = n_(self.L), n_(self.L) + n_(self.L)
        x = mix[:, a:b]
        return x

    def stutter_at(self, x, t, slice_beats=1 / 8, length_beats=1):
        """在最终混音的 t（拍）处做故障断续：重复一小片"""
        s0 = n_(t * self.beat); sl = n_(slice_beats * self.beat); L = n_(length_beats * self.beat)
        seg = x[:, s0:s0 + sl].copy()
        reps = int(np.ceil(L / sl))
        rep = np.tile(seg, (1, reps))[:, :L]
        fade = np.ones(L); fade[-n_(0.005):] = np.linspace(1, 0, n_(0.005))
        x[:, s0:s0 + L] = rep * fade + x[:, s0:s0 + L] * (1 - fade)
        return x


def master(x, target_rms=0.16):
    x = x / (np.sqrt(np.mean(x ** 2)) + 1e-9) * target_rms
    x = soft(x, 1.3)
    return x / np.max(np.abs(x)) * 0.85          # 留余量：mp3 解码后峰值会略升


# ---------------- 普通关卡：A 小调，120 BPM，32 小节 ----------------
def song_stage():
    S = Song(120, 32)
    b = S.beat
    CH1 = [((57, 60, 64), 45), ((53, 57, 60), 41), ((55, 60, 64), 48), ((55, 59, 62), 43)]   # Am F C G
    CH2 = [((57, 60, 64), 45), ((53, 57, 60), 41), ((57, 62, 65), 38), ((56, 59, 64), 40)]   # Am F Dm E
    MEL = [  # (小节内拍, 音高, 拍长)
        [(0, 69, 1.5), (1.5, 72, .5), (2, 76, 1), (3, 74, 1)],
        [(0, 72, 1.5), (1.5, 69, .5), (2, 72, 1), (3, 69, 1)],
        [(0, 67, 1), (1, 72, 1), (2, 76, 1.5), (3.5, 74, .5)],
        [(0, 74, 2), (2, 71, 1), (3, 67, 1)],
        [(0, 76, 1.5), (1.5, 74, .5), (2, 72, 1), (3, 76, 1)],
        [(0, 77, 2), (2, 76, 1), (3, 72, 1)],
        [(0, 74, 1), (1, 77, 1), (2, 81, 1.5), (3.5, 79, .5)],
        [(0, 80, 2), (2, 76, 1), (3, 71, 1)],
    ]
    ARP = [0, 1, 2, 1, 2, 0, 1, 2, 0, 2, 1, 2, 3, 2, 1, 2]
    for rep in (0, 1):
        off = rep * S.L
        for bar in range(32):
            sec = bar // 8                      # 0=A 1=B 2=C 3=D
            prog = CH1 if sec in (0, 1) else CH2
            ch, root = prog[bar % 4]
            t0 = off + bar * S.bar
            # 铺底
            S.add('pad', pad(ch, S.bar * 0.98, cut=1100 if sec == 3 else 1500), t0, gain=1.7 if sec == 0 else (1.3 if sec != 3 else 1.5))
            # 贝斯
            if sec != 3:
                for i in range(8):
                    m = root + (12 if i in (3, 6) else 0)
                    if sec == 0 and i % 2 == 0 and i not in (0, 4): continue
                    S.add('bass', bass(m, b * 0.45, cut=650 + 250 * (sec == 2)), t0 + i * b / 2)
            else:
                S.add('bass', bass(root, S.bar * 0.9, cut=350), t0)
            # 琶音
            if sec >= 1 or bar >= 4:
                tones = list(ch) + [ch[0] + 12]
                for i in range(16):
                    if sec == 3 and i % 2: continue
                    S.add('lead', pluck(tones[ARP[i]] + 12, 0.22, cut=2500 + 1500 * (sec == 2)), t0 + i * b / 4,
                          pan=-0.5 if i % 2 else 0.5, gain=0.8)
            # 主旋律
            if sec == 2:
                for (bt, m, dl) in MEL[bar % 8]:
                    S.add('lead', lead(m, dl * b * 0.95), t0 + bt * b, gain=1.0)
            # 鼓
            for i in range(4):
                tb = t0 + i * b
                if sec in (1, 2) or (sec == 0 and i == 0) or (sec == 3 and i == 0 and bar % 2 == 0):
                    S.kick(tb)
                if sec in (1, 2) and i in (1, 3):
                    S.add('drums', clap(), tb, gain=0.8)
            for i in range(8 if sec != 2 else 16):
                step = (b / 2) if sec != 2 else (b / 4)
                open_ = sec != 2 and i % 2 == 1
                if sec == 3 and i % 2 == 0: continue
                S.add('drums', hat(open_), t0 + i * step, pan=0.3, gain=0.8 if i % 2 else 0.5)
            # D 段最后一小节：上升噪声，引回开头
            if sec == 3 and bar == 31:
                S.add('fx', riser(S.bar), t0, gain=1.0)
    x = S.render(duck=0.38, pad_wet=0.4, lead_wet=0.22)
    for beat in (8 * 4 * 3 + 7 * 4 + 3, 8 * 4 * 3 + 3 * 4 + 3, 8 * 4 * 1 + 7 * 4 + 3.5):   # 段落末尾的故障断续
        x = S.stutter_at(x, beat, 1 / 8, 0.5 if beat % 1 else 1)
    return master(x)


# ---------------- Boss：D 弗里几亚，150 BPM，32 小节 ----------------
def song_boss():
    S = Song(150, 32)
    b = S.beat
    PROG = [((62, 65, 69), 38), ((63, 67, 70), 39), ((62, 65, 69), 38), ((58, 62, 65), 34)]   # Dm Eb Dm Bb
    MOTIF = [
        [(0, 74, .5), (.5, 74, .5), (1, 75, 1), (2, 74, .5), (2.5, 72, .5), (3, 69, 1)],
        [(0, 70, 1), (1, 69, .5), (1.5, 67, .5), (2, 69, 2)],
        [(0, 74, .5), (.5, 74, .5), (1, 75, 1), (2, 77, .5), (2.5, 75, .5), (3, 74, 1)],
        [(0, 72, 1), (1, 70, 1), (2, 69, 1.5), (3.5, 70, .5)],
    ]
    for rep in (0, 1):
        off = rep * S.L
        for bar in range(32):
            sec = bar // 8
            ch, root = PROG[bar % 4]
            t0 = off + bar * S.bar
            half = sec == 3 and bar < 30      # D 段前半是半速段
            # 贝斯：16 分音符脉冲
            if not half:
                for i in range(16):
                    m = root + (12 if i % 4 == 2 else 0)
                    S.add('bass', bass(m, b * 0.22, cut=500 + 400 * (sec >= 1), drive=2.0), t0 + i * b / 4, gain=0.9)
            else:
                S.add('bass', bass(root, S.bar * 0.9, cut=300, drive=2.0), t0)
            # 和弦：反拍的失真短音
            if sec in (0, 1, 2) and not half:
                for i in (0.5, 1.5, 2.75, 3.5):
                    S.add('lead', stab(ch, 0.16), t0 + i * b, pan=-0.4 if i % 1 else 0.4, gain=0.7)
            # 合唱般的铺底
            if sec in (2, 3):
                S.add('pad', pad([m - 12 for m in ch] + [ch[0]], S.bar * 0.98, cut=1200, att=0.3), t0, gain=1.1)
            # 主旋律
            if sec in (1, 2):
                for (bt, m, dl) in MOTIF[bar % 4]:
                    S.add('lead', lead(m + (12 if sec == 2 and bar % 8 >= 4 else 0), dl * b * 0.92, cut=3000, dist=0.6), t0 + bt * b)
            # 鼓
            for i in range(4):
                tb = t0 + i * b
                if half:
                    if i == 0: S.kick(tb, True)
                    if i == 2: S.add('drums', snare(), tb, gain=1.0)
                    continue
                S.kick(tb, True)
                if i in (1, 3): S.add('drums', snare(), tb, gain=0.9); S.add('drums', clap(), tb, gain=0.5)
                if i == 3 and bar % 2: S.kick(tb + b * 0.75, True)
            for i in range(16):
                if half and i % 2: continue
                S.add('drums', hat(i % 4 == 2), t0 + i * b / 4, pan=0.35, gain=0.75 if i % 2 else 0.45)
            if bar in (30, 31):
                S.add('fx', riser(S.bar * 2) if bar == 30 else np.zeros(1), t0, gain=1.2)
    x = S.render(duck=0.6, pad_wet=0.35, lead_wet=0.18, delay_beats=0.5, delay_fb=0.3)
    for beat in (8 * 4 + 7 * 4 + 3, 16 * 4 + 7 * 4 + 3.5, 24 * 4 + 3 * 4 + 3):
        x = S.stutter_at(x, beat, 1 / 16 if beat % 1 else 1 / 8, 0.5 if beat % 1 else 1)
    return master(x, 0.17)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for name, fn in (('bgm-stage', song_stage), ('bgm-boss', song_boss)):
        x = fn()
        write_mp3(os.path.join(OUT, name + '.mp3'), x, kbps=128, stereo=True)
        print(name, f'{x.shape[1]/SR:.1f}s')
