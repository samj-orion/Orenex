"""Port of ``forecast.ts``.

D6 — Production Shortfall Engine.

* 2A  A physical bottleneck capacity model: a mine produces no more than its
  slowest stage, so Capacity = min(drill, blast, muck, haul, hoist).
* 2B  A quantile forecast layered on top, learning the residual the physics
  misses — crew effects and face-grade variability.
* 2C  An equipment survival model supplies downtime into the stage capacities.
* 2D  Weather and ground conditions come from the satellite feeds.

The forecast is a pure function of (mine, date, weather, fleet, overrides), so a
what-if re-run and an approved action both flow through the same code.

Record shapes (plain ``dict`` records, keys keep the TypeScript spelling):

* ``Override``       — ``kind``, ``units``, ``utilDelta``, ``serviceEquipment``,
  ``blastPullForwardDays``, ``stockpileT``, ``note``, ``label``, ``source``.
* ``ForecastDay``    — ``date``, ``dayIndex``, ``planT``, ``p10``, ``p50``,
  ``p90``, ``shortfallT``, ``pShort``, ``residSdT``, ``pShortWeek``,
  ``bottleneck``, ``stages``, ``drivers``, ``weather``, ``isPast``.
* ``MineForecast``   — ``mineId``, ``days``, ``pShort7``, ``pShort30``,
  ``planTotal7``, ``p50Total7``, ``planTotal30``, ``p50Total30``, ``shortfallT7``,
  ``shortfallT30``, ``bottleneck``, ``causeMix``, ``leadTimeDays``, ``coverage``,
  ``calibration``.
* ``ShortfallAlert`` — ``id``, ``mineId``, ``mineName``, ``raisedAt``,
  ``horizonDays``, ``pShort``, ``shortfallT``, ``bottleneck``, ``severity``,
  ``status``, ``causeMix``, ``causeAccuracyPct``, ``leadTimeDays``, ``drivers``,
  ``stageTable``, ``pShort30``, ``shortfallT30``, ``coverage``, ``headline``,
  ``weatherStrip``, ``acknowledgement``, ``notes``.
* ``ActionCard``     — ``id``, ``type``, ``title``, ``psExample``, ``rationale``,
  ``predictedGainT``, ``gainPerLakh``, ``costLakh``, ``costNote``, ``confidence``,
  ``feasibility``, ``params``, ``toOverride``, ``stage``, ``leadDays``,
  ``modelVersion``, ``requiresApproval``.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

from .backtest import (
    day_miss_probability,
    day_predictive,
    day_quantile,
    fit_calibration,
    mixture_sd,
    residual_for,
    window_miss_probability,
)
from .format import NOW, add_days, iso_date, monsoon_factor, num
from .geology import MINES
from .noise import clamp, make_fbm
from .operations import (
    PRODUCTION,
    SHIFTS_PER_DAY,
    SHIFT_HOURS,
    STAGE_LABEL,
    blast_stats,
    fleet_for,
    plan_tpd,
    rate_limits_for,
    stage_ground_factor,
    weather_on,
)
from .rng import make_rng
from .stage_model import (
    STAGE_PRIMARY,
    empty_stage_context,
    mark_bottleneck,
    mine_capacity_t,
    nominal_day_capacity,
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


def _js_number(v: Any) -> float:
    """``Number(v)`` — tolerates the number/string/boolean values the what-if UI sends."""
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    return float(v)


# ── Forward weather (IMD / GPM forecast stand-in) ───────────────────────────

FORECAST_DAYS = 45
fc_fbm = make_fbm(1717, 4, 2.15, 0.56)

# The wet spell sitting in the next week, per mine.
#
# A front crosses the district rather than arriving everywhere at once, so the
# three sites see it at different times and depths. That is what gives the alert
# board staggered lead times instead of three identical criticals.
WET_SPELL: Dict[str, Dict[str, float]] = {
    "MNE-BAL": {"day": 7, "peakMm": 46, "width": 8},
    "MNE-NAG": {"day": 11, "peakMm": 37, "width": 7},
    "MNE-BHA": {"day": 5, "peakMm": 53, "width": 9},
}


def weather_forecast(mine_id: str) -> List[Dict[str, Any]]:
    rng = make_rng(0xC0FFEE + len(mine_id) * 977)
    spell = WET_SPELL.get(mine_id, WET_SPELL["MNE-BAL"])
    out: List[Dict[str, Any]] = []
    for d in range(1, FORECAST_DAYS + 1):
        date = add_days(NOW, d)
        iso = iso_date(date)
        mon = monsoon_factor(date)
        n = (fc_fbm(d / 9, len(mine_id) * 3.1) + 1) / 2
        wet_spell = spell["peakMm"] * math.exp(-((d - spell["day"]) ** 2) / spell["width"])
        rain = max(
            0.0, mon * 58 * n * 1.35 + wet_spell + (rng() - 0.5) * (30 if mon > 0.4 else 4)
        )
        soil = clamp(0.11 + mon * 0.25 + wet_spell / 240 + (rain / 200) * 0.28, 0.07, 0.52)
        lst = clamp(23 + (1 - mon) * 11.5 + (1 - soil) * 5 + (rng() - 0.5) * 2.4, 17, 48)
        ndvi = clamp(0.3 + mon * 0.3 + (rng() - 0.5) * 0.05, 0.14, 0.74)
        rain_fcst = max(0.0, rain * 1.45 + wet_spell * 0.4 + (rng() - 0.5) * 18)
        out.append(
            {
                "date": iso,
                "mineId": mine_id,
                "rainMm": _fixed(rain, 1),
                "rainFcst3dMm": _fixed(rain_fcst, 1),
                "soilMoisture": _fixed(soil, 3),
                "lstC": _fixed(lst, 1),
                "ndvi": _fixed(ndvi, 3),
                "source": "IMD GFS 0.5\u00b0 blended with GPM IMERG bias",
            }
        )
    return out


def weather_for(mine_id: str, iso: str) -> Dict[str, Any]:
    """Observed weather up to today, forecast weather beyond it.

    The lookup has to test the calendar date rather than trust that the historical
    lookup returned something dated the same day: ``weather_on`` gap-fills a
    missing date with climatology, and that filler carries the requested date.
    """
    is_past = iso <= iso_date(NOW)
    if is_past:
        return weather_on(mine_id, iso)
    fc = weather_forecast(mine_id)
    for w in fc:
        if w["date"] == iso:
            return w
    return weather_on(mine_id, iso)


# ── Operational overrides (what-if + approved actions) ──────────────────────

# Shape documented in the module docstring.
Override = Dict[str, Any]


def empty_overrides() -> Dict[str, List[Override]]:
    return {m["id"]: [] for m in MINES}


# ── Forecast ────────────────────────────────────────────────────────────────

# Shape documented in the module docstring.
ForecastDay = Dict[str, Any]
MineForecast = Dict[str, Any]

CAUSE_LABEL: Dict[str, str] = {
    "equipment": "Equipment downtime",
    "weather": "Rainfall & ground",
    "blasting": "Blasting delay",
    "other": "Other constraints",
}

# The forecast model, for the version string on every card and chart.
FORECAST_MODEL_VERSION = "d6-v4.0.0"
FORECAST_FITTED_ON = iso_date(NOW)


def forecast_mine(
    mine_id: str, overrides: Optional[List[Override]] = None, horizon: int = 30
) -> MineForecast:
    overrides = overrides or []
    rates = rate_limits_for(mine_id)
    blast = blast_stats(mine_id, 60)
    cal = fit_calibration(mine_id)

    ctx = empty_stage_context()
    stockpile_t = 0.0
    for o in overrides:
        units = o.get("units")
        if units:
            for s in list(ctx["unitDelta"].keys()):
                ctx["unitDelta"][s] += units.get(s, 0)
        ctx["utilDelta"] += o.get("utilDelta") if o.get("utilDelta") is not None else 0
        ctx["blastPull"] += (
            o.get("blastPullForwardDays")
            if o.get("blastPullForwardDays") is not None
            else 0
        )
        ctx["serviced"].extend(o.get("serviceEquipment") or [])
        stockpile_t += o.get("stockpileT") if o.get("stockpileT") is not None else 0

    days: List[ForecastDay] = []
    predictives: List[Dict[str, Any]] = []
    cause_accumulator: Dict[str, float] = {}

    for d in range(1, horizon + 1):
        date = add_days(NOW, d)
        iso = iso_date(date)
        w = weather_for(mine_id, iso)

        # Stage rows — this is the physics the dashboard shows. Shared with the
        # backtest, so the calibration was fitted against this exact code.
        stage_rows = stage_rows_for(mine_id, w, ctx)
        bottleneck = mark_bottleneck(stage_rows)
        bottleneck_cap = mine_capacity_t(stage_rows)

        # 2B — the quantile forecast layered on the physics.
        dp = day_predictive(cal, w["rainMm"], bottleneck_cap)
        draw = _stockpile_draw_for(d, stockpile_t)
        p50_raw = dp["mu"] + draw
        adjusted = {
            **dp,
            "mu": p50_raw,
            "disruptedMu": p50_raw - dp["mu"] + dp["disruptedMu"],
            "disruptedSdT": dp["disruptedSdT"],
        }
        p10 = max(0, day_quantile(adjusted, 0.1))
        p90 = day_quantile(adjusted, 0.9)

        plan_t = plan_tpd(mine_id, date)
        shortfall_t = max(0.0, plan_t - p50_raw)
        p_short = day_miss_probability(dp, plan_t)
        predictives.append(dp)

        # Drivers, in tonnes of capacity removed on the day, bucketed for the PS
        # categories. Each is measured off the stage rows rather than asserted.
        day_capacity_of = nominal_day_capacity
        equip_loss = sum(
            day_capacity_of(r) * (1 - r["availableFraction"]) for r in stage_rows
        )
        weather_loss = sum(
            day_capacity_of(r) * (1 - r["groundFactor"]) * r["availableFraction"]
            for r in stage_rows
        )
        blast_stage_row = next(r for r in stage_rows if r["stage"] == "blast")
        # Only the ground-factor loss is a same-day capacity removal. Blast
        # adherence is a rolling register statistic, not something that costs
        # tonnes on one particular day.
        blast_loss = max(
            0.0,
            day_capacity_of(blast_stage_row)
            * (1 - blast["adherence"])
            * blast_stage_row["availableFraction"],
        )
        other_loss = max(0, _round(plan_t * 0.028 * (1 + 0.4 * ((d * 7) % 5) / 5)))
        machine_stages = [r for r in stage_rows if r["stage"] != "blast"]
        at_risk_units = sum(
            _round((r["units"] - r["availableUnits"]) * 10) / 10 for r in machine_stages
        )
        avg_availability = sum(
            r["capacityT"] * r["availableFraction"] for r in machine_stages
        ) / max(1, sum(r["capacityT"] for r in machine_stages))

        machine_total = (
            rates["units"]["drill"]
            + rates["units"]["muck"]
            + rates["units"]["haul"]
            + rates["units"]["hoist"]
        )
        haul_ground = stage_ground_factor("haul", w["rainMm"], w["soilMoisture"], w["lstC"])
        drivers = [
            {
                "key": "equipment",
                "label": "Equipment downtime",
                "bucket": "equipment",
                "tonnes": _round(equip_loss),
                "detail": f"{at_risk_units} of {machine_total} stage machines carry elevated "
                f"7-day failure risk, {avg_availability * 100:.1f}% weighted availability",
            },
            {
                "key": "weather",
                "label": "Rainfall & ground condition",
                "bucket": "weather",
                "tonnes": _round(weather_loss),
                "detail": f"{w['rainMm']:.0f} mm/day forecast, soil moisture "
                f"{w['soilMoisture'] * 100:.0f}% \u2014 haul road trafficability factor "
                f"{haul_ground * 100:.0f}%",
            },
            {
                "key": "blasting",
                "label": "Blasting delay",
                "bucket": "blasting",
                "tonnes": _round(blast_loss),
                "detail": f"Blast adherence {blast['adherence'] * 100:.0f}% over 60 days, "
                f"mean delay {blast['meanDelayMin']:.0f} min",
            },
            {
                "key": "other",
                "label": "Material supply & face availability",
                "bucket": "other",
                "tonnes": other_loss,
                "detail": "Explosive deliveries, shift-changeover losses, face availability",
            },
        ]

        for drv in drivers:
            cause_accumulator[drv["bucket"]] = (
                cause_accumulator.get(drv["bucket"], 0) + drv["tonnes"]
            )

        days.append(
            {
                "date": iso,
                "dayIndex": d,
                "planT": plan_t,
                "p10": _round(p10),
                "p50": _round(p50_raw),
                "p90": _round(p90),
                "shortfallT": _round(shortfall_t),
                "pShort": _fixed(p_short, 3),
                "residSdT": _round(mixture_sd(residual_for(cal, w["rainMm"])) * p50_raw),
                "pShortWeek": 0,
                "bottleneck": bottleneck,
                "stages": stage_rows,
                "drivers": drivers,
                "weather": w,
                "isPast": False,
            }
        )

    # Horizon shortfall probability. The window total is a sum of independent
    # mixtures, so it is propagated exactly rather than collapsed into one sd.
    def window_probability(n: int) -> float:
        sl = days[:n]
        if not sl:
            return 0
        return window_miss_probability(predictives[:n], sum(x["planT"] for x in sl))

    for i in range(len(days)):
        win = min(7, i + 1)
        days[i]["pShortWeek"] = _fixed(window_probability(win), 3)
    p_short7 = _fixed(window_probability(7), 3)
    p_short30 = _fixed(window_probability(min(30, len(days))), 3)

    total_cause = sum(cause_accumulator.values()) or 1
    cause_mix = []
    for bucket in CAUSE_LABEL.keys():
        tonnes = cause_accumulator.get(bucket, 0)
        cause_mix.append({"bucket": bucket, "tonnes": tonnes, "share": tonnes / total_cause})
    cause_mix.sort(key=lambda c: -c["tonnes"])

    shortfall_t7 = sum(x["shortfallT"] for x in days[:7])
    shortfall_t30 = sum(x["shortfallT"] for x in days)

    def total_of(n: int, pick) -> float:
        return sum(pick(x) for x in days[:n])

    # Lead time: how many days of warning before the first day crosses 50%.
    crossed = next((x for x in days if x["pShort"] >= 0.5), None)
    lead_time_days = crossed["dayIndex"] if crossed else None

    # Coverage: how much of the input stack is fresh and complete.
    stale_sources = 2  # aerogeophysics + one weather blend
    coverage = clamp(1 - stale_sources * 0.045, 0.5, 1)

    return {
        "mineId": mine_id,
        "days": days,
        "pShort7": p_short7,
        "pShort30": p_short30,
        "planTotal7": _round(total_of(7, lambda x: x["planT"])),
        "p50Total7": _round(total_of(7, lambda x: x["p50"])),
        "planTotal30": _round(total_of(30, lambda x: x["planT"])),
        "p50Total30": _round(total_of(30, lambda x: x["p50"])),
        "shortfallT7": shortfall_t7,
        "shortfallT30": shortfall_t30,
        # The bottleneck that binds most often across the horizon, weighted by how
        # much capacity it removes — the modal stage is what a manager acts on.
        "bottleneck": _dominant_stage(days),
        "causeMix": cause_mix,
        "leadTimeDays": lead_time_days,
        "coverage": coverage,
        "calibration": cal,
    }


def _dominant_stage(days: List[ForecastDay]) -> str:
    """Stage that constrains the most days in the horizon, ties broken by mean capacity."""
    tally: Dict[str, Dict[str, float]] = {}
    for d in days:
        cur = tally.get(d["bottleneck"])
        if cur is None:
            cur = {"days": 0, "cap": 0.0}
        cur["days"] += 1
        row = next((s for s in d["stages"] if s["isBottleneck"]), None)
        cur["cap"] += row["capacityT"] if row is not None else 0
        tally[d["bottleneck"]] = cur
    best = days[0]["bottleneck"] if days else "haul"
    best_score = -1
    for stage, v in tally.items():
        score = v["days"] * 100000 + v["cap"]
        if score > best_score:
            best_score = score
            best = stage
    return best


def _stockpile_draw_for(day: int, stockpile_t: float) -> float:
    if stockpile_t <= 0:
        return 0
    # Draw the buffer down over the first three days, then stop.
    return _round(stockpile_t / 3) if day <= 3 else 0


# ── Alerts ──────────────────────────────────────────────────────────────────

# Shape documented in the module docstring.
ShortfallAlert = Dict[str, Any]

# Operating point for the alert board, per mine, from the rolling-origin backtest.
ALERT_TRIGGER_P: Dict[str, float] = {
    "MNE-BAL": 0.15,
    "MNE-NAG": 0.4,
    "MNE-BHA": 0.2,
}
# Used for a mine not in the table.
ALERT_TRIGGER_DEFAULT_P = 0.45


def alert_trigger_for(mine_id: str) -> float:
    return ALERT_TRIGGER_P.get(mine_id, ALERT_TRIGGER_DEFAULT_P)


# Below this the shortfall is inside the noise and not worth waking anyone.
ALERT_MATERIAL_T = 250
# A miss this deep over plan is a critical even if the probability is moderate.
CRITICAL_SHORT_T = 2500
# Severity bands, on absolute probability. Deliberately not relative to the trigger.
SEVERITY_HIGH_P = 0.7
SEVERITY_CRITICAL_P = 0.9
SEVERITY_MODERATE_P = 0.4


def build_alerts(
    overrides: Optional[Dict[str, List[Override]]] = None,
) -> List[ShortfallAlert]:
    if overrides is None:
        overrides = empty_overrides()
    out: List[ShortfallAlert] = []
    n = 1
    for mine in MINES:
        f = forecast_mine(mine["id"], overrides.get(mine["id"], []) or [])
        trigger = alert_trigger_for(mine["id"])
        # Fire on the week, not on a single bad day.
        horizon_days = (
            7
            if (f["pShort7"] >= trigger or f["shortfallT7"] >= ALERT_MATERIAL_T)
            else 30
        )
        p_short = f["pShort7"] if horizon_days == 7 else f["pShort30"]
        shortfall_t = f["shortfallT7"] if horizon_days == 7 else f["shortfallT30"]
        if p_short < trigger and shortfall_t < ALERT_MATERIAL_T:
            continue

        if p_short >= SEVERITY_CRITICAL_P or shortfall_t >= CRITICAL_SHORT_T:
            severity = "critical"
        elif p_short >= SEVERITY_HIGH_P:
            severity = "high"
        elif p_short >= SEVERITY_MODERATE_P or shortfall_t >= ALERT_MATERIAL_T:
            severity = "moderate"
        else:
            severity = "low"

        top_cause = f["causeMix"][0]
        plan_total = f["planTotal7"] if horizon_days == 7 else f["planTotal30"]
        p50_total = f["p50Total7"] if horizon_days == 7 else f["p50Total30"]
        # Quote the window in the units the reader is being asked about.
        headline = (
            f"{_round(p_short * 100)}% chance the {horizon_days}-day plan of "
            f"{num(plan_total)} t is missed \u2014 median forecast is {num(p50_total)} t, "
            f"a gap of about {num(max(0, plan_total - p50_total))} t. "
            f"{STAGE_LABEL[f['bottleneck']].lower()} is the constraint, driven mainly by "
            f"{CAUSE_LABEL[top_cause['bucket']].lower()}."
        )

        # Cause attribution accuracy measured against the simulator's ground truth.
        truth = cause_truth_share(mine["id"])
        correct = 0.0
        for c in f["causeMix"]:
            correct += min(c["share"], truth.get(c["bucket"], 0))

        out.append(
            {
                "id": f"AL-2026-{4100 + n}",
                "mineId": mine["id"],
                "mineName": mine["name"],
                "raisedAt": add_days(NOW, 0).isoformat(),
                "horizonDays": horizon_days,
                "pShort": p_short,
                "shortfallT": shortfall_t,
                "bottleneck": f["bottleneck"],
                "severity": severity,
                "status": "open",
                "causeMix": f["causeMix"],
                "causeAccuracyPct": _round(clamp(correct * 100, 0, 100)),
                "leadTimeDays": f["leadTimeDays"],
                "drivers": f["days"][0]["drivers"] if f["days"] else [],
                "stageTable": f["days"][0]["stages"] if f["days"] else [],
                "pShort30": f["pShort30"],
                "shortfallT30": f["shortfallT30"],
                "coverage": f["coverage"],
                "headline": headline,
                "weatherStrip": [
                    {
                        "date": d["date"],
                        "rainMm": d["weather"]["rainMm"],
                        "soilMoisture": d["weather"]["soilMoisture"],
                        "lstC": d["weather"]["lstC"],
                    }
                    for d in f["days"][:10]
                ],
                "acknowledgement": None,
                "notes": [],
            }
        )
        n += 1
    out.sort(key=lambda a: -a["pShort"])
    return out


def cause_truth_share(mine_id: str, days: int = 90) -> Dict[str, float]:
    """Ground-truth cause mix from the shift register, over the calibration window.

    The simulator records which stage lost each tonne, so this is a measurement
    rather than a judgement call. Weather is a cause in its own right in the
    register, not a discount applied to the haulage rows.
    """
    from_ = iso_date(add_days(NOW, -days))
    t = {"equipment": 0.0, "weather": 0.0, "blasting": 0.0, "other": 0.0}
    for s in PRODUCTION:
        if s["mineId"] != mine_id or s["date"] < from_ or s["lostT"] == 0:
            continue
        if s["trueCause"] == "weather":
            t["weather"] += s["lostT"]
        elif s["trueCause"] == "blast":
            t["blasting"] += s["lostT"]
        elif s["trueCause"] in ("drill", "muck", "haul", "hoist"):
            t["equipment"] += s["lostT"]
        else:
            t["other"] += s["lostT"]
    total = t["equipment"] + t["weather"] + t["blasting"] + t["other"] or 1
    return {
        "equipment": t["equipment"] / total,
        "weather": t["weather"] / total,
        "blasting": t["blasting"] / total,
        "other": t["other"] / total,
    }


# ── Corrective Action Engine (D7) ───────────────────────────────────────────

# Shape documented in the module docstring.
ActionCard = Dict[str, Any]


def horizon_shortfall(f: MineForecast, horizon_days: int) -> float:
    """Shortfall on the horizon the alert fired on — a 30-day alert measured against
    a 7-day gap reports every card as zero."""
    return f["shortfallT7"] if horizon_days == 7 else f["shortfallT30"]


def action_cards(alert: ShortfallAlert, overrides: Optional[List[Override]] = None) -> List[ActionCard]:
    """Corrective-action candidate set, ranked by measured shortfall recovery.

    Every candidate is scored by re-running the full forecast with that action's
    override applied and taking the drop in shortfall on the alert's horizon.
    Cards that measure zero are dropped rather than shown at their full price.
    """
    if overrides is None:
        overrides = []
    f = forecast_mine(alert["mineId"], overrides)
    cards: List[ActionCard] = []
    other_mine = next(m for m in MINES if m["id"] != alert["mineId"])
    at_risk_fleet = [e for e in fleet_for(alert["mineId"]) if e["failureRisk7d"] > 0.2]
    blast = blast_stats(alert["mineId"], 60)
    spare_dumpers = [
        e for e in fleet_for(other_mine["id"]) if e["type"] == "dumper" and e["spareUnits"] > 0
    ]

    wc = weather_forecast(alert["mineId"])
    wet_days = [w for w in wc if w["rainMm"] > 24][:6]

    # The gap the action has to close, on the horizon the alert fired on.
    base_short = horizon_shortfall(f, alert["horizonDays"])

    def measure(ov: Override) -> float:
        return max(
            0.0,
            base_short
            - horizon_shortfall(
                forecast_mine(alert["mineId"], list(overrides) + [ov]), alert["horizonDays"]
            ),
        )

    # 1 — Equipment re-allocation. Gated on haulage actually being the constraint.
    n_trucks = clamp(len(spare_dumpers), 1, 4)
    if alert["bottleneck"] == "haul" and len(spare_dumpers) > 0:
        to_override: Override = {
            "kind": "unit",
            "units": {"haul": n_trucks},
            "label": f"{n_trucks} dumper{'s' if n_trucks > 1 else ''} from {other_mine['code']}",
            "source": "approved-action",
            "note": f"Transferred from {other_mine['id']}",
        }
        gain = _round(measure(to_override))
        rl = rate_limits_for(alert["mineId"])
        added_tpd = _round(
            rl["ratedTph"]["haul"]
            * rl["utilisation"]["haul"]
            * SHIFT_HOURS
            * SHIFTS_PER_DAY
            * n_trucks
        )
        # Mobilisation + a week of standby, so gain-per-lakh is costed against the
        # whole period the card is proposing.
        cost = n_trucks * 26 + 7 * (n_trucks * 8)
        other_p30 = forecast_mine(other_mine["id"])["pShort30"]
        cards.append(
            {
                "id": f"{alert['id']}-A1",
                "type": "redeploy-equipment",
                "title": f"Move {n_trucks} dumper{'s' if n_trucks > 1 else ''} from "
                f"{other_mine['name']} to {alert['mineName']}",
                "psExample": "Re-deploy equipment across mines",
                "rationale": f"Haulage is the binding constraint at {alert['mineName']} and "
                f"{other_mine['name']} carries {len(spare_dumpers)} "
                f"dumper{'s' if len(spare_dumpers) > 1 else ''} on standby. Moving {n_trucks} "
                f"across adds about {num(added_tpd)} t/d of haul capacity, and the what-if run "
                f"recovers {num(gain)} t of the {num(base_short)} t {alert['horizonDays']}-day "
                f"shortfall.",
                "predictedGainT": gain,
                "gainPerLakh": _fixed(gain / cost, 1),
                "costLakh": cost,
                "costNote": f"\u20b9{n_trucks * 26} L mobilisation \u00b7 2 d transfer \u00b7 "
                f"\u20b9{n_trucks * 8} L standby/day",
                "confidence": 0.78,
                "feasibility": [
                    {
                        "label": "Machine compatibility",
                        "ok": True,
                        "detail": "Rear dump trucks \u2014 same class at both sites",
                    },
                    {"label": "Transfer time", "ok": True, "detail": "38 km, 2 days with escort"},
                    {
                        "label": "Operator availability",
                        "ok": len(spare_dumpers) >= 2,
                        "detail": f"{len(spare_dumpers)} certified operators free at "
                        f"{other_mine['name']}",
                    },
                    {
                        "label": "Source mine plan headroom",
                        "ok": len(spare_dumpers) >= 2,
                        "detail": f"{other_mine['name']} P(30-day miss) "
                        f"{other_p30 * 100:.0f}% \u2014 headroom available",
                    },
                ],
                "params": {"units": n_trucks, "days": 7, "transferDays": 2},
                "toOverride": to_override,
                "stage": "haul",
                "leadDays": 2,
                "modelVersion": FORECAST_MODEL_VERSION,
                "requiresApproval": True,
            }
        )

    # 2 — Pull extraction forward before the rain window.
    if wet_days:
        ot_shifts = len(wet_days) + 1
        stock_t = 3400
        to_override = {
            "kind": "stockpile",
            "stockpileT": stock_t,
            "utilDelta": 0.012 * ot_shifts,
            "label": f"Pre-rain pull-forward ({ot_shifts} OT shifts)",
            "source": "approved-action",
        }
        gain = _round(measure(to_override))
        cost = _round(len(wet_days) * 11.5)
        first_wet = next((w for w in wc if w["rainMm"] > 24), wc[0])
        ground_haul = stage_ground_factor("haul", 40, 0.34, 30)
        cards.append(
            {
                "id": f"{alert['id']}-A2",
                "type": "pull-forward-extraction",
                "title": f"Pull ore extraction forward ahead of the {len(wet_days)}-day wet window",
                "psExample": "Adjust mine schedules",
                "rationale": f"{first_wet['date'][8:]} onwards the forecast rainfall exceeds "
                f"24 mm/day, which drops the haul-road trafficability factor to "
                f"{ground_haul * 100:.0f}%. Working the current faces on the two preceding "
                f"shifts banks the tonnes now.",
                "predictedGainT": gain,
                "gainPerLakh": _fixed(gain / cost, 1),
                "costLakh": cost,
                "costNote": f"Overtime crews \u20b9{len(wet_days) * 9:.0f} L \u00b7 re-sequenced "
                f"haulage \u20b9{len(wet_days) * 2.5:.1f} L",
                "confidence": 0.71,
                "feasibility": [
                    {
                        "label": "Approved blast designs",
                        "ok": True,
                        "detail": "Re-sequencing only, no new pattern",
                    },
                    {
                        "label": "Crew roster",
                        "ok": len(wet_days) <= 4,
                        "detail": "Overtime available within weekly hour cap"
                        if len(wet_days) <= 4
                        else "Exceeds weekly hour cap \u2014 needs 2 crews",
                    },
                    {
                        "label": "ROM stockpile capacity",
                        "ok": True,
                        "detail": f"{num(3400)} t free at the plant stockpile",
                    },
                    {
                        "label": "Statutory limits",
                        "ok": True,
                        "detail": "No change to shift-length or fatigue limits",
                    },
                ],
                "params": {
                    "wetWindowDays": len(wet_days),
                    "overtimeShifts": ot_shifts,
                    "stockpileT": stock_t,
                },
                "toOverride": to_override,
                "stage": "haul",
                "leadDays": 1,
                "modelVersion": "d7-v3.1.0",
                "requiresApproval": True,
            }
        )

    # 3 — Blast resequencing.
    dry_rounds = max(1, 6 - (blast["count"] % 5))
    if alert["bottleneck"] == "blast" or blast["adherence"] < 0.92:
        to_override = {
            "kind": "blast",
            "blastPullForwardDays": dry_rounds,
            "label": f"Blast resequence ({dry_rounds} rounds)",
            "source": "approved-action",
        }
        gain = _round(measure(to_override))
        cost = 14
        reason_part = (
            f"The dominant reason is {blast['byReason'][0]['reason'].replace('_', ' ')} at "
            f"{blast['byReason'][0]['hours']:.0f} h lost."
            if blast["byReason"]
            else ""
        )
        cards.append(
            {
                "id": f"{alert['id']}-A3",
                "type": "blast-resequence",
                "title": "Re-sequence blast windows into the dry window and fix clearance backlog",
                "psExample": "Optimise blasting",
                "rationale": f"{blast['onTime']} of {blast['count']} blasts fired on schedule "
                f"over 60 days. {reason_part} Clearing the backlog and moving rounds into the "
                f"{dry_rounds}-round dry window inside approved burden and spacing recovers "
                f"face availability.",
                "predictedGainT": gain,
                "gainPerLakh": _fixed(gain / cost, 1),
                "costLakh": cost,
                "costNote": "Face-crew re-sequencing, no change to explosives quantity",
                "confidence": 0.64,
                "feasibility": [
                    {
                        "label": "Approved blast design",
                        "ok": True,
                        "detail": f"Burden {blast['meanPowderFactor']:.2f} kg/t kept within the "
                        f"mine's approved range 0.28\u20130.50",
                    },
                    {
                        "label": "Statutory clearance",
                        "ok": True,
                        "detail": "Clearance certification unchanged",
                    },
                    {
                        "label": "Fragmentation target",
                        "ok": blast["meanP80"] < 165,
                        "detail": f"Mean P80 {blast['meanP80']:.0f} mm vs target < 165 mm",
                    },
                ],
                "params": {"dryWindowRounds": dry_rounds, "clearanceBacklog": 2},
                "toOverride": to_override,
                "stage": "blast",
                "leadDays": 1,
                "modelVersion": "d7-v3.1.0",
                "requiresApproval": True,
            }
        )

    # 4 — Preventive maintenance, on the machines at the bottleneck stage first.
    bottleneck_type = STAGE_PRIMARY[alert["bottleneck"]]
    at_bottleneck = [e for e in at_risk_fleet if e["type"] == bottleneck_type]
    targets = (at_bottleneck if len(at_bottleneck) >= 2 else at_risk_fleet)[:3]
    if targets:
        top = targets
        downtime_avoided = sum(e["expectedDowntimeH"] for e in top)
        to_override = {
            "kind": "maintenance",
            "serviceEquipment": [e["equipId"] for e in top],
            "label": f"PM on {len(top)} high-risk machines",
            "source": "approved-action",
        }
        gain = _round(measure(to_override))
        cost = 19
        machines_desc = ", ".join(
            f"{e['equipId']} (P(failure 7 d) {e['failureRisk7d'] * 100:.0f}%)" for e in top
        )
        cards.append(
            {
                "id": f"{alert['id']}-A4",
                "type": "preventive-maintenance",
                "title": f"Pull preventive service forward on {len(top)} high-risk machines",
                "psExample": "Re-deploy equipment / maintain now",
                "rationale": f"{machines_desc} \u2014 {downtime_avoided:.0f} h of expected "
                f"downtime on the {STAGE_LABEL[alert['bottleneck']].lower()} stage, which is "
                f"the constraint. Servicing them in the next low-demand shift removes that "
                f"exposure; the what-if run recovers {num(gain)} t over the "
                f"{alert['horizonDays']} days.",
                "predictedGainT": gain,
                "gainPerLakh": _fixed(gain / cost, 1),
                "costLakh": cost,
                "costNote": f"\u20b96 L per major service \u00b7 {len(top)} machines \u00b7 "
                f"1 low-demand shift",
                "confidence": 0.83,
                "feasibility": [
                    {
                        "label": "Maintenance window",
                        "ok": True,
                        "detail": "Fits the Sunday low-demand window at this mine",
                    },
                    {
                        "label": "Spare parts",
                        "ok": len(top) <= 2,
                        "detail": f"{'Both' if len(top) == 2 else '2 of'} kits in the central store",
                    },
                    {
                        "label": "Statutory inspection",
                        "ok": True,
                        "detail": "Statutory inspection dates unaffected",
                    },
                ],
                "params": {
                    "machines": ", ".join(e["equipId"] for e in top),
                    "count": len(top),
                    "shift": "Sunday C",
                },
                "toOverride": to_override,
                "stage": alert["bottleneck"],
                "leadDays": 1,
                "modelVersion": "d7-v3.1.0",
                "requiresApproval": True,
            }
        )

    # 5 — Grade blend resequencing (MILP blend optimisation in the design).
    blend_override: Override = {
        "kind": "shift",
        "utilDelta": 0.02,
        "label": "Face re-sequence to hold 27% blend",
        "source": "approved-action",
    }
    blend_gain = _round(measure(blend_override))
    blend_cost = 3
    cards.append(
        {
            "id": f"{alert['id']}-A5",
            "type": "grade-blend",
            "title": "Re-sequence faces to hold the 27% Mn dispatch blend",
            "psExample": "Adjust mine schedules (grade blend)",
            "rationale": "Two faces would break the buyer blend if drawn this week. Sequencing "
            "the 29.4% Mn face ahead of the 23.1% Mn face keeps the running blend inside the "
            "26\u201328% contract window without any additional mining. Recovery is small \u2014 "
            "it raises mucking utilisation, not the binding stage \u2014 so it ranks below the "
            "equipment and schedule actions.",
            "predictedGainT": blend_gain,
            "gainPerLakh": _fixed(blend_gain / blend_cost, 1),
            "costLakh": blend_cost,
            "costNote": "Sequencing only \u2014 zero incremental cost",
            "confidence": 0.88,
            "feasibility": [
                {
                    "label": "Blend target 26\u201328% Mn",
                    "ok": True,
                    "detail": "Projected running blend 27.1%",
                },
                {
                    "label": "Face availability",
                    "ok": True,
                    "detail": "Both faces have \u2265 3 days of reserves",
                },
                {
                    "label": "Contract terms",
                    "ok": True,
                    "detail": "No penalty exposure at the projected blend",
                },
            ],
            "params": {"blendTarget": 27, "faceOrder": "29.4% face first", "withinWindow": True},
            "toOverride": blend_override,
            "stage": "muck",
            "leadDays": 0,
            "modelVersion": "d7-v3.1.0",
            "requiresApproval": True,
        }
    )

    # Ranked by measured recovery, ties broken by cost-effectiveness. Zero-recovery
    # candidates are dropped: a card that recommends spending money to recover
    # nothing is an approval request, not advice.
    viable = [c for c in cards if c["predictedGainT"] > 0]
    viable.sort(key=lambda c: (-c["predictedGainT"], -c["gainPerLakh"]))
    return viable


def what_if(
    alert: ShortfallAlert,
    card: ActionCard,
    edits: Dict[str, Any],
    applied_overrides: Optional[List[Override]] = None,
) -> Dict[str, Any]:
    """What-if: re-simulate with edited parameters, synchronously (< 2 s target)."""
    if applied_overrides is None:
        applied_overrides = []
    override = _build_override_from(card, edits)
    combined = list(applied_overrides) + [override]
    base = forecast_mine(alert["mineId"], applied_overrides)
    adj = forecast_mine(alert["mineId"], combined)
    # On the alert's horizon, not always the week — same reason the cards are.
    horizon_days = alert["horizonDays"]
    base_h = sum(d["p50"] for d in base["days"][:horizon_days])
    adj_h = sum(d["p50"] for d in adj["days"][:horizon_days])
    baseline_shortfall_t = _round(horizon_shortfall(base, horizon_days))
    residual_shortfall_t = _round(horizon_shortfall(adj, horizon_days))
    # Shortfall removed, not tonnage added. A stockpile draw banks tonnage that was
    # always going to be crushed, so the curve shows extra tonnes while the gap
    # against plan barely moves.
    gain = max(0, baseline_shortfall_t - residual_shortfall_t)
    cost_lakh = _estimate_cost(card, edits)
    return {
        "baselineP50": _round(base_h),
        "adjustedP50": _round(adj_h),
        "gainT": _round(gain),
        "baselineShortfallT": baseline_shortfall_t,
        "residualShortfallT": residual_shortfall_t,
        "horizonDays": horizon_days,
        "curve": [
            {
                "day": i + 1,
                "date": d["date"],
                "baseline": base["days"][i]["p50"] if i < len(base["days"]) else d["p50"],
                "adjusted": d["p50"],
                "plan": d["planT"],
            }
            for i, d in enumerate(adj["days"][:14])
        ],
        "costLakh": cost_lakh,
        "gainPerLakh": gain / cost_lakh if cost_lakh > 0 else 0,
        "pShortAfter": adj["pShort7"] if horizon_days == 7 else adj["pShort30"],
        "pShortBefore": base["pShort7"] if horizon_days == 7 else base["pShort30"],
    }


def _build_override_from(card: ActionCard, edits: Dict[str, Any]) -> Override:
    o: Override = dict(card["toOverride"])
    t = card["type"]
    if t == "redeploy-equipment":
        units = _js_number(edits["units"] if edits.get("units") is not None else 2)
        days = _js_number(edits["days"] if edits.get("days") is not None else 7)
        o["units"] = {"haul": units}
        o["label"] = f"{units} dumpers \u00b7 {days} d"
        o["note"] = f"Re-allocation for {days} days"
    elif t == "pull-forward-extraction":
        shifts = _js_number(edits["overtimeShifts"] if edits.get("overtimeShifts") is not None else 2)
        stock = _js_number(edits["stockpileT"] if edits.get("stockpileT") is not None else 2000)
        o["stockpileT"] = stock
        o["utilDelta"] = clamp(0.012 * shifts, 0, 0.07)
        o["label"] = f"{shifts} OT shifts \u00b7 {stock} t buffer"
    elif t == "blast-resequence":
        rounds = _js_number(edits["dryWindowRounds"] if edits.get("dryWindowRounds") is not None else 2)
        o["blastPullForwardDays"] = rounds
        o["label"] = f"{rounds} rounds in the dry window"
    elif t == "preventive-maintenance":
        count = _js_number(edits["count"] if edits.get("count") is not None else 2)
        all_ = card["toOverride"].get("serviceEquipment") or []
        o["serviceEquipment"] = all_[: int(count)]
        o["label"] = f"PM on {int(count)} machines"
    elif t == "grade-blend":
        o["utilDelta"] = 0.008
    return o


def _estimate_cost(card: ActionCard, edits: Dict[str, Any]) -> float:
    t = card["type"]
    if t == "redeploy-equipment":
        return _round(
            _js_number(edits["units"] if edits.get("units") is not None else 2) * 34
            + _js_number(edits["days"] if edits.get("days") is not None else 7) * 8
            + 18
        )
    if t == "pull-forward-extraction":
        return _round(
            _js_number(edits["overtimeShifts"] if edits.get("overtimeShifts") is not None else 2) * 9
            + _js_number(edits["stockpileT"] if edits.get("stockpileT") is not None else 2000)
            / 1000
            * 2.5
        )
    if t == "blast-resequence":
        return 14 + _js_number(
            edits["dryWindowRounds"] if edits.get("dryWindowRounds") is not None else 2
        ) * 2
    if t == "preventive-maintenance":
        return 6 * _js_number(edits["count"] if edits.get("count") is not None else 2) + 7
    if t == "grade-blend":
        return 3
    return card["costLakh"]


def blast_adherence(mine_id: str) -> Dict[str, Any]:
    b = blast_stats(mine_id, 60)
    return {"adherence": b["adherence"], "meanDelayMin": b["meanDelayMin"], "count": b["count"]}


def blast_adherence_series(mine_id: str, days: int = 120) -> List[Dict[str, Any]]:
    rng = make_rng(31 + len(mine_id) * 71)
    out: List[Dict[str, Any]] = []
    d = days
    while d >= 0:
        date = add_days(NOW, -d)
        blasts = 2 + math.floor(rng() * 3)
        on_time = max(0, blasts - math.floor(rng() * 2.2))
        out.append(
            {"date": iso_date(date), "adherence": on_time / blasts, "delays": blasts - on_time}
        )
        d -= 2
    return out
