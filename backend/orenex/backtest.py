"""Port of ``backtest.ts``.

Forward validation of the shortfall engine (D10).

Two things live here, and both are measured rather than asserted:

1. **Calibration.** The deterministic stage model gets the weather and the fleet
   right but cannot see crew effects, face-grade variability or the 8.5%-of-shifts
   disruption that the shift register records. That residue has to be *fitted*,
   or the forecast's intervals are a guess dressed up as a distribution.
2. **Rolling-origin backtest.** The fitted model is then run forwards from origins
   in the past, with only information available at the origin, and scored against
   what actually happened — against a "same as the last 30 days" baseline.

Record shapes (plain ``dict`` records, keys keep the TypeScript spelling):

* ``ResidualModel``  — ``nominalShare``, ``nominalLogSd``, ``disruptedOffset``,
  ``disruptedSd``.
* ``DayPredictive``  — ``mu``, ``nominalShare``, ``nominalLogSd``, ``disruptedMu``,
  ``disruptedSdT``.
* ``DayRecord``      — ``date``, ``actualT``, ``planT``, ``shifts``,
  ``cappedShifts``, ``openActualT``, ``openPlanT``, ``openShifts``, ``lostT``,
  ``lostByCause``.
* ``Calibration``    — ``mineId``, ``bias``, ``biasByBand``, ``residualSd``,
  ``residualSdByBand``, ``residual``, ``residualByBand``, ``coverage80``,
  ``coverage80ByBand``, ``attainment``, ``n``, ``nExcluded``, ``windowDays``,
  ``wetDrySpreadRatio``, ``fittedOn``, ``asOf``.
* ``BacktestOrigin`` — ``origin``, ``windowStart``, ``horizonDays``, ``modelMaeT``,
  ``baselineMaeT``, ``rmseT``, ``mapePct``, ``coverage80Pct``, ``planTotalT``,
  ``p50TotalT``, ``actualTotalT``, ``pShort``, ``missed``, ``alerted``,
  ``peakRainMm``.
* ``AlertEpisode``   — ``startDate``, ``endDate``, ``windows``, ``alertedBefore``,
  ``leadDays``.
* ``ForecastBacktest`` — the roll-up documented on ``forecast_backtest``.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any, Dict, List, Optional

from .format import NOW, add_days, iso_date
from .geology import MINES
from .noise import clamp
from .operations import PRODUCTION, plan_tpd, plant_ceiling_shift_t, weather_on
from .stage_model import (
    empty_stage_context,
    mine_capacity_t,
    stage_rows_for,
)


# ── Number helpers (JS ``Math.round`` / ``Number(x.toFixed(n))``) ───────────

def _round(v: float) -> int:
    """``Math.round(v)`` — JS rounds half up, not banker's."""
    return math.floor(v + 0.5)


def _fixed(v: float, digits: int) -> float:
    """``Number(v.toFixed(digits))`` — guard NaN first, then format."""
    if isinstance(v, float) and math.isnan(v):
        return v
    return float(f"{v:.{digits}f}")


# ── Rain bands the residual spread is fitted separately in ──────────────────

RAIN_BANDS = [
    {"key": "dry", "label": "Dry (< 8 mm)", "maxMm": 8},
    {"key": "wet", "label": "Wet (8\u201335 mm)", "maxMm": 35},
    {"key": "veryWet", "label": "Very wet (> 35 mm)", "maxMm": math.inf},
]

# Shape documented in the module docstring.
RainBand = str


def rain_band(rain_mm: float) -> RainBand:
    for b in RAIN_BANDS:
        if rain_mm < b["maxMm"]:
            return b["key"]
    return "veryWet"


def residual_sd_for(cal: Dict[str, Any], rain_mm: float) -> float:
    """Multiplier on the residual spread, read off the fitted per-band numbers.

    Asserting "a wet shift is harder to predict" and scaling the interval up with
    rain is the obvious guess, and measurement says the opposite: the *relative*
    residual is tightest on the wettest days, because there the derate is large
    and consistent and the crews plan around it.
    """
    bands = cal["residualSdByBand"]
    fitted = bands[rain_band(rain_mm)]
    return fitted if fitted > 0 else cal["residualSd"]


def bias_for(cal: Dict[str, Any], rain_mm: float) -> float:
    """The multiplicative correction in force on a day with this rainfall.

    Per band, not pooled. The stage model's ground derates are a stated shape and
    measurement says the shape is right but the magnitude is not the same in every
    band. Correcting the location per band is the difference between an interval
    that is honest and one that is merely symmetric.
    """
    by_band = cal.get("biasByBand") or {}
    fitted = by_band.get(rain_band(rain_mm))
    return fitted if (fitted is not None and fitted > 0) else cal["bias"]


def residual_for(cal: Dict[str, Any], rain_mm: float) -> Dict[str, Any]:
    """The residual model in force on a day with this rainfall."""
    by_band = cal.get("residualByBand") or {}
    return by_band.get(rain_band(rain_mm)) or cal["residual"]


# ── Predictive distribution ─────────────────────────────────────────────────

# Shape documented in the module docstring.
DayPredictive = Dict[str, Any]


def day_predictive(cal: Dict[str, Any], rain_mm: float, capacity_t: float) -> DayPredictive:
    """The predictive distribution for one forecast day, in tonnes.

    Two normal components: the nominal shift and the disrupted one. Everything
    downstream — P10/P90, P(day misses plan), P(the week misses its plan) — is read
    off this, so the bands on the chart and the alert probability are the same
    object rather than two numbers that happen to sit near each other.
    """
    m = residual_for(cal, rain_mm)
    mu = max(0.0, capacity_t * bias_for(cal, rain_mm))
    return {
        "mu": mu,
        "nominalShare": m["nominalShare"],
        "nominalLogSd": m["nominalLogSd"],
        "disruptedMu": mu * (1 - m["disruptedOffset"]),
        "disruptedSdT": mu * m["disruptedSd"],
    }


def _normal_cdf2(z: float) -> float:
    t = 1 / (1 + 0.2316419 * abs(z))
    d = 0.3989422804014327 * math.exp((-z * z) / 2)
    p = d * t * (
        0.31938153
        + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))
    )
    return 1 - p if z > 0 else p


def mixture_cdf(m: Dict[str, Any], x: float) -> float:
    """CDF of the residual mixture at a ratio, with the nominal component centred on 1."""
    d = 1 - m["nominalShare"]
    nom = 0 if x <= 0 else _normal_cdf2(math.log(x) / (m["nominalLogSd"] or 1e-6))
    return m["nominalShare"] * nom + d * _normal_cdf2(
        (x - (1 - m["disruptedOffset"])) / (m["disruptedSd"] or 1)
    )


def mixture_quantile(m: Dict[str, Any], p: float) -> float:
    """Quantile of the residual mixture in ratio space, nominal median at 1.

    Bisection because the mixture of a lognormal and a normal has no closed-form
    inverse, and because the code that reads it is a coverage check that runs
    thousands of times — a table would be an optimisation, not a design.
    """
    lo = 1 - m["disruptedOffset"] - 6 * m["disruptedSd"]
    hi = 1 + 8 * m["nominalLogSd"]
    for _ in range(34):
        mid = math.sqrt(max(1e-9, lo * hi))
        if mixture_cdf(m, mid) < p:
            lo = mid
        else:
            hi = mid
    return math.sqrt(max(1e-9, lo * hi))


def day_quantile(p: DayPredictive, q: float) -> float:
    """Quantile of the day predictive, in tonnes."""
    if q <= 0:
        return 0
    if q >= 1:
        return math.inf
    mu = p["mu"] or 1
    ratio = mixture_quantile(
        {
            "nominalShare": p["nominalShare"],
            "nominalLogSd": p["nominalLogSd"],
            "disruptedOffset": 1 - p["disruptedMu"] / mu,
            "disruptedSd": p["disruptedSdT"] / mu,
        },
        q,
    )
    return p["mu"] * ratio


def day_miss_probability(p: DayPredictive, plan_t: float) -> float:
    """P(this one day falls short of its plan)."""
    if p["mu"] <= 0:
        return 1
    plan_ratio = plan_t / p["mu"]
    return clamp(mixture_cdf(_residual_of_day(p), plan_ratio), 0, 1)


def _residual_of_day(p: DayPredictive) -> Dict[str, Any]:
    mu = p["mu"] or 1
    return {
        "nominalShare": p["nominalShare"],
        "nominalLogSd": p["nominalLogSd"],
        "disruptedOffset": 1 - p["disruptedMu"] / mu,
        "disruptedSd": p["disruptedSdT"] / mu,
    }


# Windows up to this length are propagated as an exact mixture.
EXACT_MIXTURE_DAYS = 12


def _nominal_moments(log_sd: float) -> Dict[str, float]:
    """Mean and sd of the nominal component in ratio space, median 1.

    The component is lognormal, so its mean sits above 1 by exp(sigma^2/2) even
    though its median is exactly 1. A weekly total built from component *medians*
    is biased low, so the shortfall probability it produces over-states the risk.
    """
    v = log_sd * log_sd
    mean = math.exp(v / 2)
    return {"mean": mean, "sd": math.sqrt((math.exp(v) - 1) * mean * mean)}


def window_miss_probability(days: List[DayPredictive], plan_total_t: float) -> float:
    """P(a run of independent days misses its combined plan).

    The total is a sum of independent per-day mixtures. Each day contributes one of
    two components, so for a short window the sum is a mixture of ``2**n`` branches
    -- 128 of them for a week, cheap enough to enumerate exactly. Beyond
    ``EXACT_MIXTURE_DAYS`` the enumeration is dropped and the whole window is
    moment-matched in one step.
    """
    if not days:
        return 0
    total_mu = sum(d["mu"] for d in days)
    if total_mu <= 0:
        return 0
    plan_ratio = plan_total_t / total_mu
    comp = []
    for d in days:
        denom = d["mu"] or 1
        comp.append(
            {
                "w": d["mu"] / total_mu,
                "share": d["nominalShare"],
                "nom": _nominal_moments(d["nominalLogSd"]),
                "dis": {"mean": d["disruptedMu"] / denom, "sd": d["disruptedSdT"] / denom},
            }
        )

    if len(days) > EXACT_MIXTURE_DAYS:
        mean = 0.0
        var_sum = 0.0
        for c in comp:
            dd = 1 - c["share"]
            m = c["share"] * c["nom"]["mean"] + dd * c["dis"]["mean"]
            mean += c["w"] * m
            within = c["share"] * c["nom"]["sd"] ** 2 + dd * c["dis"]["sd"] ** 2
            between = c["share"] * dd * (c["nom"]["mean"] - c["dis"]["mean"]) ** 2
            var_sum += c["w"] * c["w"] * (within + between)
        return clamp(_normal_cdf2((plan_ratio - mean) / (math.sqrt(var_sum) or 1)), 0, 1)

    combos = 1 << len(days)
    acc = 0.0
    for mask in range(combos):
        mean = 0.0
        var_sum = 0.0
        prob = 1.0
        for i in range(len(comp)):
            c = comp[i]
            disrupted = (mask >> i) & 1
            prob *= (1 - c["share"]) if disrupted else c["share"]
            if prob == 0:
                break
            mean += c["w"] * (c["dis"]["mean"] if disrupted else c["nom"]["mean"])
            var_sum += c["w"] * c["w"] * (
                (c["dis"]["sd"] if disrupted else c["nom"]["sd"]) ** 2
            )
        if prob == 0:
            continue
        acc += prob * _normal_cdf2((plan_ratio - mean) / (math.sqrt(var_sum) or 1))
    return clamp(acc, 0, 1)


# ── Daily history ───────────────────────────────────────────────────────────

# Shape documented in the module docstring.
DayRecord = Dict[str, Any]

_day_cache: Dict[str, Dict[str, DayRecord]] = {}


def daily_records(mine_id: str) -> Dict[str, DayRecord]:
    hit = _day_cache.get(mine_id)
    if hit is not None:
        return hit
    map_: Dict[str, DayRecord] = {}
    ceiling = plant_ceiling_shift_t(mine_id)
    for s in PRODUCTION:
        if s["mineId"] != mine_id:
            continue
        cur = map_.get(s["date"])
        if cur is None:
            cur = {
                "date": s["date"],
                "actualT": 0,
                "planT": 0,
                "shifts": 0,
                "cappedShifts": 0,
                "openActualT": 0,
                "openPlanT": 0,
                "openShifts": 0,
                "lostT": 0,
                "lostByCause": {},
            }
        cur["actualT"] += s["actualT"]
        cur["planT"] += s["plannedT"]
        cur["shifts"] += 1
        capped = s["actualT"] >= ceiling - 1
        if capped:
            cur["cappedShifts"] += 1
        else:
            cur["openActualT"] += s["actualT"]
            cur["openPlanT"] += s["plannedT"]
            cur["openShifts"] += 1
        cur["lostT"] += s["lostT"]
        cur["lostByCause"][s["trueCause"]] = (
            cur["lostByCause"].get(s["trueCause"], 0) + s["lostT"]
        )
        map_[s["date"]] = cur
    _day_cache[mine_id] = map_
    return map_


# ── Calibration ─────────────────────────────────────────────────────────────

# Shape documented in the module docstring.
ResidualModel = Dict[str, Any]

POOLED: ResidualModel = {
    "nominalShare": 0.85,
    "nominalLogSd": 0.045,
    "disruptedOffset": 0.2,
    "disruptedSd": 0.06,
}


def _split_residual(ratios: List[float]) -> ResidualModel:
    """Fit the two-component residual to a sample of bias-normalised day ratios.

    The nominal component is lognormal, not normal: a day's ratio is a product of
    roughly independent positive factors, so it is right-skewed. The fit is by
    quantile matching, not by a summary statistic — the four parameters minimise
    squared error between the model's quantiles and the sample's at nine
    probability levels spanning P2-P98, by coordinate descent.
    """
    n = len(ratios)
    if n < 40:
        return dict(POOLED)
    s = sorted(ratios)

    def q(p: float) -> float:
        return s[min(n - 1, max(0, _round((n - 1) * p)))]

    # Everything below the seed cut is candidate disruption. The cut is generous
    # on purpose: it only has to be far enough down to exclude the bulk, because
    # the shoulder parameters are then decided by the quantile fit.
    q50 = q(0.5)
    iqr_log = max(1e-4, math.log(max(1e-6, q(0.75) / max(1e-6, q(0.5)))))
    seed_cut = q50 * math.exp(-max(3 * iqr_log, 0.05))
    tail_idx = -1
    for i, v in enumerate(s):
        if v >= seed_cut:
            tail_idx = i
            break
    has_tail = tail_idx >= 4 and n - tail_idx >= 8
    tail = s[:tail_idx] if has_tail else []

    # Seed from the sample itself, then let the quantile fit move it.
    if has_tail:
        bulk_log_sd = clamp(math.log(max(1e-6, q(0.75) / q50)) / 0.6745, 0.004, 0.35)
    else:
        bulk_log_sd = clamp(math.log(max(1e-6, q(0.9) / q(0.1))) / 2.5631, 0.004, 0.35)
    if has_tail:
        tail_mean = sum(tail) / len(tail)
        seed_offset = clamp((q50 - tail_mean) / q50, 0.03, 0.55)
        seed_sd = clamp(
            math.sqrt(sum((v - tail_mean) ** 2 for v in tail) / len(tail)), 0.01, 0.5
        )
    else:
        seed_offset = 0.2
        seed_sd = 0.06

    # Levels the fit is scored on, and how much each one matters. P10 and P90 get
    # the largest weight because that is the interval the chart draws.
    levels = [0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.98]
    weights = [0.6, 0.8, 1.4, 0.8, 0.3, 0.8, 1.4, 0.8, 0.6]
    target = [q(p) for p in levels]
    scale = max(0.01, q(0.75) - q(0.25))

    def eval_residual(m: ResidualModel) -> float:
        acc = 0.0
        for i in range(len(levels)):
            err = (mixture_quantile(m, levels[i]) - target[i]) / scale
            acc += weights[i] * err * err
        return acc

    best: ResidualModel = {
        "nominalShare": _fixed(clamp(1 - len(tail) / n, 0.5, 0.995), 3) if has_tail else 1,
        "nominalLogSd": _fixed(bulk_log_sd, 4),
        "disruptedOffset": _fixed(seed_offset, 4),
        "disruptedSd": _fixed(seed_sd, 4),
    }
    best_cost = eval_residual(best)

    # Coordinate descent. Four parameters, a handful of passes, and the step in
    # each halves after every pass.
    bounds = {
        "nominalShare": (0.5, 0.999),
        "nominalLogSd": (0.004, 0.35),
        "disruptedOffset": (0.03, 0.6),
        "disruptedSd": (0.008, 0.5),
    }
    keys = ["nominalShare", "nominalLogSd", "disruptedOffset", "disruptedSd"]
    start = [best[k] for k in keys]
    step = [max(0.04 * v, 0.01) for v in start]
    candidate = dict(best)
    for p in range(7):
        improved = False
        for i in range(len(keys)):
            k = keys[i]
            lo, hi = bounds[k]
            for direction in (-1, 1):
                v = clamp(best[k] + direction * step[i], lo, hi)
                candidate[k] = v
                cost = eval_residual(candidate)
                if cost < best_cost - 1e-12:
                    best_cost = cost
                    best = dict(candidate)
                    improved = True
            candidate[k] = best[k]
        step = [x * 0.55 for x in step]
        if not improved and p > 2:
            break

    # Round to the precision the model card reports at.
    return {
        "nominalShare": _fixed(clamp(best["nominalShare"], 0.5, 0.999), 3),
        "nominalLogSd": _fixed(clamp(best["nominalLogSd"], 0.004, 0.35), 4),
        "disruptedOffset": _fixed(clamp(best["disruptedOffset"], 0.03, 0.6), 4),
        "disruptedSd": _fixed(clamp(best["disruptedSd"], 0.008, 0.5), 4),
    }


def mixture_sd(m: ResidualModel) -> float:
    """Total spread of the mixture in ratio space, for display."""
    d = 1 - m["nominalShare"]
    nm = _nominal_moments(m["nominalLogSd"])
    nom_mean, nom_sd = nm["mean"], nm["sd"]
    dis_mean = 1 - m["disruptedOffset"]
    var_n = nom_sd ** 2
    var_d = m["disruptedSd"] ** 2
    return math.sqrt(
        m["nominalShare"] * var_n
        + d * var_d
        + m["nominalShare"] * d * (nom_mean - dis_mean) ** 2
    )


# Shape documented in the module docstring.
Calibration = Dict[str, Any]


def model_capacity_t(mine_id: str, iso: str, ctx: Optional[Dict[str, Any]] = None) -> float:
    """Deterministic stage capacity for a historical date, tonnes/day."""
    return mine_capacity_t(
        stage_rows_for(mine_id, weather_on(mine_id, iso), ctx if ctx is not None else empty_stage_context())
    )


_cal_cache: Dict[str, Calibration] = {}

# Minimum days in a band before it gets its own bias and mixture.
MIN_BAND_DAYS = 40


def fit_calibration(
    mine_id: str, window_days: int = 365, as_of: Optional[str] = None
) -> Calibration:
    """Fit the multiplicative bias and residual spread against the shift register.

    Window is 365 days rather than the full history on purpose: equipment ages,
    the fleet is renewed and crew practice changes. ``as_of`` truncates the window
    at a past date, which is what makes the backtest honest.
    """
    end = as_of if as_of is not None else iso_date(NOW)
    key = f"{mine_id}|{window_days}|{end}"
    cached = _cal_cache.get(key)
    if cached is not None:
        return cached

    recs = daily_records(mine_id)
    from_ = iso_date(add_days(datetime.fromisoformat(end), -window_days))
    in_window = [r for r in recs.values() if r["date"] >= from_ and r["date"] <= end]

    def median(a: List[float]) -> float:
        return a[len(a) // 2]

    # The fit runs on whole uncensored days. A partly-capped day is dropped rather
    # than patched: one shift at the ceiling means the day's shortfall is only
    # partly observable, and imputing it would put the model's own ceiling into
    # the data the model is fitted on.
    rows: List[Dict[str, Any]] = []
    for rec in in_window:
        if rec["cappedShifts"] > 0:
            continue
        cap = model_capacity_t(mine_id, rec["date"])
        if cap <= 0:
            continue
        rows.append(
            {
                "ratio": rec["actualT"] / cap,
                "band": rain_band(weather_on(mine_id, rec["date"])["rainMm"]),
            }
        )
    rows.sort(key=lambda r: r["ratio"])
    bias = clamp(median([r["ratio"] for r in rows]), 0.5, 2) if rows else 1

    # Per-band location, fitted before the spread. Fitting the spread first and
    # the location second lets a mis-modelled derate land inside the interval,
    # which then has to widen to cover a shift that was never uncertain.
    bias_by_band: Dict[str, float] = {"dry": 0, "wet": 0, "veryWet": 0}
    for band in RAIN_BANDS:
        in_band = sorted(r["ratio"] for r in rows if r["band"] == band["key"])
        bias_by_band[band["key"]] = (
            _fixed(clamp(median(in_band), 0.5, 2), 4) if len(in_band) >= MIN_BAND_DAYS else 0
        )
    for band in RAIN_BANDS:
        if not bias_by_band[band["key"]]:
            bias_by_band[band["key"]] = _fixed(bias, 4)

    # Normalise each band by its own location before measuring spread, otherwise
    # the bias itself would be counted as noise and inflate the interval for ever.
    def residual_sd_for_rows(sel) -> float:
        dev = sorted(
            abs(r["ratio"] / bias_by_band[r["band"]] - 1) for r in rows if sel(r)
        )
        return clamp(1.4826 * median(dev), 0.02, 0.6) if len(dev) > 8 else 0.1

    residual_sd = residual_sd_for_rows(lambda r: True)

    # Per-band fits, falling back to the pooled number where a band is thin.
    residual_sd_by_band: Dict[str, float] = {"dry": 0, "wet": 0, "veryWet": 0}
    residual_by_band: Dict[str, ResidualModel] = {
        "dry": dict(POOLED),
        "wet": dict(POOLED),
        "veryWet": dict(POOLED),
    }

    def normalised(r: Dict[str, Any]) -> float:
        return r["ratio"] / bias_by_band[r["band"]]

    residual = _split_residual([normalised(r) for r in rows])
    for band in RAIN_BANDS:
        in_band = [normalised(r) for r in rows if r["band"] == band["key"]]
        residual_by_band[band["key"]] = (
            _split_residual(in_band) if len(in_band) >= MIN_BAND_DAYS else residual
        )
        residual_sd_by_band[band["key"]] = _fixed(
            mixture_sd(residual_by_band[band["key"]]), 4
        )

    # Does the fitted interval actually contain the realised tonnage? Scored on the
    # very rows it was fitted on — in-sample by construction.
    stub = _cal_stub(bias, bias_by_band, residual, residual_by_band)
    inside = 0
    inside_by_band: Dict[str, int] = {"dry": 0, "wet": 0, "veryWet": 0}
    checked_by_band: Dict[str, int] = {"dry": 0, "wet": 0, "veryWet": 0}
    for rec in in_window:
        if rec["cappedShifts"] > 0:
            continue
        rain_mm = weather_on(mine_id, rec["date"])["rainMm"]
        band = rain_band(rain_mm)
        dp = day_predictive(stub, rain_mm, model_capacity_t(mine_id, rec["date"]))
        hit = (
            rec["actualT"] >= day_quantile(dp, 0.1)
            and rec["actualT"] <= day_quantile(dp, 0.9)
        )
        if hit:
            inside += 1
            inside_by_band[band] += 1
        checked_by_band[band] += 1
    checked = len(rows)

    cal: Calibration = {
        "mineId": mine_id,
        "bias": _fixed(bias, 4),
        "biasByBand": bias_by_band,
        "residualSd": _fixed(residual_sd, 4),
        "residualSdByBand": residual_sd_by_band,
        "residual": residual,
        "residualByBand": residual_by_band,
        "coverage80": _fixed((inside / checked) * 100, 1) if checked else 0,
        "coverage80ByBand": {
            "dry": _fixed((inside_by_band["dry"] / checked_by_band["dry"]) * 100, 1)
            if checked_by_band["dry"]
            else None,
            "wet": _fixed((inside_by_band["wet"] / checked_by_band["wet"]) * 100, 1)
            if checked_by_band["wet"]
            else None,
            "veryWet": _fixed(
                (inside_by_band["veryWet"] / checked_by_band["veryWet"]) * 100, 1
            )
            if checked_by_band["veryWet"]
            else None,
        },
        "attainment": _fixed(
            median(
                sorted(
                    [(r["actualT"] / r["planT"]) if r["planT"] else 1 for r in in_window]
                )
            ),
            3,
        )
        if in_window
        else 0,
        "n": len(rows),
        "nExcluded": len(in_window) - len(rows),
        "windowDays": window_days,
        "wetDrySpreadRatio": _fixed(
            residual_sd_by_band["veryWet"] / residual_sd_by_band["dry"], 2
        )
        if residual_sd_by_band["dry"] > 0
        else 1,
        "fittedOn": end,
        "asOf": end,
    }
    _cal_cache[key] = cal
    return cal


def _cal_stub(
    bias: float,
    bias_by_band: Dict[str, float],
    residual: ResidualModel,
    by_band: Dict[str, ResidualModel],
) -> Calibration:
    """Minimal object for the coverage pass, before the full Calibration exists."""
    return {
        "mineId": "",
        "bias": bias,
        "biasByBand": bias_by_band,
        "residualSd": mixture_sd(residual),
        "residualSdByBand": {"dry": 0, "wet": 0, "veryWet": 0},
        "residual": residual,
        "residualByBand": by_band,
        "coverage80": 0,
        "coverage80ByBand": {"dry": None, "wet": None, "veryWet": None},
        "attainment": 0,
        "n": 0,
        "nExcluded": 0,
        "windowDays": 0,
        "wetDrySpreadRatio": 1,
        "fittedOn": "",
        "asOf": "",
    }


# ── Rolling-origin backtest ─────────────────────────────────────────────────

# Shapes documented in the module docstring.
BacktestOrigin = Dict[str, Any]
AlertEpisode = Dict[str, Any]
ForecastBacktest = Dict[str, Any]

_backtest_cache: Dict[str, ForecastBacktest] = {}


def forecast_backtest(mine_id: str, opts: Optional[Dict[str, Any]] = None) -> ForecastBacktest:
    """Score the forecast against history, from origins in the past.

    The weather actually observed on the target days is fed to the stage model,
    which is what a perfect 5-day rain forecast would give. That makes the skill
    figure an upper bound: in production the forecast has to live off the forecast
    rain, not the truth.
    """
    opts = opts or {}
    horizon_days = opts.get("horizonDays") if opts.get("horizonDays") is not None else 7
    window_days = opts.get("windowDays") if opts.get("windowDays") is not None else 280
    step_days = opts.get("stepDays") if opts.get("stepDays") is not None else 7
    alert_threshold = opts.get("alertThreshold") if opts.get("alertThreshold") is not None else 0.45
    key = f"{mine_id}|{horizon_days}|{window_days}|{step_days}"
    cached = _backtest_cache.get(key)
    if cached is not None:
        return cached

    recs = daily_records(mine_id)
    dates = sorted(recs.keys())
    series = [recs[d] for d in dates]
    index_of = {d: i for i, d in enumerate(dates)}

    # Trailing 30-day mean actual, evaluated at each origin — the baseline a mine
    # planner uses when they have nothing better.
    def trailing_mean(upto: int) -> float:
        from_ = max(0, upto - 29)
        sl = series[from_ : upto + 1]
        return sum(r["actualT"] for r in sl) / len(sl) if sl else 0

    last_orig_idx = len(series) - horizon_days
    first_orig_idx = max(6, index_of.get(iso_date(add_days(NOW, -window_days)), 0))

    abs_err = 0.0
    abs_err_base = 0.0
    sq_err = 0.0
    abs_pct = 0.0
    inside = 0
    counted = 0
    abs_err_no_weather = 0.0
    counted_no_weather = 0
    origins: List[BacktestOrigin] = []

    o = first_orig_idx
    while o <= last_orig_idx:
        # Refit at every origin. Each origin only sees days up to itself.
        cal = fit_calibration(mine_id, 365, dates[o])
        ctx_no_weather = {**empty_stage_context(), "ignoreWeather": True}
        model_abs = 0.0
        base_abs = 0.0
        model_sq = 0.0
        model_pct = 0.0
        covered = 0
        plan_total = 0.0
        p50_total = 0.0
        actual_total = 0.0
        peak_rain = 0.0
        day_mix: List[DayPredictive] = []

        for h in range(1, horizon_days + 1):
            i = o + h
            if i >= len(series):
                break
            rec = series[i]
            w = weather_on(mine_id, rec["date"])
            peak_rain = max(peak_rain, w["rainMm"])

            dp = day_predictive(cal, w["rainMm"], model_capacity_t(mine_id, rec["date"]))
            p50 = dp["mu"]
            p50_no_weather = model_capacity_t(mine_id, rec["date"], ctx_no_weather) * bias_for(
                cal, w["rainMm"]
            )

            e = abs(rec["actualT"] - p50)
            model_abs += e
            counted_no_weather += 1
            abs_err_no_weather += abs(rec["actualT"] - p50_no_weather)
            base_abs += abs(rec["actualT"] - trailing_mean(o))
            model_sq += (rec["actualT"] - p50) ** 2
            model_pct += (e / max(1, rec["actualT"])) * 100
            if rec["actualT"] >= day_quantile(dp, 0.1) and rec["actualT"] <= day_quantile(dp, 0.9):
                covered += 1

            plan = plan_tpd(mine_id, datetime.fromisoformat(rec["date"]))
            plan_total += plan
            p50_total += p50
            actual_total += rec["actualT"]
            day_mix.append(dp)

        n = min(horizon_days, len(series) - o - 1)
        if n < horizon_days:
            break
        mae = model_abs / n
        abs_err += model_abs
        abs_err_base += base_abs
        sq_err += model_sq
        abs_pct += model_pct
        inside += covered
        counted += n

        p_short = window_miss_probability(day_mix, plan_total)
        origins.append(
            {
                "origin": dates[o],
                "windowStart": series[o + 1]["date"],
                "horizonDays": horizon_days,
                "modelMaeT": _fixed(mae, 0),
                "baselineMaeT": _fixed(base_abs / n, 0),
                "rmseT": _fixed(math.sqrt(model_sq / n), 0),
                "mapePct": _fixed(model_pct / n, 2),
                "coverage80Pct": _fixed((covered / n) * 100, 0),
                "planTotalT": _round(plan_total),
                "p50TotalT": _round(p50_total),
                "actualTotalT": _round(actual_total),
                "pShort": _fixed(p_short, 3),
                "missed": actual_total < plan_total,
                "alerted": p_short >= alert_threshold,
                "peakRainMm": _fixed(peak_rain, 1),
            }
        )
        o += step_days

    # Alert quality: precision, recall, and how much warning each episode got.
    def confusion(threshold: float) -> Dict[str, Any]:
        tp = fp = fn = tn = 0
        for r in origins:
            fired = r["pShort"] >= threshold
            if r["missed"] and fired:
                tp += 1
            elif not r["missed"] and fired:
                fp += 1
            elif r["missed"]:
                fn += 1
            else:
                tn += 1
        precision = tp / (tp + fp) if tp + fp else 0
        recall = tp / (tp + fn) if tp + fn else 0
        return {
            "threshold": threshold,
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "tn": tn,
            "precision": _fixed(precision, 3),
            "recall": _fixed(recall, 3),
            "f1": _fixed(
                (2 * precision * recall) / (precision + recall) if precision + recall else 0, 3
            ),
        }

    # Where to put the alert line: maximal F1 subject to the PS precision floor of
    # 0.6. Without the floor the sweep would happily fire on every third window.
    sweep: List[Dict[str, Any]] = []
    t = 0.1
    while t <= 0.9001:
        sweep.append(confusion(_fixed(t, 2)))
        t += 0.05
    with_recall = [s for s in sweep if s["precision"] >= 0.6 and s["recall"] >= 0.8]
    admissible = with_recall if with_recall else [s for s in sweep if s["precision"] >= 0.6]
    pool = admissible if admissible else sweep
    chosen = pool[0]
    for s in pool:
        if s["f1"] > chosen["f1"]:
            chosen = s
    alert_threshold = chosen["threshold"]
    # Re-stamp the fired flag now that the operating point is settled.
    for r in origins:
        r["alerted"] = r["pShort"] >= alert_threshold
    c_metrics = confusion(alert_threshold)
    precision = c_metrics["precision"]
    recall = c_metrics["recall"]
    c_counts = confusion(alert_threshold)
    tp, fp, fn, tn = c_counts["tp"], c_counts["fp"], c_counts["fn"], c_counts["tn"]

    # Lead time: walk the runs of consecutive missed windows and ask how far back
    # the first warning sat. Look back three origins.
    episodes: List[AlertEpisode] = []
    i = 0
    while i < len(origins):
        if not origins[i]["missed"]:
            i += 1
            continue
        j = i
        while j + 1 < len(origins) and origins[j + 1]["missed"]:
            j += 1
        lookback = 3
        first = -1
        for k in range(max(0, i - lookback), j + 1):
            if origins[k]["alerted"]:
                first = k
                break
        lead = max(0, (i - first) * step_days) if first >= 0 else None
        episodes.append(
            {
                "startDate": origins[i]["windowStart"],
                "endDate": origins[j]["windowStart"],
                "windows": j - i + 1,
                "alertedBefore": first >= 0,
                "leadDays": lead,
            }
        )
        i = j + 1
    leads = sorted(e["leadDays"] for e in episodes if e["leadDays"] is not None)
    warned = [e for e in episodes if e["alertedBefore"]]
    early_warned = [e for e in warned if (e["leadDays"] or 0) >= 3]

    mae_t = abs_err / counted if counted else 0
    baseline_mae_t = abs_err_base / counted if counted else 0
    # The calibration quoted on the result is the one the *last* origin used.
    final_cal = fit_calibration(
        mine_id, 365, dates[min(last_orig_idx, len(dates) - 1)]
    )
    result: ForecastBacktest = {
        "mineId": mine_id,
        "horizonDays": horizon_days,
        "origins": origins,
        "maeT": _round(mae_t),
        "baselineMaeT": _round(baseline_mae_t),
        "rmseT": _round(math.sqrt(sq_err / counted)) if counted else 0,
        "mapePct": _fixed(abs_pct / counted, 2) if counted else 0,
        "improvementPct": _fixed(((baseline_mae_t - mae_t) / baseline_mae_t) * 100, 1)
        if baseline_mae_t > 0
        else 0,
        "coverage80Pct": _fixed((inside / counted) * 100, 1) if counted else 0,
        "maeWithoutWeatherT": _round(abs_err_no_weather / counted_no_weather)
        if counted_no_weather
        else 0,
        "weatherContributionPct": _fixed(
            (
                (
                    (abs_err_no_weather / counted_no_weather)
                    - (abs_err / counted)
                )
                / (abs_err_no_weather / counted_no_weather)
            )
            * 100,
            1,
        )
        if abs_err_no_weather > 0
        else 0,
        "alertThreshold": alert_threshold,
        "precision": precision,
        "recall": recall,
        "f1": _fixed(
            (2 * precision * recall) / (precision + recall) if precision + recall else 0, 3
        ),
        "falseAlarmRate": _fixed(fp / (fp + tn), 3) if fp + tn else 0,
        "confusion": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
        "sweep": sweep,
        "episodes": episodes,
        "warnedPct": _fixed((len(warned) / len(episodes)) * 100, 1) if episodes else 0,
        "earlyWarnedPct": _fixed((len(early_warned) / len(episodes)) * 100, 1)
        if episodes
        else 0,
        "medianLeadDays": leads[len(leads) // 2] if leads else None,
        "calibration": final_cal,
    }
    _backtest_cache[key] = result
    return result


def portfolio_backtest(opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Company roll-up, weighted by the tonnage each mine actually moves."""
    per = [forecast_backtest(m["id"], opts) for m in MINES]

    def weight(r: ForecastBacktest) -> float:
        return sum(o["actualTotalT"] for o in r["origins"])

    total = sum(weight(r) for r in per) or 1

    def wavg(pick) -> float:
        return _fixed(sum(pick(r) * weight(r) for r in per) / total, 3)

    v = sorted(
        r["medianLeadDays"] for r in per if r["medianLeadDays"] is not None
    )
    return {
        "perMine": per,
        "maeT": _round(wavg(lambda r: r["maeT"])),
        "baselineMaeT": _round(wavg(lambda r: r["baselineMaeT"])),
        "improvementPct": wavg(lambda r: r["improvementPct"]),
        "coverage80Pct": wavg(lambda r: r["coverage80Pct"]),
        "precision": wavg(lambda r: r["precision"]),
        "recall": wavg(lambda r: r["recall"]),
        "medianLeadDays": v[len(v) // 2] if v else None,
    }
