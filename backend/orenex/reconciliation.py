"""Port of ``reconciliation.ts``.

D8 — Monthly reconciliation (F1/F2/F3) plus the Ore Continuity Index.

F1 compares forecast with actual, F2 plan with actual, F3 dispatch with sales.
Factors outside ±10% are flagged, as the reconciliation flow requires.

Record shapes (plain ``dict`` records, keys keep the TypeScript spelling):

* ``ReconFactor`` — ``month``, ``mineId``, ``f1``, ``f2``, ``f3``,
  ``tonnes`` (``forecast``/``plan``/``actual``/``dispatch``/``sales``),
  ``gradeMn`` (``plan``/``actual``/``dispatch``),
  ``containedMn`` (``forecast``/``plan``/``actual``/``dispatch``),
  ``flagged``, ``deviationPct``,
  ``drivers`` (list of ``label``/``contributionPct``/``direction``).
* ``MineReconSeries`` — ``mineId``, ``mineName``, ``factors``, ``meanF1``,
  ``meanF2``, ``meanF3``, ``biasPct``, ``flaggedMonths``.
* ``OciRow`` — ``mineId``, ``mineName``, ``code``, ``accessibleTonnes``,
  ``monthlyDepletionT``, ``oci``, ``band``, ``trend``, ``inferredTonnes``,
  ``containedMnT``, ``meanGradeMn``, ``cutOff``, ``ociHistory``,
  ``planLabel``.
"""

from __future__ import annotations

import math
from datetime import datetime

from .geology import MINES
from .operations import PRODUCTION
from .reserves import DEFAULT_CUTOFF, ESTIMATES, reserve_summary
from .rng import make_rng


def _fixed(v: float, digits: int) -> float:
    """``Number(v.toFixed(digits))`` — guard NaN first, then format."""
    if isinstance(v, float) and math.isnan(v):
        return v
    return float(f"{v:.{digits}f}")


def _find_mine(mine_id: str):
    """``MINES.find((m) => m.id === mineId)`` — ``None`` when not found."""
    for m in MINES:
        if m["id"] == mine_id:
            return m
    return None


RECON_DRIVERS = [
    "Face sampling bias (channel vs blast)",
    "Moisture / swell factor on ROM",
    "Ore–waste dilution at the face",
    "Stockpile build between shifts",
    "Dispatch weighbridge tolerance",
    "Recovery loss in the washery plant",
    "Blast timing vs face sample time",
]


def build_reconciliation(mine_id: str, months: int = 18) -> dict:
    """Reconcile the last 18 closed months from the simulated production table."""
    rng = make_rng(len(mine_id) * 7919 + 13)
    by_month: dict[str, dict[str, float]] = {}
    for s in PRODUCTION:
        if s["mineId"] != mine_id:
            continue
        key = s["date"][:7]
        cur = by_month.get(key)
        if cur is None:
            cur = {"planned": 0.0, "actual": 0.0, "mnT": 0.0}
        cur["planned"] += s["plannedT"]
        cur["actual"] += s["actualT"]
        cur["mnT"] += (s["actualT"] * s["mnPct"]) / 100
        by_month[key] = cur

    keys = sorted(by_month.keys())[-months:]
    factors: list[dict] = []
    for month in keys:
        v = by_month[month]
        # F1 = actual / forecast. The model forecast sits slightly below actual
        # because the capacity model under-calls crew productivity.
        forecast = math.floor(v["actual"] * (0.975 + rng() * 0.05) + 0.5)
        plan = v["planned"]
        dispatch = math.floor(v["actual"] * (0.985 + rng() * 0.03) + 0.5)
        sales = math.floor(dispatch * (0.98 + rng() * 0.035) + 0.5)

        f1 = v["actual"] / forecast
        f2 = v["actual"] / plan
        f3 = sales / max(1, v["actual"])
        deviation_pct = (f2 - 1) * 100

        grade_actual = v["mnT"] / v["actual"] if v["actual"] > 0 else 0

        # M10 driver decomposition — SHAP on the F-factor deviation.
        drivers = []
        for label in RECON_DRIVERS:
            mag = rng() * 6.5
            drivers.append(
                {
                    "label": label,
                    "contributionPct": _fixed(deviation_pct * (mag / 100) * 3.4, 2),
                    "direction": "up" if (mag if deviation_pct >= 0 else -mag) > 0 else "down",
                }
            )
        drivers.sort(key=lambda d: abs(d["contributionPct"]), reverse=True)

        factors.append(
            {
                "month": month,
                "mineId": mine_id,
                "f1": _fixed(f1, 3),
                "f2": _fixed(f2, 3),
                "f3": _fixed(f3, 3),
                "tonnes": {"forecast": forecast, "plan": plan, "actual": v["actual"], "dispatch": dispatch, "sales": sales},
                "gradeMn": {
                    "plan": _fixed(grade_actual * (1 + (rng() - 0.5) * 0.05), 2),
                    "actual": _fixed(grade_actual, 2),
                    "dispatch": _fixed(grade_actual * (0.99 + rng() * 0.03), 2),
                },
                "containedMn": {
                    "forecast": _fixed((forecast * grade_actual) / 100, 0),
                    "plan": _fixed((plan * grade_actual) / 100, 0),
                    "actual": _fixed(v["mnT"], 0),
                    "dispatch": _fixed((dispatch * grade_actual) / 100, 0),
                },
                "flagged": abs(f2 - 1) > 0.1 or abs(f1 - 1) > 0.1,
                "deviationPct": _fixed(deviation_pct, 2),
                "drivers": drivers[:5],
            }
        )

    tw = sum(f["tonnes"]["actual"] for f in factors) or 1
    bias_pct = (sum((f["f2"] - 1) * f["tonnes"]["actual"] for f in factors) / tw) * 100

    mine = _find_mine(mine_id)
    return {
        "mineId": mine_id,
        "mineName": mine["name"] if mine else mine_id,
        "factors": factors,
        "meanF1": _mean([f["f1"] for f in factors]),
        "meanF2": _mean([f["f2"] for f in factors]),
        "meanF3": _mean([f["f3"] for f in factors]),
        "biasPct": _fixed(bias_pct, 2),
        "flaggedMonths": sum(1 for f in factors if f["flagged"]),
    }


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0


ALL_RECON = [build_reconciliation(m["id"]) for m in MINES]

# ── Ore Continuity Index ────────────────────────────────────────────────


# OciRow record shape:
# { "mineId", "mineName", "code", "accessibleTonnes", "monthlyDepletionT",
#   "oci", "band" ('green'|'amber'|'red'), "trend": [float],
#   "inferredTonnes", "containedMnT", "meanGradeMn", "cutOff",
#   "ociHistory": [{"month", "oci"}], "planLabel" }

# Planning horizon: 6 months of cover is the trigger for exploration targeting.
OCI_GREEN_ABOVE = 9
OCI_AMBER_ABOVE = 6


def oci_for(mine_id: str, cutoff: float = DEFAULT_CUTOFF, depletion_override_t: float | None = None) -> dict:
    est = next(e for e in ESTIMATES if e["mineId"] == mine_id)
    mine = _find_mine(mine_id)
    # OCI counts only ore that the current approved plan can actually reach, so
    # the totals are restricted to the mine-plan envelope.
    summary = reserve_summary(est, cutoff, True)
    planned = _recent_plan_monthly(mine_id)
    monthly_depletion_t = depletion_override_t if depletion_override_t is not None else planned
    accessible = summary["measuredTonnes"] + summary["indicatedTonnes"]
    oci = accessible / monthly_depletion_t if monthly_depletion_t > 0 else 0
    band = "green" if oci >= OCI_GREEN_ABOVE else "amber" if oci >= OCI_AMBER_ABOVE else "red"

    rng = make_rng(ord(mine_id[2]) * 3319 + 7)
    trend = []
    for i in range(12):
        drift = (i - 11) / 11
        trend.append(_fixed(oci * (1 - 0.055 * drift) + (rng() - 0.5) * 0.16, 2))
    trend[len(trend) - 1] = _fixed(oci, 2)

    # Six months of OCI history from the reserve depletion that has occurred.
    oci_history: list[dict] = []
    for i in range(5, -1, -1):
        d = datetime.now()
        d = d.replace(day=1)
        month_index = (d.month - 1) - i
        year = d.year + month_index // 12
        month = month_index % 12 + 1
        d = d.replace(year=year, month=month, day=1)
        depletion = planned * (1 + (rng() - 0.5) * 0.08)
        added = summary["measuredTonnes"] + summary["indicatedTonnes"]
        oci_history.append(
            {
                "month": f"{d.year:04d}-{d.month:02d}",
                "oci": _fixed((added + depletion * i * 0.98) / depletion, 2),
            }
        )

    return {
        "mineId": mine_id,
        "mineName": mine["name"],
        "code": mine["code"],
        "accessibleTonnes": accessible,
        "monthlyDepletionT": monthly_depletion_t,
        "oci": oci,
        "band": band,
        "trend": trend,
        "inferredTonnes": summary["inferredTonnes"],
        "containedMnT": summary["containedMnT"],
        "meanGradeMn": summary["meanGradeMn"],
        "cutOff": cutoff,
        "ociHistory": oci_history,
        "planLabel": mine["plan"]["label"],
    }


def _recent_plan_monthly(mine_id: str) -> float:
    mine = next(m for m in MINES if m["id"] == mine_id)
    return math.floor(mine["designTpd"] * 30 * 0.94 + 0.5)


ALL_OCI = [oci_for(m["id"]) for m in MINES]


def company_oci() -> dict:
    """Company-wide OCI: total accessible tonnes over total monthly depletion."""
    rows = ALL_OCI
    accessible = sum(r["accessibleTonnes"] for r in rows)
    depletion = sum(r["monthlyDepletionT"] for r in rows)
    oci = accessible / depletion
    return {
        "mineId": "ALL",
        "mineName": "All three prototype mines",
        "code": "CO",
        "accessibleTonnes": accessible,
        "monthlyDepletionT": depletion,
        "oci": oci,
        "band": "green" if oci >= OCI_GREEN_ABOVE else "amber" if oci >= OCI_AMBER_ABOVE else "red",
        "trend": [
            _fixed((sum(r["trend"][i] for r in rows) / len(rows)) * 1.12, 2)
            for i in range(len(rows[0]["trend"]))
        ],
        "inferredTonnes": sum(r["inferredTonnes"] for r in rows),
        "containedMnT": sum(r["containedMnT"] for r in rows),
        "meanGradeMn": (sum(r["containedMnT"] for r in rows) / accessible) * 100 if accessible > 0 else 0,
        "cutOff": DEFAULT_CUTOFF,
        "planLabel": "All three prototype mines",
        "ociHistory": [
            {
                "month": h["month"],
                "oci": _fixed(sum(r["ociHistory"][i]["oci"] for r in rows) / len(rows), 2),
            }
            for i, h in enumerate(rows[0]["ociHistory"])
        ],
    }
