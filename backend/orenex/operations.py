"""Port of ``operations.ts``.

D9 — Mine operations simulator.

A discrete-event stand-in for the drill -> blast -> muck -> haul -> hoist chain.
Because the simulator knows the true cause of every lost tonne, the prototype
can measure cause-attribution accuracy and A/B test corrective actions — which
is impossible on real data in a hackathon. Every table here is flagged
is_synthetic = true, exactly as the data plan requires.

Record shapes (dicts, keys in the exact TypeScript spelling):

* ``Equipment``       — equipId, type, mineId, ratedTph, commissioned,
  hoursSinceService, ageYears, pastFailures, failureRisk7d, expectedDowntimeH,
  availability30d, utilisation30d, health, odometerH, spareUnits.
* ``ProductionShift`` — date, mineId, shift, faceId, plannedT, actualT, mnPct,
  trueCause, lostT.
* ``WeatherDay``      — date, mineId, rainMm, rainFcst3dMm, soilMoisture, lstC,
  ndvi, source.
* ``BlastLog``        — blastId, faceId, mineId, plannedTs, actualTs, delayMin,
  delayReason, holes, explosiveKg, powderFactor, p80FragMm.
* ``StageRates``      — units, ratedTph, utilisation (each a Stage -> number).
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from .format import NOW, add_days, iso_date, monsoon_factor
from .geology import MINES
from .noise import clamp, make_fbm
from .rng import make_rng

# ── Types ───────────────────────────────────────────────────────────────

# ``ShiftCode`` — 'A' | 'B' | 'C'; ``Stage`` — the five ore-circuit stages;
# ``EquipType`` — the machine classes; ``LossCause`` — Stage | 'weather' | 'none'.
ShiftCode = str
Stage = str
EquipType = str
LossCause = str

STAGES: List[Stage] = ["drill", "blast", "muck", "haul", "hoist"]

STAGE_LABEL: Dict[Stage, str] = {
    "drill": "Drilling",
    "blast": "Blasting",
    "muck": "Mucking",
    "haul": "Haulage",
    "hoist": "Hoisting / dispatch",
}

# Shape documented in the module docstring.
Equipment = Dict[str, Any]

# Shape documented in the module docstring.
ProductionShift = Dict[str, Any]


# ── Date / number helpers ───────────────────────────────────────────────


def _epoch_ms(d: datetime) -> int:
    """JS ``Date.getTime()`` — milliseconds since the epoch."""
    return math.floor(d.timestamp() * 1000)


def _js_day_of_week(d: datetime) -> int:
    """JS ``Date.getDay()`` — 0 = Sunday .. 6 = Saturday."""
    return (d.weekday() + 1) % 7


def _iso_ts(d: datetime) -> str:
    """ISO-8601 local timestamp string for JSON payloads (blast register)."""
    return d.isoformat()


def _round_to(v: float, decimals: int) -> float:
    """``Number(v.toFixed(decimals))`` — round half away from zero, as a float."""
    factor = 10**decimals
    x = v * factor
    r = math.floor(abs(x) + 0.5)
    return (r if x >= 0 else -r) / factor


def _find_mine(mine_id: str) -> Optional[Dict[str, Any]]:
    for m in MINES:
        if m["id"] == mine_id:
            return m
    return None


# ── The production plan ─────────────────────────────────────────────────


def plan_tpd(mine_id: str, date: datetime) -> float:
    """Plan, tonnes per day, at nameplate for the given mine and date."""
    mine = _find_mine(mine_id)
    if not mine:
        return 0
    mon = monsoon_factor(date)
    # Small scheduling wobble plus the monsoon trim on the plan itself.
    wobble = 1 + 0.03 * math.sin(date.day * 2.399 + mine["x"] / 9000)
    return math.floor((mine["designTpd"] * (1 - 0.08 * mon) * wobble) / 10 + 0.5) * 10


def plant_ceiling_shift_t(mine_id: str) -> float:
    """Ceiling on what a crew can feed the plant, tonnes per shift."""
    mine = _find_mine(mine_id)
    design_tpd = mine["designTpd"] if mine else 0
    return (design_tpd * PLANT_CEILING) / SHIFTS_PER_DAY


PLANT_CEILING = 1.25

# Shape documented in the module docstring.
WeatherDay = Dict[str, Any]

# Shape documented in the module docstring.
BlastLog = Dict[str, Any]

# ── Deterministic daily series ──────────────────────────────────────────

HISTORY_DAYS = 1095  # three years of shift records
BLAST_LOG_DAYS = 365  # the blast register is kept for one year
# A/B/C shifts, so a day's capacity is three shifts of it.
SHIFTS_PER_DAY = 3

# ``StageRates`` — available units, rated throughput per unit and typical
# utilisation, each keyed by Stage.
StageRates = Dict[str, Any]


# Stage rates per mine, in tonnes of ore per shift.
#
# Every mine's stages are sized to roughly the same target: about 5% above
# nameplate on the four stages that are not binding, with the fifth left 1-3%
# *below* it. That is the whole design of the shortfall engine. The binding
# stage differs by mine — haulage at Balaghat, hoisting at the Nagpur
# underground panel, blasting at Bhandara — so corrective actions are
# mine-specific rather than generic. ``primary`` names the machine class that
# carries each stage, so availability losses are charged to the right equipment.
STAGE_RATE_TABLE: Dict[str, Dict[str, Any]] = {
    "MNE-BAL": {
        # 1450 tpd open cast. Bottleneck: haulage.
        "units": {"drill": 3, "blast": 1, "muck": 4, "haul": 3, "hoist": 1},
        "ratedTph": {"drill": 30, "blast": 96, "muck": 21, "haul": 26.6, "hoist": 76},
        "primary": {"drill": "drill", "blast": None, "muck": "LHD", "haul": "dumper", "hoist": "hoist"},
    },
    "MNE-NAG": {
        # 820 tpd underground panel. Bottleneck: hoisting and ventilation.
        "units": {"drill": 2, "blast": 1, "muck": 4, "haul": 5, "hoist": 2},
        "ratedTph": {"drill": 25, "blast": 54, "muck": 13, "haul": 11, "hoist": 20.6},
        "primary": {"drill": "drill", "blast": None, "muck": "LHD", "haul": "dumper", "hoist": "hoist"},
    },
    "MNE-BHA": {
        # 1100 tpd open cast. Bottleneck: blasting.
        "units": {"drill": 2, "blast": 1, "muck": 3, "haul": 4, "hoist": 1},
        "ratedTph": {"drill": 33, "blast": 70, "muck": 22, "haul": 16, "hoist": 58},
        "primary": {"drill": "drill", "blast": None, "muck": "LHD", "haul": "dumper", "hoist": "hoist"},
    },
}


def stage_rates(mine_id: str) -> StageRates:
    table = STAGE_RATE_TABLE.get(mine_id, STAGE_RATE_TABLE["MNE-BAL"])
    return {
        "units": {**table["units"]},
        "ratedTph": {**table["ratedTph"]},
        "utilisation": {
            "drill": 0.78,
            "blast": 0.72,
            "muck": 0.81,
            "haul": 0.84,
            "hoist": 0.88,
        },
    }


SHIFT_HOURS = 8


def nominal_stage_capacity(
    stage: Stage, rates: StageRates, unit_delta: float = 0, util_delta: float = 0
) -> float:
    """Stage capacity in tonnes per shift, before weather."""
    units = rates["units"][stage] + unit_delta
    util = clamp(rates["utilisation"][stage] + util_delta, 0.3, 0.98)
    return units * rates["ratedTph"][stage] * util * SHIFT_HOURS


def stage_ground_factor(stage: Stage, rain_mm: float, soil_moisture: float, lst_c: float) -> float:
    """Weather / ground factor per stage, 1 = unrestricted."""
    wet = clamp(rain_mm / 90, 0, 1) * 0.6 + clamp((soil_moisture - 0.18) / 0.3, 0, 1) * 0.4
    heat = clamp((lst_c - 36) / 12, 0, 1)
    if stage == "drill":
        return clamp(1 - 0.34 * wet - 0.06 * heat, 0.45, 1)
    if stage == "blast":
        # The round slips to the next dry window; the muck pile carries the day.
        return clamp(1 - 0.55 * clamp(rain_mm / 45, 0, 1), 0.42, 1)
    if stage == "muck":
        return clamp(1 - 0.42 * wet - 0.1 * heat, 0.42, 1)
    if stage == "haul":
        # Haul roads are regraded and the fleet slows down, but trafficability
        # never falls far enough to stop the pit.
        return clamp(1 - 0.66 * wet - 0.12 * heat, 0.42, 1)
    if stage == "hoist":
        return clamp(1 - 0.14 * wet - 0.08 * heat, 0.7, 1)
    return 1


def build_weather() -> List[WeatherDay]:
    rng = make_rng(3141592)
    fbm = make_fbm(2718, 4, 2.1, 0.55)
    out: List[WeatherDay] = []
    for d in range(HISTORY_DAYS, -1, -1):
        date = add_days(NOW, -d)
        iso = iso_date(date)
        for mine in MINES:
            mon = monsoon_factor(date)
            noise = (fbm(d / 14, mine["x"] / 4000) + 1) / 2
            base = mon * 62 * noise * 1.5
            rain = max(0.0, base + (rng() - 0.5) * (34 if mon > 0.4 else 4))
            soil = clamp(0.1 + mon * 0.26 + (rain / 180) * 0.3 + (rng() - 0.5) * 0.03, 0.06, 0.5)
            lst = clamp(24 + (1 - mon) * 11 + (1 - soil) * 5 + (rng() - 0.5) * 2.6, 18, 47)
            ndvi = clamp(0.32 + mon * 0.28 + (rng() - 0.5) * 0.05, 0.15, 0.72)
            out.append(
                {
                    "date": iso,
                    "mineId": mine["id"],
                    "rainMm": _round_to(rain, 1),
                    "rainFcst3dMm": _round_to(max(0.0, rain * 1.4 + (rng() - 0.5) * 20), 1),
                    "soilMoisture": _round_to(soil, 3),
                    "lstC": _round_to(lst, 1),
                    "ndvi": _round_to(ndvi, 3),
                    "source": "GPM IMERG v7 + ERA5-Land",
                }
            )
    return out


WEATHER: List[WeatherDay] = build_weather()


def weather_on(mine_id: str, iso_date: str) -> WeatherDay:
    for w in WEATHER:
        if w["mineId"] == mine_id and w["date"] == iso_date:
            return w
    return {
        "date": iso_date,
        "mineId": mine_id,
        "rainMm": 0,
        "rainFcst3dMm": 0,
        "soilMoisture": 0.16,
        "lstC": 33,
        "ndvi": 0.4,
        "source": "gap-filled climatology",
    }


# Machine-borne causes of a lost tonne, in the order a shift register would list
# them. Weather and blasting are handled separately.
MACHINE_CAUSES: List[Stage] = ["haul", "muck", "drill", "haul", "muck", "hoist"]


def simulate_day(
    mine: Dict[str, Any],
    date: datetime,
    ctx: Optional[Dict[str, Any]] = None,
) -> List[ProductionShift]:
    """One day of the shift register, as a pure function of the circuit's state.

    ``ctx`` accepts unitDelta (number or Stage -> number), blastPull,
    serviceDays and utilDelta — the same override surface the TS uses for the
    corrective-action A/B.
    """
    ctx = ctx or {}
    rates = stage_rates(mine["id"])
    grade_noise = make_fbm(4821, 3, 2.2, 0.5)
    crew_effect = make_fbm(5311, 3, 2.4, 0.5)
    iso = iso_date(date)
    w = weather_on(mine["id"], iso)

    # The seed is derived from the date so a single day can be replayed on its
    # own without walking the three-year history to reach it.
    rng = make_rng(99991 + math.floor(_epoch_ms(date) / 864e5) * 131 + ord(mine["code"][0]) * 17)
    day = math.floor((_epoch_ms(date) - _epoch_ms(add_days(NOW, -HISTORY_DAYS))) / 864e5 + 0.5)
    doy = day / HISTORY_DAYS
    plant_ceiling = plant_ceiling_shift_t(mine["id"])

    unit_delta = ctx.get("unitDelta")

    def extra_units(s: Stage) -> float:
        if isinstance(unit_delta, (int, float)):
            return unit_delta
        if unit_delta is None:
            return 0
        return unit_delta.get(s, 0)

    util_delta = ctx.get("utilDelta")
    if util_delta is None:
        util_delta = 0

    caps = [nominal_stage_capacity(s, rates, extra_units(s), util_delta) for s in STAGES]
    stage_cap = [
        caps[i] * stage_ground_factor(s, w["rainMm"], w["soilMoisture"], w["lstC"])
        for i, s in enumerate(STAGES)
    ]
    # Rounds pulled forward into the day: the pile carries more broken ore.
    if ctx.get("blastPull"):
        i = STAGES.index("blast")
        stage_cap[i] *= 1 + 0.18 * ctx["blastPull"]
    # Pre-emptive service: the machines the action would have serviced stop
    # failing during the window, which is the whole point of a PM card.
    service_days = ctx.get("serviceDays")
    disruption_p = 0 if service_days else 0.055
    bottleneck_idx = stage_cap.index(min(stage_cap))
    bottleneck = STAGES[bottleneck_idx]

    crew = 1 + 0.1 * crew_effect(doy * 22, mine["x"] / 5000)
    capacity = min(stage_cap) * crew

    plan_per_shift = plan_tpd(mine["id"], date) / SHIFTS_PER_DAY
    dow = _js_day_of_week(date)
    out: List[ProductionShift] = []

    for shift in ["A", "B", "C"]:
        per_shift = (
            math.floor(
                (plan_per_shift * (1.04 if shift == "B" else (0.96 if shift == "C" else 1))) / 10
                + 0.5
            )
            * 10
        )
        shift_factor = 0.97 + 0.06 * rng()
        weekend = 0.94 if dow == 0 else 1
        disrupted = rng() < disruption_p
        if disrupted:
            disruption_loss = (0.05 + rng() * 0.1) if service_days else (0.2 + rng() * 0.4)
        else:
            disruption_loss = 0
        derate = min(stage_cap) / max(1e-6, min(caps))
        p_weather = clamp(0.05 + 0.62 * (1 - derate), 0.05, 0.62)
        p_blast = clamp(
            0.1 + (0.22 if bottleneck == "blast" else 0) + (0.14 if w["rainMm"] > 18 else 0),
            0.08,
            0.46,
        )
        r = rng()

        def machine_cause() -> LossCause:
            return MACHINE_CAUSES[math.floor(rng() * len(MACHINE_CAUSES))]

        if disrupted:
            weighted_cause = machine_cause()
        elif r < p_weather:
            weighted_cause = "weather"
        elif r < p_weather + p_blast:
            weighted_cause = "blast"
        else:
            weighted_cause = machine_cause()
        capability = capacity * shift_factor * weekend * (0.985 + 0.03 * rng()) * (1 - disruption_loss)
        actual = max(60, math.floor(min(plant_ceiling, capability) + 0.5))
        face_no = ((day * 3 + ord(shift)) % 17) + 1
        grade = clamp(
            mine["feedGradeMn"] + 4.2 * grade_noise(doy * 40, mine["y"] / 6000) + (rng() - 0.5) * 2.2,
            12,
            42,
        )
        out.append(
            {
                "date": iso,
                "mineId": mine["id"],
                "shift": shift,
                "faceId": f"{mine['code']}-F{face_no:02d}",
                "plannedT": per_shift,
                "actualT": actual,
                "mnPct": _round_to(grade, 2),
                "trueCause": weighted_cause if actual < per_shift else "none",
                "lostT": max(0, per_shift - actual),
            }
        )
    return out


def build_production() -> List[ProductionShift]:
    out: List[ProductionShift] = []
    for mine in MINES:
        for d in range(HISTORY_DAYS, -1, -1):
            out.extend(simulate_day(mine, add_days(NOW, -d)))
    return out


PRODUCTION: List[ProductionShift] = build_production()


# Failure model: Weibull with shape 1.8 (increasing hazard) on hours since last
# service; the scale is per machine class.
WEIBULL_SHAPE = 1.8
RELIABILITY_SCALE: Dict[EquipType, float] = {
    "dumper": 750,
    "LHD": 780,
    "loader": 820,
    "drill": 1250,
    "compressor": 1800,
    "hoist": 2100,
}

# Fraction of machines whose service interval has been overrun.
OVERDUE_SHARE = 0.12
OVERDUE_EXTRA_H = 700

# Fleet inventory per mine.
FLEET_INVENTORY: Dict[str, List[Dict[str, Any]]] = {
    "MNE-BAL": [
        {"type": "dumper", "count": 9, "tph": [10.5, 13.5]},
        {"type": "drill", "count": 5, "tph": [25, 29]},
        {"type": "LHD", "count": 7, "tph": [17, 21]},
        {"type": "loader", "count": 3, "tph": [18, 22]},
        {"type": "hoist", "count": 2, "tph": [64, 76]},
        {"type": "compressor", "count": 3, "tph": [45, 60]},
    ],
    "MNE-NAG": [
        {"type": "dumper", "count": 8, "tph": [8.5, 11.5]},
        {"type": "drill", "count": 4, "tph": [21, 25]},
        {"type": "LHD", "count": 7, "tph": [10.5, 13.5]},
        {"type": "hoist", "count": 3, "tph": [17, 21]},
        {"type": "compressor", "count": 3, "tph": [45, 60]},
    ],
    "MNE-BHA": [
        {"type": "dumper", "count": 7, "tph": [12.5, 15.5]},
        {"type": "drill", "count": 4, "tph": [28, 32]},
        {"type": "LHD", "count": 6, "tph": [18, 22]},
        {"type": "hoist", "count": 2, "tph": [48, 58]},
        {"type": "compressor", "count": 2, "tph": [45, 60]},
    ],
}


def build_equipment() -> List[Equipment]:
    rng = make_rng(551133)
    out: List[Equipment] = []
    for mine in MINES:
        fleet = FLEET_INVENTORY.get(mine["id"], FLEET_INVENTORY["MNE-BAL"])
        seq = 1
        for f in fleet:
            for i in range(f["count"]):
                age = 1.5 + rng() * 12
                # Hours since the last planned service. A minority sit well past
                # the interval — deferred services, parts on order — and those
                # are the machines the corrective-action engine should find.
                hours_since_service = (
                    55
                    + rng() * 470
                    + (OVERDUE_EXTRA_H * (0.4 + rng() * 0.6) if rng() < OVERDUE_SHARE else 0)
                )
                past_failures = math.floor(rng() * (age * 0.9))
                # Weibull hazard (shape 1.8) on hours since service, scaled per
                # class: trucks and loading units fail sooner than hoists.
                scale = RELIABILITY_SCALE[f["type"]]
                hazard = (WEIBULL_SHAPE / scale) * math.pow(
                    max(1, hours_since_service) / scale, WEIBULL_SHAPE - 1
                )
                failure_risk_7d = clamp(
                    1 - math.exp(-hazard * 168 * (1 + past_failures * 0.035)),
                    0.004,
                    0.92,
                )
                expected_downtime_h = 6 + rng() * 26 if failure_risk_7d > 0.3 else failure_risk_7d * 90
                availability_30d = clamp(0.97 - failure_risk_7d * 0.24 - rng() * 0.045, 0.55, 0.995)
                utilisation_30d = clamp(availability_30d * (0.72 + rng() * 0.22), 0.4, 0.97)
                health = (
                    "critical"
                    if failure_risk_7d > 0.45
                    else ("at-risk" if failure_risk_7d > 0.22 else ("watch" if failure_risk_7d > 0.1 else "healthy"))
                )
                out.append(
                    {
                        "equipId": f"{mine['code']}-{f['type'].upper()[:3]}-{seq:03d}",
                        "type": f["type"],
                        "mineId": mine["id"],
                        "ratedTph": _round_to(f["tph"][0] + rng() * (f["tph"][1] - f["tph"][0]), 1),
                        "commissioned": f"{2019 + math.floor(rng() * 6)}-0{1 + math.floor(rng() * 9)}-01",
                        "hoursSinceService": math.floor(hours_since_service + 0.5),
                        "ageYears": _round_to(age, 1),
                        "pastFailures": past_failures,
                        "failureRisk7d": _round_to(failure_risk_7d, 3),
                        "expectedDowntimeH": _round_to(expected_downtime_h, 1),
                        "availability30d": _round_to(availability_30d, 3),
                        "utilisation30d": _round_to(utilisation_30d, 3),
                        "health": health,
                        "odometerH": math.floor(1400 + age * 1900 + rng() * 900 + 0.5),
                        # The last unit in each class is a standby, not
                        # production capacity.
                        "spareUnits": 1 if i >= f["count"] - 1 else 0,
                    }
                )
                seq += 1
    return out


FLEET: List[Equipment] = build_equipment()


# Delay model. Weather dominates and is driven by the day's rainfall, but the
# baseline reasons are always present. Probabilities are per blast.
BLAST_DELAY_P: Dict[str, float] = {
    "clearance": 0.052,
    "misfire": 0.028,
    "explosive_supply": 0.021,
    "other": 0.017,
    # Baseline plus weather, scaled by how wet the day is.
    "weatherBase": 0.035,
    "weatherWet": 0.42,
}


def build_blasts() -> List[BlastLog]:
    rng = make_rng(778899)
    out: List[BlastLog] = []
    for mine in MINES:
        n = 1
        for d in range(BLAST_LOG_DAYS, -1, -1):
            date = add_days(NOW, -d)
            w = weather_on(mine["id"], iso_date(date))
            blasts_per_day = 1 + (1 if rng() > 0.45 else 0)
            for b in range(blasts_per_day):
                planned_ts = date.replace(hour=13 + b * 4, minute=0, second=0, microsecond=0)
                delay_reason: Optional[str] = None
                delay_min = 0
                wet = clamp((w["rainMm"] - 10) / 55, 0, 1)
                p = rng()
                th_weather = BLAST_DELAY_P["weatherBase"] + BLAST_DELAY_P["weatherWet"] * wet
                cum = th_weather
                if p < cum:
                    delay_reason = "weather"
                    delay_min = 90 + math.floor(rng() * 420)
                else:
                    cum += BLAST_DELAY_P["clearance"]
                    if cum > p:
                        delay_reason = "clearance"
                        delay_min = 25 + math.floor(rng() * 130)
                    else:
                        cum += BLAST_DELAY_P["misfire"]
                        if cum > p:
                            delay_reason = "misfire"
                            delay_min = 60 + math.floor(rng() * 210)
                        else:
                            cum += BLAST_DELAY_P["explosive_supply"]
                            if cum > p:
                                delay_reason = "explosive_supply"
                                delay_min = 40 + math.floor(rng() * 160)
                            else:
                                cum += BLAST_DELAY_P["other"]
                                if cum > p:
                                    delay_reason = "other"
                                    delay_min = 20 + math.floor(rng() * 70)
                holes = 28 + math.floor(rng() * 44)
                powder_factor = 0.29 + rng() * 0.19
                # Kuz-Ram style fragmentation: finer with higher powder factor.
                p80 = clamp(148 - powder_factor * 260 + (rng() - 0.5) * 44, 42, 190)
                actual_ts = planned_ts + timedelta(minutes=delay_min)
                out.append(
                    {
                        "blastId": f"{mine['code']}-B{n:04d}",
                        "faceId": f"{mine['code']}-F{((n % 17) + 1):02d}",
                        "mineId": mine["id"],
                        "plannedTs": _iso_ts(planned_ts),
                        "actualTs": _iso_ts(actual_ts),
                        "delayMin": delay_min,
                        "delayReason": delay_reason,
                        "holes": holes,
                        "explosiveKg": math.floor(holes * 11.5 * (0.85 + rng() * 0.3) + 0.5),
                        "powderFactor": _round_to(powder_factor, 3),
                        "p80FragMm": _round_to(p80, 1),
                    }
                )
                n += 1
    return out


BLASTS: List[BlastLog] = build_blasts()

# ── Aggregations ────────────────────────────────────────────────────────


def fleet_for(mine_id: str) -> List[Equipment]:
    rows = [e for e in FLEET if e["mineId"] == mine_id]
    rows.sort(key=lambda e: e["failureRisk7d"], reverse=True)
    return rows


def blast_stats(mine_id: str, days: int = 90) -> Dict[str, Any]:
    from_date = add_days(NOW, -days)
    blast_list = [
        b
        for b in BLASTS
        if b["mineId"] == mine_id and datetime.fromisoformat(b["actualTs"]) >= from_date
    ]
    delayed = [b for b in blast_list if b["delayMin"] > 0]
    by_reason: Dict[str, float] = {}
    for b in delayed:
        k = b["delayReason"] if b["delayReason"] is not None else "other"
        by_reason[k] = by_reason.get(k, 0) + b["delayMin"]
    adherence = (1 - len(delayed) / len(blast_list)) if blast_list else 1
    total_delay_min = 0
    for b in delayed:
        total_delay_min += b["delayMin"]
    by_reason_rows = [
        {"reason": reason, "minutes": minutes, "hours": minutes / 60}
        for reason, minutes in by_reason.items()
    ]
    by_reason_rows.sort(key=lambda row: row["minutes"], reverse=True)
    return {
        "count": len(blast_list),
        "onTime": len(blast_list) - len(delayed),
        "adherence": adherence,
        "meanDelayMin": (total_delay_min / len(delayed)) if delayed else 0,
        "totalDelayH": total_delay_min / 60,
        "byReason": by_reason_rows,
        "meanP80": (sum(b["p80FragMm"] for b in blast_list) / len(blast_list)) if blast_list else 0,
        "meanPowderFactor": (sum(b["powderFactor"] for b in blast_list) / len(blast_list))
        if blast_list
        else 0,
    }


def rate_limits_for(mine_id: str) -> StageRates:
    return stage_rates(mine_id)
