"""Port of ``stageModel.ts``.

Stage capacity model (D6, 2A/2C).

A mine produces no more than its slowest stage, so the capacity of the mine on
a given day is ``min(drill, blast, muck, haul, hoist)``. Every one of those is
``units x rated t/h x utilisation x shift hours``, derated by two independent
multipliers — the ground condition and the machines available at that stage.

This lives in its own module rather than inside ``forecast`` because the
backtest has to evaluate the *same* physics over history.

Record shapes (dicts, keys in the exact TypeScript spelling):

* ``StageRow``     — stage, label, capacityT, capacityShiftT, units, ratedTph,
  utilisation, groundFactor, availableFraction, availableUnits, isBottleneck,
  lossT.
* ``StageContext`` — unitDelta (Stage -> number), utilDelta, serviced,
  blastPull, ignoreWeather (optional).
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

from .noise import clamp
from .operations import (
    SHIFTS_PER_DAY,
    SHIFT_HOURS,
    STAGES,
    STAGE_LABEL,
    Equipment,
    Stage,
    WeatherDay,
    fleet_for,
    nominal_stage_capacity,
    rate_limits_for,
    stage_ground_factor,
)

# Machine class that carries each stage. Blasting has no machine — it is a crew.
STAGE_PRIMARY: Dict[Stage, Optional[str]] = {
    "drill": "drill",
    "blast": None,
    "muck": "LHD",
    "haul": "dumper",
    "hoist": "hoist",
}

# Blast crews lose roughly one shift in twenty to clearance and supply.
BLAST_CREW_UNAVAILABILITY = 0.048


def stage_equipment(mine_id: str, stage: Stage) -> List[Equipment]:
    """Equipment at a stage, mapped to the machines actually in its cycle."""
    type_ = STAGE_PRIMARY[stage]
    if not type_:
        return []
    return [e for e in fleet_for(mine_id) if e["type"] == type_]


def stage_availability_loss(
    mine_id: str, stage: Stage, stage_units: float, serviced: List[str]
) -> float:
    """Fraction of a stage's nominal capacity lost to equipment unavailability.

    Scaled by the stage's unit count, not summed over the whole mine: a mine
    with eleven dumpers is not twice as exposed as one with six, it has twice
    the redundancy. Machines brought in by an override dilute the loss, as real
    redeployment does.
    """
    eq = stage_equipment(mine_id, stage)
    if not eq or stage_units <= 0:
        return BLAST_CREW_UNAVAILABILITY if stage == "blast" else 0
    expected_out = 0.0
    for e in eq:
        risk = 0.004 if e["equipId"] in serviced else e["failureRisk7d"]
        # A failure inside the window does not cost the whole window; mean time
        # to failure within it is about half of it.
        expected_out += risk * 0.5
    # Losses are shared across the stage's units: with more units than machines
    # on hand, a single failure is absorbed by the float.
    per_unit_loss = expected_out / max(1, len(eq))
    spread = clamp(stage_units / max(1, len(eq)), 0.55, 1)
    return clamp(per_unit_loss * spread * 1.25, 0, 0.45)


# Shape documented in the module docstring.
StageRow = Dict[str, Any]

# Shape documented in the module docstring.
StageContext = Dict[str, Any]


def empty_stage_context() -> StageContext:
    return {
        "unitDelta": {"drill": 0, "blast": 0, "muck": 0, "haul": 0, "hoist": 0},
        "utilDelta": 0,
        "serviced": [],
        "blastPull": 0,
    }


def stage_rows_for(
    mine_id: str, w: WeatherDay, ctx: Optional[StageContext] = None
) -> List[StageRow]:
    """Capacity of each stage on one day, and the derates that produced it.

    ``nominal_stage_capacity`` is quoted per shift, so the day figure is that
    times three shifts.
    """
    if ctx is None:
        ctx = empty_stage_context()
    rates = rate_limits_for(mine_id)
    rows: List[StageRow] = []
    for stage in STAGES:
        nominal_units = rates["units"][stage] + ctx["unitDelta"][stage]
        base = nominal_stage_capacity(stage, rates, ctx["unitDelta"][stage], ctx["utilDelta"])
        ground = (
            1
            if ctx.get("ignoreWeather")
            else stage_ground_factor(stage, w["rainMm"], w["soilMoisture"], w["lstC"])
        )

        # Availability is a stage property derived from the machines that carry
        # it. Drilling is limited by rig availability, blasting by the crew,
        # hoisting by shaft capacity — only the first and last are machine-led.
        availability_loss = stage_availability_loss(mine_id, stage, nominal_units, ctx["serviced"])
        available_fraction = clamp(1 - availability_loss, 0.45, 1)

        capacity = base * ground * available_fraction

        # Blast windows: pulling rounds into a dry day raises that day's capacity.
        blast_dry_boost = (
            0.06 * ctx["blastPull"] * (1 - clamp(w["rainMm"] / 20, 0, 1)) if stage == "blast" else 0
        )
        adjusted = capacity * (1 + blast_dry_boost) if stage == "blast" else capacity

        rows.append(
            {
                "stage": stage,
                "label": STAGE_LABEL[stage],
                "capacityT": max(0, math.floor(adjusted * SHIFTS_PER_DAY + 0.5)),
                "capacityShiftT": max(0, math.floor(adjusted + 0.5)),
                "units": nominal_units,
                "ratedTph": rates["ratedTph"][stage],
                "utilisation": clamp(rates["utilisation"][stage] + ctx["utilDelta"], 0.3, 0.98),
                "groundFactor": ground,
                "availableFraction": available_fraction,
                "availableUnits": math.floor(nominal_units * available_fraction * 10 + 0.5) / 10,
                "isBottleneck": False,
                "lossT": max(0, math.floor((base - adjusted) * SHIFTS_PER_DAY + 0.5)),
            }
        )
    return rows


def mark_bottleneck(rows: List[StageRow]) -> Stage:
    """Mark the slowest stage. Ties go to the first stage in the chain."""
    best = 0
    for i in range(1, len(rows)):
        if rows[i]["capacityT"] < rows[best]["capacityT"]:
            best = i
    for i, r in enumerate(rows):
        r["isBottleneck"] = i == best
    return rows[best]["stage"]


def mine_capacity_t(rows: List[StageRow]) -> float:
    """Daily capacity of the mine: its slowest stage, tonnes for the whole day."""
    m = math.inf
    for r in rows:
        m = min(m, r["capacityT"])
    return m


def nominal_day_capacity(r: StageRow) -> float:
    """Unconstrained capacity of a stage in tonnes/day, ignoring both derates."""
    return r["units"] * r["ratedTph"] * r["utilisation"] * SHIFT_HOURS * SHIFTS_PER_DAY
