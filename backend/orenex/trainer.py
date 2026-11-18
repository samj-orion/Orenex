"""Port of ``trainer.ts``.

A small, real generalised-linear trainer that runs in the browser.

Why hand-rolled: this prototype has no Python backend any more, and the point
of the training screen is that the numbers on it are the actual result of
fitting a model on the mine inventory — not a hard-coded footnote. The
implementations below are standard full-batch gradient descent:

  - ``train_ridge``      — L2-regularised least squares (continuous target).
  - ``train_logistic``   — L2-regularised logistic regression (binary target).

Features are standardised before fitting so the L2 penalty is scale-uniform
and the weights are directly comparable as importances. Everything is
deterministic: the fold shuffle is driven by the project's seeded RNG.

Record shapes::

    Standardizer         = {"mean": list[float], "std": list[float]}
    LinearModel          = {"weights": list[float], "bias": float,
                            "featureNames": list[str]}
    TrainConfig          = {"epochs": int, "learningRate": float, "l2": float}
    RegressionMetrics    = {"mae": float, "rmse": float, "r2": float}
    ClassificationMetrics= {"accuracy": float, "precision": float,
                            "recall": float, "f1": float, "auc": float}
"""

from __future__ import annotations

import math
from typing import Dict, List

from .rng import make_rng

Standardizer = Dict[str, list]
LinearModel = Dict[str, object]
TrainConfig = Dict[str, float]
RegressionMetrics = Dict[str, float]
ClassificationMetrics = Dict[str, float]

# Defaults tuned for a ~50-row, ~20-feature standardised design matrix.
DEFAULT_TRAIN: TrainConfig = {"epochs": 900, "learningRate": 0.08, "l2": 0.06}


def mean(xs: List[float]) -> float:
    # Naive left-to-right accumulation to match JS ``Array#reduce`` exactly
    # (Python's ``sum`` uses compensated summation for floats on 3.12+).
    if not xs:
        return 0
    s = 0.0
    for v in xs:
        s += v
    return s / len(xs)


def fit_standardizer(X: List[List[float]]) -> Standardizer:
    d = len(X[0]) if X else 0
    mean_v = [0.0] * d
    std_v = [1.0] * d
    n = len(X)
    if not n:
        return {"mean": mean_v, "std": std_v}
    for j in range(d):
        s = 0.0
        for i in range(n):
            s += X[i][j]
        mean_v[j] = s / n
    for j in range(d):
        s = 0.0
        for i in range(n):
            dv = X[i][j] - mean_v[j]
            s += dv * dv
        sd = math.sqrt(s / n)
        std_v[j] = sd if sd > 1e-9 else 1
    return {"mean": mean_v, "std": std_v}


def apply_standardizer(X: List[List[float]], s: Standardizer) -> List[List[float]]:
    m = s["mean"]
    sd = s["std"]
    return [[(v - m[j]) / sd[j] for j, v in enumerate(row)] for row in X]


def train_ridge(
    X: List[List[float]],
    y: List[float],
    feature_names: List[str],
    config: TrainConfig = DEFAULT_TRAIN,
) -> tuple[LinearModel, List[float]]:
    """Fit ridge regression on an already-standardised design matrix."""
    n = len(X)
    d = len(X[0]) if X else 0
    weights = [0.0] * d
    bias = mean(y)
    loss: List[float] = []
    lr = config["learningRate"]

    for _epoch in range(int(config["epochs"])):
        gw = [0.0] * d
        gb = 0.0
        sse = 0.0
        for i in range(n):
            pred = bias
            xi = X[i]
            for j in range(d):
                pred += weights[j] * xi[j]
            err = pred - y[i]
            sse += err * err
            gb += err
            for j in range(d):
                gw[j] += err * xi[j]
        for j in range(d):
            g = gw[j] / n + config["l2"] * weights[j]
            weights[j] -= lr * g
        bias -= lr * (gb / n)
        ss = 0.0
        for w in weights:
            ss += w * w
        loss.append(sse / n + config["l2"] * ss)

    return {"weights": weights, "bias": bias, "featureNames": feature_names}, loss


def sigmoid(z: float) -> float:
    return 1 / (1 + math.exp(-max(-30, min(30, z))))


def predict_linear(model: LinearModel, x: List[float]) -> float:
    weights = model["weights"]
    z = model["bias"]
    for j in range(len(weights)):
        z += weights[j] * x[j]
    return z


def predict_proba(model: LinearModel, x: List[float]) -> float:
    return sigmoid(predict_linear(model, x))


def train_logistic(
    X: List[List[float]],
    y: List[float],
    feature_names: List[str],
    config: TrainConfig = DEFAULT_TRAIN,
) -> tuple[LinearModel, List[float]]:
    """Fit logistic regression on an already-standardised design matrix."""
    n = len(X)
    d = len(X[0]) if X else 0
    weights = [0.0] * d
    bias = 0.0
    loss: List[float] = []
    lr = config["learningRate"] * 2

    for _epoch in range(int(config["epochs"])):
        gw = [0.0] * d
        gb = 0.0
        bce = 0.0
        for i in range(n):
            z = bias
            xi = X[i]
            for j in range(d):
                z += weights[j] * xi[j]
            p = sigmoid(z)
            yv = y[i]
            bce += -(yv * math.log(p + 1e-12) + (1 - yv) * math.log(1 - p + 1e-12))
            err = p - yv
            gb += err
            for j in range(d):
                gw[j] += err * xi[j]
        for j in range(d):
            g = gw[j] / n + config["l2"] * weights[j]
            weights[j] -= lr * g
        bias -= lr * (gb / n)
        ss = 0.0
        for w in weights:
            ss += w * w
        loss.append(bce / n + (config["l2"] / 2) * ss)

    return {"weights": weights, "bias": bias, "featureNames": feature_names}, loss


def regression_metrics(y_true: List[float], y_pred: List[float]) -> RegressionMetrics:
    n = len(y_true)
    if not n:
        return {"mae": 0, "rmse": 0, "r2": 0}
    sae = 0.0
    sse = 0.0
    ym = mean(y_true)
    sst = 0.0
    for i in range(n):
        e = y_pred[i] - y_true[i]
        sae += abs(e)
        sse += e * e
        sst += (y_true[i] - ym) ** 2
    return {"mae": sae / n, "rmse": math.sqrt(sse / n), "r2": (1 - sse / sst) if sst > 0 else 0}


def roc_auc(y_true: List[float], scores: List[float]) -> float:
    """ROC-AUC via the Mann–Whitney rank statistic (ties count as half)."""
    pos: List[float] = []
    neg: List[float] = []
    for i in range(len(y_true)):
        (pos if y_true[i] else neg).append(scores[i])
    if not pos or not neg:
        return 0.5
    wins = 0.0
    for p in pos:
        for n in neg:
            wins += 1 if p > n else (0.5 if p == n else 0)
    return wins / (len(pos) * len(neg))


def classification_metrics(y_true: List[float], scores: List[float]) -> ClassificationMetrics:
    tp = 0
    fp = 0
    tn = 0
    fn = 0
    for i in range(len(y_true)):
        pred = 1 if scores[i] >= 0.5 else 0
        if pred == 1 and y_true[i] == 1:
            tp += 1
        elif pred == 1 and y_true[i] == 0:
            fp += 1
        elif pred == 0 and y_true[i] == 0:
            tn += 1
        else:
            fn += 1
    precision = tp / (tp + fp) if tp + fp > 0 else 0
    recall = tp / (tp + fn) if tp + fn > 0 else 0
    f1 = (2 * precision * recall) / (precision + recall) if precision + recall > 0 else 0
    total = tp + fp + tn + fn
    return {
        "accuracy": (tp + tn) / total if total else 0,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "auc": roc_auc(y_true, scores),
    }


def k_fold(n: int, k: int, seed: int) -> List[List[int]]:
    """Deterministic k-fold split. Returns ``k`` lists of test indices."""
    rng = make_rng(seed)
    idx = list(range(n))
    for i in range(n - 1, 0, -1):
        j = math.floor(rng() * (i + 1))
        idx[i], idx[j] = idx[j], idx[i]
    folds: List[List[int]] = [[] for _ in range(k)]
    for pos, v in enumerate(idx):
        folds[pos % k].append(v)
    return folds


def rank_coefficients(model: LinearModel) -> List[Dict[str, float]]:
    """Coefficients sorted by absolute magnitude — the importance ranking."""
    feature_names = model["featureNames"]
    weights = model["weights"]
    rows = [{"feature": feature, "weight": weights[j]} for j, feature in enumerate(feature_names)]
    rows.sort(key=lambda r: -abs(r["weight"]))
    return rows


def thin_curve(loss: List[float], max: int = 60) -> List[float]:
    """Thin a loss curve down to at most ``max`` points for charting."""
    if len(loss) <= max:
        return loss
    stride = len(loss) / max
    out: List[float] = []
    for i in range(max):
        out.append(loss[math.floor(i * stride)])
    out[len(out) - 1] = loss[len(loss) - 1]
    return out
