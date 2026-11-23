"""Music and final mix for the demo video, composed in code (no samples, no licences).

    python demo/music.py <build>        (reads <build>/narration.wav and timeline.json)

Writes <build>/music.wav (the score before ducking) and <build>/mix.wav: narration over the score,
the score ducked under the voice, -16 LUFS integrated, peaks below -1 dBFS, 48 kHz stereo.

The score: a warm pad in D major (Dmaj9 – Bm7 – Gmaj7 – A6sus) carries the title, a plucked
arpeggio enters with the app, a soft swell marks each new section, and everything settles on
the end card.
"""
import json, pathlib, sys

import numpy as np
import soundfile as sf
from scipy.signal import fftconvolve, lfilter, resample_poly

SR = 48000
BUILD = pathlib.Path(sys.argv[1])

# ---- loudness (ITU-R BS.1770), as in the essay videos ---------------------------------------
_K1 = ([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585])
_K2 = ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621])


def lufs(x):
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    z = lfilter(*_K2, lfilter(*_K1, x, axis=0), axis=0)
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    n = 1 + max(0, (len(z) - blk) // hop)
    ms = np.array([np.mean(z[i * hop:i * hop + blk] ** 2, axis=0).sum() for i in range(n)])
    ld = -0.691 + 10 * np.log10(ms + 1e-12)
    g = ms[ld > -70]
    rel = -0.691 + 10 * np.log10(g.mean()) - 10
    g = ms[(ld > -70) & (ld > rel)]
    return float(-0.691 + 10 * np.log10(g.mean()))


def db(v):
    return 10 ** (v / 20)


# ---- inputs --------------------------------------------------------------------------------
voice, vsr = sf.read(BUILD / 'narration.wav', dtype='float64')
if voice.ndim == 2:
    voice = voice.mean(axis=1)
if vsr != SR:
    voice = resample_poly(voice, SR, vsr)
tl = json.loads((BUILD / 'timeline.json').read_text())
DUR = tl['duration']
N = int(DUR * SR)
voice = np.pad(voice, (0, max(0, N - len(voice))))[:N]
shots = {s['id']: s for s in tl['shots']}
t = np.arange(N) / SR
rng = np.random.default_rng(7)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def env_adsr(n, a, r, sustain=1.0):
    e = np.ones(n) * sustain
    na, nr = min(n, int(a * SR)), min(n, int(r * SR))
    e[:na] = np.linspace(0, 1, na) ** 2 * sustain
    if nr:
        e[-nr:] *= np.linspace(1, 0, nr) ** 1.5
    return e


def onepole_lp(x, fc):
    a = np.exp(-2 * np.pi * fc / SR)
    return lfilter([1 - a], [1, -a], x)


L = np.zeros(N)
R = np.zeros(N)


def add(sig, start, pan=0.0, gain=1.0):
    i = int(start * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    gl, gr = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    L[i:i + len(sig)] += sig * gl * gain
    R[i:i + len(sig)] += sig * gr * gain


BEAT = 60 / 100  # 100 bpm
BAR = 4 * BEAT
CHORDS = [  # (bass, chord tones) in MIDI
    (38, [62, 66, 69, 73, 76]),  # Dmaj9
    (35, [59, 62, 66, 69, 74]),  # Bm7
    (31, [59, 62, 66, 67, 71]),  # Gmaj7
    (33, [57, 62, 64, 66, 69]),  # A6sus
]
CHORD_LEN = 2 * BAR
order = [s['id'] for s in tl['shots']]
end_card = shots[order[-1]]['lines'][0]['end']
pluck_from = shots[order[1]]['start'] - BEAT  # the arpeggio enters with the app, after the title
pluck_to = end_card + 0.4

# pad: detuned soft saws through a low-pass, slow attack, crossfading chords
k = 0
start = 0.0
while start < DUR:
    bass, tones = CHORDS[k % len(CHORDS)]
    n = int((CHORD_LEN + 1.2) * SR)
    tt = np.arange(n) / SR
    for j, m in enumerate(tones[:4]):
        f = hz(m)
        for det, pan in ((-0.07, -0.6), (0.07, 0.6)):
            ff = f * 2 ** (det / 12)
            ph = 2 * np.pi * ff * tt + rng.uniform(0, 6.28)
            saw = sum(np.sin(h * ph) / h for h in range(1, 7))
            sig = onepole_lp(saw, 1400) * env_adsr(n, 1.1, 1.3) * 0.032
            add(sig, start, pan * (0.4 + 0.15 * j))
    # sub bass
    sub = np.sin(2 * np.pi * hz(bass + 12) * tt) * env_adsr(n, 0.4, 1.0) * 0.06
    add(sub, start, 0.0)
    start += CHORD_LEN
    k += 1

# plucked arpeggio (8th notes), entering with the app and stopping on the end card
pat = [0, 2, 1, 3, 4, 2, 3, 1]
step = BEAT / 2
s = np.ceil(pluck_from / step) * step
i = 0
while s < pluck_to:
    ci = int(s // CHORD_LEN) % len(CHORDS)
    m = CHORDS[ci][1][pat[i % len(pat)]] + 12
    n = int(0.9 * SR)
    tt = np.arange(n) / SR
    f = hz(m)
    tone = np.sin(2 * np.pi * f * tt) + 0.35 * np.sin(4 * np.pi * f * tt) * np.exp(-tt * 9) + 0.12 * np.sin(6 * np.pi * f * tt) * np.exp(-tt * 14)
    e = np.exp(-tt * 5.5) * np.minimum(1, tt / 0.004)
    accent = 1.0 if i % 4 == 0 else 0.72
    fade_in = min(1.0, (s - pluck_from) / (2 * BAR))  # grows in over two bars
    add(tone * e * 0.05 * accent * fade_in, s, -0.35 if i % 2 else 0.35)
    s += step
    i += 1

# a soft swell (filtered noise + a high pad note) leading into each new section
for sid in order[1:]:
    t0 = shots[sid]['start']
    n = int(0.9 * SR)
    tt = np.arange(n) / SR
    noise = onepole_lp(rng.standard_normal(n), 2500) - onepole_lp(rng.standard_normal(n), 300)
    sw = (tt / tt[-1]) ** 2.5
    sw[-int(0.08 * SR):] *= np.linspace(1, 0, int(0.08 * SR))
    add(noise * sw * 0.035, max(0, t0 - 0.8), -0.3)
    add(noise[::-1] * sw * 0.035, max(0, t0 - 0.8), 0.3)
    shimmer = np.sin(2 * np.pi * hz(81) * tt) * np.exp(-tt * 2.5) * np.minimum(1, tt / 0.01) * 0.02
    add(shimmer, t0 + 0.05, 0.2)

# reverb: exponentially decaying noise, 1.8 s
ir_n = int(1.8 * SR)
ir_t = np.arange(ir_n) / SR
irL = rng.standard_normal(ir_n) * np.exp(-ir_t * 3.2)
irR = rng.standard_normal(ir_n) * np.exp(-ir_t * 3.2)
irL /= np.sqrt(np.sum(irL ** 2))
irR /= np.sqrt(np.sum(irR ** 2))
wetL = fftconvolve(L, irL)[:N]
wetR = fftconvolve(R, irR)[:N]
music = np.stack([L * 0.8 + wetL * 0.45, R * 0.8 + wetR * 0.45], axis=1)

# overall shape: fade in, settle under the end card, fade out
shape = np.ones(N)
fi = int(0.8 * SR)
shape[:fi] = np.linspace(0, 1, fi) ** 2
fo = int(2.2 * SR)
shape[-fo:] *= np.linspace(1, 0, fo) ** 1.6
music *= shape[:, None]
sf.write(BUILD / 'music.wav', music.astype(np.float32), SR)

# ---- ducking under the voice --------------------------------------------------------------
win = int(0.03 * SR)
rms = np.sqrt(np.convolve(voice ** 2, np.ones(win) / win, mode='same'))
speaking = (rms > db(-42)).astype(np.float64)
# attack 60 ms, release 450 ms
att, rel = np.exp(-1 / (0.06 * SR)), np.exp(-1 / (0.45 * SR))
g = np.zeros(N)
v = 0.0
for n_ in range(N):
    x = speaking[n_]
    v = (att if x > v else rel) * v + (1 - (att if x > v else rel)) * x
    g[n_] = v
duck = db(-9 * g)  # music 9 dB lower while the narrator speaks

# levels: the voice about 14 LU above the ducked music
v_l = lufs(voice)
m_l = lufs(music * duck[:, None])
music_gain = db((v_l - 14) - m_l)
mix = np.stack([voice, voice], axis=1) + music * (duck * music_gain)[:, None]
mix *= db(-16 - lufs(mix))
peak = np.max(np.abs(mix))
if peak > db(-1):
    # gentle soft-knee limiting of the rare peaks above -1 dBFS
    lim = db(-1)
    mix = np.where(np.abs(mix) > lim * 0.8, np.sign(mix) * (lim * 0.8 + (lim * 0.2) * np.tanh((np.abs(mix) - lim * 0.8) / (lim * 0.2))), mix)
sf.write(BUILD / 'mix.wav', mix.astype(np.float32), SR, subtype='PCM_24')
print(f'mix {lufs(mix):.1f} LUFS, peak {20 * np.log10(np.max(np.abs(mix))):.1f} dBFS, '
      f'voice {v_l:.1f} LUFS, music under voice {lufs(music * (duck * music_gain)[:, None]):.1f} LUFS')
