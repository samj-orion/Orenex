"""Deterministic pseudo-randomness (port of ``rng.ts``).

Every figure ORENEX displays is produced by a seeded generator so that the
prototype is reproducible: the same seed always yields the same district, the
same orebody, the same shortfall.

The generator is mulberry32, ported bit-for-bit from JavaScript. JS bitwise
operators coerce to 32-bit integers, so all arithmetic here is masked to 32 bits
to keep the two engines in lock-step.
"""

from __future__ import annotations

import math
from typing import Callable, Sequence, TypeVar

MASK = 0xFFFFFFFF

Rng = Callable[[], float]

T = TypeVar("T")


def _imul(a: int, b: int) -> int:
    """Math.imul — low 32 bits of a signed 32-bit multiply."""
    return (a * b) & MASK


def make_rng(seed: int) -> Rng:
    """mulberry32 — small, fast, good enough distribution for simulation."""
    a = seed & MASK

    def _rng() -> float:
        nonlocal a
        a = (a + 0x6D2B79F5) & MASK
        t = a
        t = _imul(t ^ (t >> 15), t | 1) & MASK
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & MASK
        return ((t ^ (t >> 14)) & MASK) / 4294967296.0

    return _rng


def gaussian(rng: Rng, mean: float = 0.0, sd: float = 1.0) -> float:
    """Box–Muller normal deviates from a uniform stream."""
    u = 0.0
    v = 0.0
    while u == 0.0:
        u = rng()
    while v == 0.0:
        v = rng()
    return mean + sd * math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * v)


def pick(rng: Rng, items: Sequence[T]) -> T:
    return items[(int(rng() * len(items)) % len(items))]


def range_(rng: Rng, lo: float, hi: float) -> float:
    """``range`` is a builtin in Python, so the port names it ``range_``."""
    return lo + (hi - lo) * rng()


def quantile_sorted(sorted_values: Sequence[float], q: float) -> float:
    """Quantile of an already-sorted ascending list."""
    if not sorted_values:
        return float("nan")
    pos = (len(sorted_values) - 1) * q
    base = math.floor(pos)
    rest = pos - base
    if base + 1 < len(sorted_values):
        return sorted_values[base] + rest * (sorted_values[base + 1] - sorted_values[base])
    return sorted_values[base]


def norm_inv(p: float) -> float:
    """Inverse standard-normal CDF (Acklam's rational approximation, |err| < 1.2e-7)."""
    pp = 1e-12 if p <= 0 else (1 - 1e-12 if p >= 1 else p)
    a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
    b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
    c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
    d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
    pl = 0.02425
    ph = 1 - pl
    if pp < pl:
        q = math.sqrt(-2 * math.log(pp))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if pp > ph:
        q = math.sqrt(-2 * math.log(1 - pp))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = pp - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
