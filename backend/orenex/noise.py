"""Fractal value/gradient noise (port of ``noise.ts``).

Used to synthesise terrain, geophysical fields and spatial covariates for the
Balaghat–Nagpur belt prototype surface.
"""

from __future__ import annotations

import math
from typing import Callable, List, Sequence

from .rng import make_rng

PERM_SIZE = 512


def _build_permutation(seed: int) -> List[int]:
    rng = make_rng(seed)
    p = list(range(256))
    for i in range(255, 0, -1):
        j = math.floor(rng() * (i + 1))
        p[i], p[j] = p[j], p[i]
    return [p[i & 255] for i in range(PERM_SIZE)]


def _fade(t: float) -> float:
    return t * t * t * (t * (t * 6 - 15) + 10)


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _grad2(h: int, x: float, y: float) -> float:
    h &= 7
    if h == 0:
        return x + y
    if h == 1:
        return -x + y
    if h == 2:
        return x - y
    if h == 3:
        return -x - y
    if h == 4:
        return x
    if h == 5:
        return -x
    if h == 6:
        return y
    return -y


def make_noise_2d(seed: int) -> Callable[[float, float], float]:
    """Classic 2D Perlin noise in [-1, 1]."""
    perm = _build_permutation(seed)

    def noise(x: float, y: float) -> float:
        fx = math.floor(x)
        fy = math.floor(y)
        xi = fx & 255
        yi = fy & 255
        xf = x - fx
        yf = y - fy
        u = _fade(xf)
        v = _fade(yf)
        aa = perm[perm[xi] + yi]
        ab = perm[perm[xi] + yi + 1]
        ba = perm[perm[xi + 1] + yi]
        bb = perm[perm[xi + 1] + yi + 1]
        x1 = _lerp(_grad2(aa, xf, yf), _grad2(ba, xf - 1, yf), u)
        x2 = _lerp(_grad2(ab, xf, yf - 1), _grad2(bb, xf - 1, yf - 1), u)
        return _lerp(x1, x2, v)

    return noise


def make_fbm(seed: int, octaves: int = 5, lacunarity: float = 2.03, gain: float = 0.5) -> Callable[[float, float], float]:
    """Fractal Brownian motion — layered octaves for natural-looking terrain."""
    noise = make_noise_2d(seed)

    def fbm(x: float, y: float) -> float:
        amp = 1.0
        freq = 1.0
        total = 0.0
        norm = 0.0
        for _ in range(octaves):
            total += amp * noise(x * freq, y * freq)
            norm += amp
            amp *= gain
            freq *= lacunarity
        return total / norm

    return fbm


def make_ridged(seed: int, octaves: int = 5) -> Callable[[float, float], float]:
    """Ridged multifractal — sharp crests, used for fold ridges / lineaments."""
    noise = make_noise_2d(seed)

    def ridged(x: float, y: float) -> float:
        amp = 0.55
        freq = 1.0
        total = 0.0
        norm = 0.0
        for _ in range(octaves):
            n = 1 - abs(noise(x * freq, y * freq))
            total += amp * n * n
            norm += amp
            amp *= 0.52
            freq *= 2.07
        return total / norm

    return ridged


def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def sample_field(field: Sequence[float], w: int, h: int, u: float, v: float) -> float:
    """Bilinear sample over a float field with given width/height."""
    x = clamp(u, 0.0, 0.999999) * (w - 1)
    y = clamp(v, 0.0, 0.999999) * (h - 1)
    x0 = math.floor(x)
    y0 = math.floor(y)
    x1 = min(x0 + 1, w - 1)
    y1 = min(y0 + 1, h - 1)
    tx = x - x0
    ty = y - y0
    a = field[y0 * w + x0]
    b = field[y0 * w + x1]
    c = field[y1 * w + x0]
    d = field[y1 * w + x1]
    return _lerp(_lerp(a, b, tx), _lerp(c, d, tx), ty)
