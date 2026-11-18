"""High-level facade over the ported ORENEX engine.

The individual ``orenex.*`` modules mirror the frontend's ``src/core/*.ts`` files
one-for-one. This module aggregates them into a small set of **JSON-ready**
functions that the HTTP API (and the smoke test) call.

Heavy modules (``reserves``, ``prospectivity``, ``operations``, ``models``) build
large synthetic datasets at import time — tens of seconds — so they are imported
*lazily* inside each function. That keeps ``orenex.engine`` (and ``/health``)
instant, and pays the build cost only on the first request that needs it.
"""

from __future__ import annotations

from array import array
from typing import Any

from .clock import now_iso

ENGINE_VERSION = "1.0.0"


def to_jsonable(obj: Any) -> Any:
    """Recursively convert engine output into strict JSON primitives.

    * ``array.array`` → ``list`` (the frontend uses typed arrays; JSON has none)
    * callables (e.g. a calibrator's ``apply``) → dropped
    * ``NaN`` / ``±Infinity`` → ``None`` (not valid JSON)
    * ``dict`` keys → coerced to ``str``
    """
    if obj is None or isinstance(obj, (bool, str, int)):
        return obj
    if isinstance(obj, float):
        if obj != obj or obj in (float("inf"), float("-inf")):
            return None
        return obj
    if isinstance(obj, array):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v) for k, v in obj.items() if not callable(v)}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    if callable(obj):
        return None
    return str(obj)


# ── Meta ────────────────────────────────────────────────────────────────

def endpoints() -> list[dict]:
    """Service index — also served at ``GET /``."""
    return [
        {"method": "GET", "path": "/health", "description": "liveness + engine version"},
        {"method": "GET", "path": "/overview", "description": "belt mines, unit/structure/occurrence/target counts, terrain bounds"},
        {"method": "GET", "path": "/geology", "description": "units, structures, belt mines and occurrences"},
        {"method": "GET", "path": "/geology/terrain?step=4", "description": "downsampled DEM grid"},
        {"method": "GET", "path": "/prospectivity", "description": "mineral prospectivity model: features, weights, calibration, targets"},
        {"method": "GET", "path": "/prospectivity/grid?step=4", "description": "downsampled calibrated probability + depth grid"},
        {"method": "GET", "path": "/targets", "description": "ranked drill targets"},
        {"method": "GET", "path": "/reserves", "description": "resource/reserve summaries per mine"},
        {"method": "GET", "path": "/operations", "description": "fleet, production and blasting summary"},
        {"method": "GET", "path": "/forecast?mine=MNE-BAL", "description": "30-day production shortfall forecast for a mine"},
        {"method": "GET", "path": "/alerts", "description": "ranked shortfall alerts across the belt"},
        {"method": "GET", "path": "/backtest?mine=MNE-BAL", "description": "forecast backtest for a mine"},
        {"method": "GET", "path": "/backtest/portfolio", "description": "tonnage-weighted portfolio backtest"},
        {"method": "GET", "path": "/reconciliation", "description": "grade/tonnage reconciliation + ore coverage index"},
        {"method": "GET", "path": "/validation", "description": "validation suite (block CV, ablation, calibration)"},
        {"method": "GET", "path": "/models", "description": "model registry, data sources, audit trail, flows"},
        {"method": "GET", "path": "/manganese", "description": "India top-50 manganese mine dataset + aggregate stats"},
        {"method": "GET", "path": "/manganese/model", "description": "trained manganese grade/premium model + metrics"},
        {"method": "POST", "path": "/assistant", "description": "ask a question — body {\"q\": str, \"mineId\"?, \"targetId\"?}"},
    ]


def health() -> dict:
    return {
        "status": "ok",
        "engine": "orenex-python",
        "version": ENGINE_VERSION,
        "generatedAt": now_iso(),
    }


# ── Geology ─────────────────────────────────────────────────────────────

def _belt_mines() -> list[dict]:
    from . import geology

    return [
        {
            "id": m["id"],
            "code": m.get("code"),
            "name": m["name"],
            "x": m["x"],
            "y": m["y"],
            "designTpd": m.get("designTpd"),
            "planLabel": (m.get("plan") or {}).get("label"),
        }
        for m in geology.MINES
    ]


def overview() -> dict:
    from . import geology, prospectivity

    t = geology.TERRAIN
    return {
        "mines": _belt_mines(),
        "unitCount": len(geology.GEO_UNITS),
        "structureCount": len(geology.STRUCTURES),
        "occurrenceCount": len(geology.OCCURRENCES),
        "targetCount": len(prospectivity.TARGETS),
        "terrain": {
            "nx": t["nx"],
            "ny": t["ny"],
            "minZ": t["minZ"],
            "maxZ": t["maxZ"],
            "cellWidthM": t.get("cellWidthM"),
            "cellHeightM": t.get("cellHeightM"),
        },
    }


def geology_layer() -> dict:
    from . import geology

    return {
        "mines": geology.MINES,
        "units": geology.GEO_UNITS,
        "structures": geology.STRUCTURES,
        "occurrences": geology.OCCURRENCES,
    }


def terrain_grid(step: int = 4) -> dict:
    from . import geology

    t = geology.TERRAIN
    nx, ny, dem = t["nx"], t["ny"], t["dem"]
    step = max(1, int(step))
    rows = [[round(dem[j * nx + i], 1) for i in range(0, nx, step)] for j in range(0, ny, step)]
    return {
        "nx": nx,
        "ny": ny,
        "step": step,
        "width": len(rows[0]) if rows else 0,
        "height": len(rows),
        "minZ": t["minZ"],
        "maxZ": t["maxZ"],
        "dem": rows,
    }


# ── Prospectivity ───────────────────────────────────────────────────────

def prospectivity_summary() -> dict:
    from . import geology, prospectivity as P

    p = P.PROSPECTIVITY
    return {
        "nx": p["nx"],
        "ny": p["ny"],
        "cellSizeM": p["cellSizeM"],
        "featureCount": len(P.FEATURES),
        "features": P.FEATURES,
        "stats": P.STATS,
        "bias": P.BIAS,
        "fit": to_jsonable(p["fit"]),
        "calibration": to_jsonable(p["calibrator"]),
        "calibrationStrata": P.CAL_STRATA,
        "targetCount": len(P.TARGETS),
        "targets": P.TARGETS,
        "occurrenceCount": len(geology.OCCURRENCES),
    }


def prospectivity_grid(step: int = 4) -> dict:
    from . import prospectivity as P

    p = P.PROSPECTIVITY
    nx, ny = p["nx"], p["ny"]
    prob, depth = p["prob"], p["depth"]
    step = max(1, int(step))
    cells = []
    for j in range(0, ny, step):
        for i in range(0, nx, step):
            k = j * nx + i
            cells.append({"i": i, "j": j, "p": round(prob[k], 4), "depthM": round(depth[k], 1)})
    return {"nx": nx, "ny": ny, "step": step, "cells": cells}


def targets() -> dict:
    from . import prospectivity as P

    return {"targets": P.TARGETS}


# ── Reserves / operations ───────────────────────────────────────────────

def reserves_all() -> dict:
    from . import reserves

    return {"mines": [reserves.reserve_summary(est) for est in reserves.ESTIMATES]}


def operations_summary() -> dict:
    from . import geology, operations

    prod = operations.PRODUCTION
    by_mine = []
    for m in geology.MINES:
        shifts = [s for s in prod if s["mineId"] == m["id"]]
        actual = sum(s["actualT"] for s in shifts)
        plan = sum(s["plannedT"] for s in shifts)
        lost = sum(s["lostT"] for s in shifts)
        by_mine.append(
            {
                "mineId": m["id"],
                "mineName": m["name"],
                "shifts": len(shifts),
                "actualT": round(actual, 1),
                "planT": round(plan, 1),
                "lostT": round(lost, 1),
                "attainmentPct": round((actual / plan) * 100, 1) if plan else 0,
            }
        )
    return {
        "fleetCount": len(operations.FLEET),
        "productionShifts": len(prod),
        "blastLogs": len(operations.BLASTS),
        "weatherDays": len(operations.WEATHER),
        "byMine": by_mine,
    }


# ── Forecast / backtest ─────────────────────────────────────────────────

def forecast_mine(mine_id: str, horizon: int = 30) -> dict:
    from . import forecast

    return forecast.forecast_mine(mine_id, horizon=horizon)


def alerts() -> dict:
    from . import forecast

    return {"alerts": forecast.build_alerts()}


def backtest_mine(mine_id: str) -> dict:
    from . import backtest

    return backtest.forecast_backtest(mine_id)


def backtest_portfolio() -> dict:
    from . import backtest

    return backtest.portfolio_backtest()


# ── Reconciliation / validation ─────────────────────────────────────────

def reconciliation_summary() -> dict:
    from . import reconciliation

    return {
        "mines": reconciliation.ALL_RECON,
        "oci": reconciliation.ALL_OCI,
        "company": reconciliation.company_oci(),
    }


def validation_summary() -> dict:
    from . import validation

    return validation.validation()


# ── Model registry / national manganese AI ──────────────────────────────

def model_registry() -> dict:
    from . import models

    return {
        "models": models.MODELS,
        "sources": models.SOURCES,
        "audit": models.AUDIT,
        "flows": models.FLOWS,
    }


def manganese() -> dict:
    from . import manganese_india

    return {"stats": manganese_india.MANGANESE_STATS, "mines": manganese_india.MANGANESE_MINES}


def manganese_model() -> dict:
    from . import manganese_model as M

    return M.MANGANESE_TRAINING


# ── Assistant ───────────────────────────────────────────────────────────

def default_context() -> dict:
    from . import reserves

    return {"targetId": None, "mineId": None, "estimate": None, "cutOff": reserves.DEFAULT_CUTOFF}


def assistant_ask(question: str, context: dict | None = None) -> dict:
    from . import assistant

    ctx = default_context()
    if context:
        ctx.update(context)
    return assistant.ask(question, ctx)


def assistant_suggestions() -> dict:
    from . import assistant

    return {
        "suggested": getattr(assistant, "SUGGESTED_QUESTIONS", []),
        "intents": getattr(assistant, "EXPLAIN_INTENTS", []),
    }
