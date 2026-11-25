"""音频合成用的小工具库（numpy / scipy）。只在生成音频文件时使用，不会被游戏加载。"""
import numpy as np
import scipy.signal as ss
import subprocess, os, tempfile, wave

SR = 44100
rng = np.random.default_rng(7)


def n_(d):
    return max(1, int(round(d * SR)))


def tt(d):
    return np.arange(n_(d)) / SR


def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)


# ---------- 振荡器 ----------
def phase_of(freq, n):
    """freq 可以是数字或逐采样数组，返回 0..1 相位"""
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    return np.cumsum(f) / SR % 1.0


def osc(kind, freq, d, ph0=0.0):
    n = n_(d)
    ph = (phase_of(freq, n) + ph0) % 1.0
    if kind == 'sine':
        return np.sin(2 * np.pi * ph)
    if kind == 'saw':
        return 2 * ph - 1
    if kind == 'square':
        return np.where(ph < 0.5, 1.0, -1.0)
    if kind == 'pulse25':
        return np.where(ph < 0.25, 1.0, -1.0)
    if kind == 'tri':
        return 4 * np.abs(ph - 0.5) - 1
    raise ValueError(kind)


def sweep(f0, f1, d, curve='exp'):
    n = n_(d)
    x = np.linspace(0, 1, n)
    if curve == 'exp':
        return f0 * (f1 / f0) ** x
    return f0 + (f1 - f0) * x


def noise(d):
    return rng.standard_normal(n_(d))


# ---------- 包络 ----------
def expdec(d, tau):
    return np.exp(-tt(d) / tau)


def adsr(d, a, dcy, s, r):
    """d = 按住时长；返回长度 d + r"""
    n = n_(d + r)
    e = np.zeros(n)
    na, nd, nh = n_(a), n_(dcy), n_(d)
    i = 0
    seg = np.linspace(0, 1, na, endpoint=False); e[i:i + na] = seg[:max(0, min(na, n - i))]; i += na
    seg = np.linspace(1, s, nd, endpoint=False); m = max(0, min(nd, n - i)); e[i:i + m] = seg[:m]; i += nd
    if nh > i:
        e[i:nh] = s
    lvl = e[min(nh, n) - 1] if nh > 0 else s
    nr = n - nh
    if nr > 0:
        e[nh:] = lvl * np.linspace(1, 0, nr)
    return e


def fit(x, n):
    if len(x) >= n:
        return x[:n]
    return np.pad(x, (0, n - len(x)))


# ---------- 滤波 ----------
def lp(x, fc, order=2):
    fc = min(fc, SR * 0.45)
    sos = ss.butter(order, fc, 'low', fs=SR, output='sos')
    return ss.sosfilt(sos, x)


def hp(x, fc, order=2):
    sos = ss.butter(order, fc, 'high', fs=SR, output='sos')
    return ss.sosfilt(sos, x)


def bp(x, lo, hi, order=2):
    sos = ss.butter(order, [lo, min(hi, SR * 0.45)], 'band', fs=SR, output='sos')
    return ss.sosfilt(sos, x)


def svf_lp(x, fc, q=0.7):
    """时变低通（fc 可为数组）。TPT 状态变量滤波器，任何截止频率下都稳定。逐采样循环，只用于短音效。"""
    n = len(x)
    fc = np.broadcast_to(np.asarray(fc, dtype=float), (n,))
    g = np.tan(np.pi * np.clip(fc, 20, SR * 0.45) / SR)
    k = 1.0 / q
    ic1 = ic2 = 0.0
    y = np.empty(n)
    for i in range(n):
        gi = g[i]
        a1 = 1.0 / (1.0 + gi * (gi + k)); a2 = gi * a1; a3 = gi * a2
        v3 = x[i] - ic2
        v1 = a1 * ic1 + a2 * v3
        v2 = ic2 + a2 * ic1 + a3 * v3
        ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2
        y[i] = v2
    return y


# ---------- 效果 ----------
def crush(x, bits=6, hold=4):
    q = 2 ** (bits - 1)
    y = np.round(x * q) / q
    if hold > 1:
        idx = (np.arange(len(y)) // hold) * hold
        y = y[idx]
    return y


def stutter(x, slice_d, times, start_d=0.0):
    """把 start 处的一小段重复 times 次"""
    s, L = n_(start_d), n_(slice_d)
    seg = x[s:s + L]
    rep = np.tile(seg, times)
    return np.concatenate([x[:s], rep, x[s + L:]])


def make_ir(d, decay, seed=1, bright=6000):
    r = np.random.default_rng(seed)
    n = n_(d)
    ir = r.standard_normal(n) * np.exp(-np.arange(n) / SR / decay)
    ir = lp(ir, bright)
    ir[0] = 0
    return ir / np.sqrt(np.sum(ir ** 2))


def reverb(x, d=1.8, decay=0.5, wet=0.3, seed=1, bright=6000):
    ir = make_ir(d, decay, seed, bright)
    y = ss.fftconvolve(x, ir)[:len(x) + len(ir)]
    out = np.pad(x, (0, len(y) - len(x))) * (1 - wet) + y * wet
    return out


def soft(x, drive=1.0):
    return np.tanh(x * drive) / np.tanh(drive)


def norm(x, peak=0.89):
    m = np.max(np.abs(x))
    return x if m == 0 else x / m * peak


def fade_out(x, d):
    n = min(len(x), n_(d))
    x = x.copy()
    x[-n:] *= np.linspace(1, 0, n) ** 2
    return x


def trim_tail(x, thresh=1e-3):
    idx = np.where(np.abs(x) > thresh)[0]
    return x[:idx[-1] + 1] if len(idx) else x


# ---------- 输出 ----------
def write_wav(path, x, sr_out=22050):
    """单声道 16bit；默认降到 22050Hz 以减小体积"""
    if sr_out != SR:
        x = ss.resample_poly(x, sr_out, SR)
    x = np.clip(x, -1, 1)
    data = (x * 32767).astype('<i2').tobytes()
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr_out); w.writeframes(data)


def write_mp3(path, x, kbps=128, stereo=False):
    """x: 单声道数组，或 (2, n) 立体声"""
    if stereo:
        inter = np.clip(np.stack([x[0], x[1]], axis=1), -1, 1)
        ch = 2
    else:
        inter = np.clip(x, -1, 1)[:, None]
        ch = 1
    with tempfile.NamedTemporaryFile(suffix='.raw', delete=False) as f:
        f.write((inter * 32767).astype('<i2').tobytes())
        raw = f.name
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', str(SR), '-ac', str(ch),
                    '-i', raw, '-c:a', 'libmp3lame', '-b:a', f'{kbps}k', path], check=True)
    os.unlink(raw)
