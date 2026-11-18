"""Formatting helpers (port of ``format.ts``).

ORENEX reports tonnes, grade and probability, so number formatting carries real
meaning here: Indian digit grouping (``en-IN``), fixed significant digits on
grades, uncertainty shown inline.

Python has no built-in ``en-IN`` grouping (which is 12,34,567 rather than
1,234,567), so it is implemented here.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _group_indian(digits: str) -> str:
    """Indian grouping: last three digits, then groups of two (en-IN)."""
    if len(digits) <= 3:
        return digits
    head, tail = digits[:-3], digits[-3:]
    parts: list[str] = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return ",".join(parts + [tail])


def _round_half_away(v: float, decimals: int) -> float:
    """Round half away from zero — matches ``Intl.NumberFormat`` (halfExpand)."""
    factor = 10**decimals
    x = v * factor
    r = math.floor(abs(x) + 0.5)
    return (r if x >= 0 else -r) / factor


def _fixed(v: float, decimals: int) -> str:
    neg = v < 0
    rounded = _round_half_away(abs(v), decimals)
    s = f"{rounded:.{decimals}f}"
    if decimals > 0:
        int_part, frac = s.split(".")
    else:
        int_part, frac = s, ""
    out = _group_indian(int_part) + (("." + frac) if decimals > 0 else "")
    return ("-" if neg else "") + out


def num(v, decimals: int = 0) -> str:
    if v is None or not math.isfinite(v):
        return "\u2014"
    d = decimals if 0 <= decimals <= 2 else 3
    return _fixed(v, d)


def tonnes(v, decimals: int = 0) -> str:
    if v is None or not math.isfinite(v):
        return "\u2014"
    return f"{num(v, decimals)} t"


def pct(v, decimals: int = 1) -> str:
    if v is None or not math.isfinite(v):
        return "\u2014"
    return f"{_fixed(v * 100, 0) if decimals == 0 else _fixed(v * 100, 1)}%"


def grade(v, decimals: int = 2) -> str:
    if v is None or not math.isfinite(v):
        return "\u2014"
    d = 0 if decimals == 0 else (1 if decimals == 1 else 2)
    return f"{_fixed(v, d)}%"


def metres(v, decimals: int = 0) -> str:
    if v is None or not math.isfinite(v):
        return "\u2014"
    return f"{num(v, decimals)} m"


def signed(v: float, decimals: int = 0) -> str:
    sign = "+" if v > 0 else ("\u2212" if v < 0 else "")
    return f"{sign}{num(abs(v), decimals)}"


# ── Dates ───────────────────────────────────────────────────────────────
# System clock is used deliberately — the prototype shows "today's intelligence".
NOW = datetime.now()


def fmt_date_short(d) -> str:
    date = datetime.fromisoformat(d) if isinstance(d, str) else d
    return f"{date.day:02d} {MONTHS[date.month - 1]}"


def iso_date(d: datetime) -> str:
    return d.date().isoformat()


def add_days(d: datetime, days: int) -> datetime:
    return d + timedelta(days=days)


def monsoon_factor(d: datetime) -> float:
    """Monsoon intensity 0..1 for Balaghat — June to September peak."""
    m = d.month - 1  # JS getMonth is 0-based
    day_frac = d.day / 30
    if m == 5:
        return 0.28 + 0.4 * day_frac  # Jun
    if m == 6:
        return 0.72 + 0.25 * day_frac  # Jul
    if m == 7:
        return 1.0 - 0.2 * day_frac  # Aug
    if m == 8:
        return 0.78 - 0.4 * day_frac  # Sep
    if m == 4:
        return 0.16 * day_frac  # May
    return 0.0
