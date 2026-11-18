"""Port of ``manganeseModel.ts``.

Trained national manganese models (M6).

Two models are fitted on ``manganese_india.py`` at module load, entirely in the
browser, using the generalised-linear trainer in ``trainer.py``:

  - M6-A  Grade regressor      — predicts ROM grade % Mn from capacity, reserve,
                                  age, depth, phosphorus, mining method and
                                  geographic/ore-type dummies.
  - M6-B  Premium-grade classifier — P(ROM grade ≥ threshold), the flag a
                                  marketing desk actually trades on.

Reported quality is 5-fold cross-validated (out-of-fold), not train-set. With
only 50 rows the honest expectation is a modest R² — the screen says so — but
the fit, the folds and the metrics are real, and the loss curves are the ones
gradient descent actually produced.

Record shapes::

    DesignMatrix      = {"X": list[list[float]], "featureNames": list[str],
                         "grades": list[float], "high": list[int]}
    MinePrediction    = {"mineId": str, "name": str, "state": str,
                         "operator": str, "miningMethod": str,
                         "capacityKt": float, "actualGrade": float,
                         "cvPredictedGrade": float, "fittedGrade": float,
                         "residual": float, "highProb": float,
                         "actualHigh": bool}
    RegressionHead    = {"task": str, "algorithm": str,
                         "metrics": RegressionMetrics,
                         "trainMetrics": RegressionMetrics,
                         "loss": list[float],
                         "coefficients": list[dict]}
    ClassificationHead= {"task": str, "algorithm": str,
                         "metrics": ClassificationMetrics,
                         "trainMetrics": ClassificationMetrics,
                         "loss": list[float],
                         "coefficients": list[dict]}
    ManganeseTraining = {"modelId": str, "version": str, "trainedAt": str,
                         "seed": int, "rows": int, "features": list[str],
                         "gradeThreshold": float, "config": TrainConfig,
                         "regression": RegressionHead,
                         "classification": ClassificationHead,
                         "predictions": list[MinePrediction]}
"""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List

from .manganese_india import MANGANESE_MINES, OreType
from .clock import now_iso
from .trainer import (
    DEFAULT_TRAIN,
    TrainConfig,
    fit_standardizer,
    apply_standardizer,
    train_ridge,
    train_logistic,
    predict_linear,
    predict_proba,
    regression_metrics,
    classification_metrics,
    k_fold,
    rank_coefficients,
    thin_curve,
    RegressionMetrics,
    ClassificationMetrics,
)

# ROM grade at or above which ore is classed premium/medium-high.
GRADE_THRESHOLD = 28

ORE_TYPES: List[OreType] = ["gondite", "kodurite", "lateritic", "mixed", "sedimentary"]


def state_list() -> List[str]:
    return sorted(dict.fromkeys(m["state"] for m in MANGANESE_MINES))


DesignMatrix = Dict[str, Any]


def feature_names_for(states: List[str]) -> List[str]:
    names: List[str] = [
        "log_capacity", "log_reserve", "age_years", "depth_m", "phosphorus_pct", "underground",
    ]
    for t in ORE_TYPES[1:]:
        names.append(f"ore_{t}")
    for s in states[1:]:
        names.append(f"state_{re.sub(r'\s+', '_', s).lower()}")
    return names


def feature_row(m: Dict[str, Any], states: List[str]) -> List[float]:
    """One design row. Shared by training and by the deployed predictor."""
    row: List[float] = [
        math.log(max(1e-6, m["capacityKt"])),
        math.log(max(1e-6, m["reserveMt"])),
        2026 - m["commissioned"],
        m["depthM"],
        m["phosphorusP"] * 100,
        1 if m["miningMethod"] == "underground" else 0,
    ]
    for t in ORE_TYPES[1:]:
        row.append(1 if m["oreType"] == t else 0)
    for s in states[1:]:
        row.append(1 if m["state"] == s else 0)
    return row


def build_design() -> DesignMatrix:
    states = state_list()
    X = [feature_row(m, states) for m in MANGANESE_MINES]

    return {
        "X": X,
        "featureNames": feature_names_for(states),
        "grades": [m["gradeMn"] for m in MANGANESE_MINES],
        "high": [1 if m["gradeMn"] >= GRADE_THRESHOLD else 0 for m in MANGANESE_MINES],
    }


MinePrediction = Dict[str, Any]
RegressionHead = Dict[str, Any]
ClassificationHead = Dict[str, Any]
ManganeseTraining = Dict[str, Any]


def train_manganese_model(
    seed: int = 2601,
    config: TrainConfig = DEFAULT_TRAIN,
) -> ManganeseTraining:
    design = build_design()
    X = design["X"]
    feature_names = design["featureNames"]
    grades = design["grades"]
    high = design["high"]
    n = len(X)
    folds = k_fold(n, 5, seed)

    # Out-of-fold predictions: each mine is scored by a model that never saw it.
    oof_grade = [0.0] * n
    oof_prob = [0.0] * n
    for test_idx in folds:
        test_set = set(test_idx)
        train_idx = [i for i in range(n) if i not in test_set]
        std = fit_standardizer([X[i] for i in train_idx])
        std_train = apply_standardizer([X[i] for i in train_idx], std)
        std_test = apply_standardizer([X[i] for i in test_idx], std)

        reg_model = train_ridge(std_train, [grades[i] for i in train_idx], feature_names, config)[0]
        clf_model = train_logistic(std_train, [high[i] for i in train_idx], feature_names, config)[0]
        for k, idx in enumerate(test_idx):
            oof_grade[idx] = predict_linear(reg_model, std_test[k])
            oof_prob[idx] = predict_proba(clf_model, std_test[k])

    # Full-data fit for the deployed coefficients and the loss curves.
    std = fit_standardizer(X)
    std_x = apply_standardizer(X, std)
    reg_model, reg_loss = train_ridge(std_x, grades, feature_names, config)
    clf_model, clf_loss = train_logistic(std_x, high, feature_names, config)
    fitted_grade = [predict_linear(reg_model, std_x[i]) for i in range(n)]
    fitted_prob = [predict_proba(clf_model, std_x[i]) for i in range(n)]

    predictions: List[MinePrediction] = [
        {
            "mineId": m["id"],
            "name": m["name"],
            "state": m["state"],
            "operator": m["operator"],
            "miningMethod": m["miningMethod"],
            "capacityKt": m["capacityKt"],
            "actualGrade": grades[i],
            "cvPredictedGrade": oof_grade[i],
            "fittedGrade": fitted_grade[i],
            "residual": oof_grade[i] - grades[i],
            "highProb": oof_prob[i],
            "actualHigh": high[i] == 1,
        }
        for i, m in enumerate(MANGANESE_MINES)
    ]

    return {
        "modelId": "mn50",
        "version": "mn50-v1.0.0",
        "trainedAt": now_iso(),
        "seed": seed,
        "rows": n,
        "features": feature_names,
        "gradeThreshold": GRADE_THRESHOLD,
        "config": config,
        "regression": {
            "task": "ROM grade % Mn (regression)",
            "algorithm": "Ridge regression — full-batch gradient descent, L2",
            "metrics": regression_metrics(grades, oof_grade),
            "trainMetrics": regression_metrics(grades, fitted_grade),
            "loss": thin_curve(reg_loss),
            "coefficients": rank_coefficients(reg_model),
        },
        "classification": {
            "task": f"Premium grade ≥ {GRADE_THRESHOLD}% Mn (classification)",
            "algorithm": "Logistic regression — full-batch gradient descent, L2",
            "metrics": classification_metrics(high, oof_prob),
            "trainMetrics": classification_metrics(high, fitted_prob),
            "loss": thin_curve(clf_loss),
            "coefficients": rank_coefficients(clf_model),
        },
        "predictions": predictions,
    }


# The model as shipped — trained once, deterministically, on module load.
MANGANESE_TRAINING: ManganeseTraining = train_manganese_model()


# ── Deployed predictor ──────────────────────────────────────────────────────
#
# `train_manganese_model` above *reports* quality. This is the served model: the
# same two heads, refit on all 50 rows and frozen together with their
# standardiser, so another engine — the Mn prospectivity engine — can score
# ground the model never saw. The input is partial on purpose: any attribute the
# caller does not know is filled from the national-inventory median, which is
# what makes the predictor usable for greenfield ground where only a predicted
# depth is available.

ManganeseGradePrediction = Dict[str, Any]
ManganesePredictor = Dict[str, Any]


def _median(xs: List[float]) -> float:
    s = sorted(xs)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def _fit_deployed_predictor() -> ManganesePredictor:
    states = state_list()
    feature_names = feature_names_for(states)
    X = [feature_row(m, states) for m in MANGANESE_MINES]
    grades = [m["gradeMn"] for m in MANGANESE_MINES]
    high = [1 if m["gradeMn"] >= GRADE_THRESHOLD else 0 for m in MANGANESE_MINES]

    std = fit_standardizer(X)
    std_x = apply_standardizer(X, std)
    reg_model = train_ridge(std_x, grades, feature_names, DEFAULT_TRAIN)[0]
    clf_model = train_logistic(std_x, high, feature_names, DEFAULT_TRAIN)[0]

    defaults: Dict[str, Any] = {
        "capacityKt": _median([m["capacityKt"] for m in MANGANESE_MINES]),
        "reserveMt": _median([m["reserveMt"] for m in MANGANESE_MINES]),
        "commissioned": _median([m["commissioned"] for m in MANGANESE_MINES]),
        "depthM": _median([m["depthM"] for m in MANGANESE_MINES]),
        "phosphorusP": _median([m["phosphorusP"] for m in MANGANESE_MINES]),
        "miningMethod": "underground",
        "oreType": "gondite",
        "state": "Madhya Pradesh",
    }

    return {
        "modelId": "mn50",
        "version": "mn50-v1.0.0",
        "gradeThreshold": GRADE_THRESHOLD,
        "featureNames": feature_names,
        "states": states,
        "std": std,
        "regModel": reg_model,
        "clfModel": clf_model,
        "defaults": defaults,
    }


_PREDICTOR: ManganesePredictor = _fit_deployed_predictor()


def predict_manganese_grade(partial: Dict[str, Any]) -> ManganeseGradePrediction:
    """Port of ``MANGANESE_PREDICTOR.predict`` — partial input, median-filled."""
    p = _PREDICTOR
    full = {
        key: (partial[key] if partial.get(key) is not None else default)
        for key, default in p["defaults"].items()
    }
    z = apply_standardizer([feature_row(full, p["states"])], p["std"])[0]
    return {
        "gradeMn": predict_linear(p["regModel"], z),
        "premiumProb": predict_proba(p["clfModel"], z),
        "modelId": p["modelId"],
        "version": p["version"],
    }
