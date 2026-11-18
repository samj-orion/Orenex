"""Port of ``prospectivity.ts``.

M1 — Manganese prospectivity (greenfield).

Positive-unlabelled learning: known occurrences are positives, everything else
is *unlabelled*, not negative. The scoring surface below is a logistic model
over the same feature set the architecture lists, with weights taken from the
documented geology prior (host-formation membership and distance to mapped Mn
horizons dominate). Explanations are produced by leave-one-feature ablation in
log-odds space, which is what the SHAP panel reports.
"""

from __future__ import annotations

import math
from array import array
from typing import Any, Callable, Dict, List, Optional, Sequence

from .geo import AOI_HEIGHT_M, AOI_WIDTH_M, denorm_x, denorm_y, norm_x, norm_y
from .geology import (
    GEO_UNITS,
    MINES,
    OCCURRENCES,
    STRUCTURES,
    TERRAIN,
    dist_to_path,
    dist_to_ring,
)
from .noise import clamp, make_fbm, make_noise_2d, make_ridged, sample_field, smoothstep
from .rng import make_rng
from .manganese_model import predict_manganese_grade

NX = 132  # 132 × 30 m ≈ 3.96 km tiles → 4 km blocks
NY = 118


def _f32(n: int) -> array:
    """``new Float32Array(n)`` — zero-filled single-precision storage."""
    return array("f", [0.0]) * n


def _f64(n: int) -> array:
    """``new Float64Array(n)`` — zero-filled double-precision storage."""
    return array("d", [0.0]) * n


def _u8(n: int) -> array:
    """``new Uint8Array(n)`` — zero-filled byte storage."""
    return array("B", [0]) * n


# FeatureDef record shape:
#   {"key": str, "label": str,
#    "group": "geology" | "geophysics" | "spectral" | "terrain" | "environment",
#    "weight": float, "unit": str, "note": str}
FEATURES: List[Dict[str, Any]] = [
    {
        "key": "host",
        "label": "Host-formation membership",
        "group": "geology",
        "weight": 2.15,
        "unit": "0–1",
        "note": "Distance to the nearest Sausar Group gondite / Mn-silicate horizon.",
    },
    {
        "key": "horizonProx",
        "label": "Proximity to mapped Mn horizon",
        "group": "geology",
        "weight": 1.62,
        "unit": "0–1",
        "note": "Inverse distance to mapped Mn-bearing units within the belt.",
    },
    {
        "key": "faultProx",
        "label": "Fault / lineament intersection",
        "group": "geology",
        "weight": 1.05,
        "unit": "0–1",
        "note": "Structural channelisation — ore fluids follow high-angle structures.",
    },
    {
        "key": "magAnom",
        "label": "Magnetic high–low transition",
        "group": "geophysics",
        "weight": 0.92,
        "unit": "σ",
        "note": "Reduced-to-pole residual at the margin of the BIF–pelite contact.",
    },
    {
        "key": "gravAnom",
        "label": "Gravity residual gradient",
        "group": "geophysics",
        "weight": 0.61,
        "unit": "mGal",
        "note": "Edges at the ferruginous cover over the ore-bearing horizon.",
    },
    {
        "key": "ferric",
        "label": "Ferric iron band ratio",
        "group": "spectral",
        "weight": 0.74,
        "unit": "σ",
        "note": "Sentinel-2 B4/B2 style ratio — surface Mn–Fe oxide expressions.",
    },
    {
        "key": "clay",
        "label": "Clay / alteration index",
        "group": "spectral",
        "weight": 0.48,
        "unit": "σ",
        "note": "Short-wave infrared clay-mineral signature over altered host.",
    },
    {
        "key": "ndviLow",
        "label": "Low vegetation response",
        "group": "spectral",
        "weight": 0.53,
        "unit": "σ",
        "note": "Sparse cover on outcrop horizons versus vegetated alluvium.",
    },
    {
        "key": "relief",
        "label": "Ridge-gully position",
        "group": "terrain",
        "weight": 0.4,
        "unit": "σ",
        "note": "Eroded ridge crests expose the horizon; TPI plus drainage density.",
    },
    {
        "key": "slopeLow",
        "label": "Gentle dip slope",
        "group": "terrain",
        "weight": 0.28,
        "unit": "σ",
        "note": "Shallow-dipping host is easier to evaluate and to drill.",
    },
    {
        "key": "soilWet",
        "label": "Soil moisture anomaly",
        "group": "environment",
        "weight": -0.22,
        "unit": "σ",
        "note": "Standing moisture and alluvial cover depress surface expression.",
    },
    {
        "key": "occProx",
        "label": "Known-occurrence clustering",
        "group": "geology",
        "weight": 0.83,
        "unit": "0–1",
        "note": "Density of Mn-positive drill intervals within 2 km.",
    },
]

# CalCurve record shape:
#   {"key": str, "label": str, "baseRate": float,
#    "x": array('d'), "y": array('d'),
#    "rawEce": float, "fittedEce": float, "bins": int, "cells": int,
#    "positives": int, "apply": Callable[[float], float]}
#
# Calibrator record shape:
#   {"pooled": CalCurve, "strata": List[CalCurve], "baseRate": float,
#    "rawEce": float, "fittedEce": float, "bins": int,
#    "apply": Callable[[float, Optional[float]], float]}
#
# ProspectivityField record shape:
#   {"nx": int, "ny": int, "raw": array('f'), "prob": array('f'),
#    "depth": array('f'), "depthSigma": array('f'),
#    "contributions": List[array('f')], "coverage": array('f'),
#    "cellSizeM": float, "calibrator": Calibrator, "fit": WeightFit}


# ── Synthetic observation layers (stand-ins for the real satellite feeds) ──
#
# These are not decorative noise. A banded iron formation is magnetic, a ferric
# gossan weathers to haematite and goethite that show up in the Sentinel-2
# red/blue ratio, and a clay alteration halo has a short-wave-infrared
# signature. So each layer is the geological field sampled at that wavelength,
# plus the survey texture a real instrument has. The layers are *derived from*
# mapped geology rather than independent of it, which is the only reason a
# multi-layer model can beat a geology-only one — otherwise the extra inputs
# would be noise that dilutes the signal.


def build_remote_sensing() -> Dict[str, array]:
    nx = TERRAIN["nx"]
    ny = TERRAIN["ny"]
    mag_n = make_ridged(1201, 4)
    mag_f = make_fbm(1307, 5)
    grav = make_fbm(1447, 4, 2.1, 0.55)
    band = make_noise_2d(1511)
    band2 = make_noise_2d(1613)

    mag = _f32(nx * ny)
    grav_a = _f32(nx * ny)
    ferric = _f32(nx * ny)
    clay = _f32(nx * ny)
    ndvi = _f32(nx * ny)
    lst = _f32(nx * ny)
    soil = _f32(nx * ny)

    # Rock properties aggregated over the mapped units, plus a soft contact
    # response — the survey sees the edge, not the unit.
    unit_field = _f32(nx * ny)
    contact_field = _f32(nx * ny)
    cover_field = _f32(nx * ny)
    sus_field = _f32(nx * ny)
    den_field = _f32(nx * ny)
    clay_halo = _f32(nx * ny)
    for j in range(ny):
        y = denorm_y(j / (ny - 1))
        for i in range(nx):
            x = denorm_x(i / (nx - 1))
            d_host = math.inf
            d_cover = math.inf
            # The magnetic source is the ferruginous sequence — gondite,
            # Mn-silicate and the banded iron formation it intergrades with.
            # Selecting only the BIF would put the magnetic edge somewhere else
            # on the ground entirely, because the BIF bands and the Mn-bearing
            # bands are not coincident.
            d_magnetic = math.inf
            for unit in GEO_UNITS:
                d = dist_to_ring(x, y, unit["ring"])
                if unit["favourable"] and d < d_host:
                    d_host = d
                if unit["cover"] and d < d_cover:
                    d_cover = d
                if unit["susceptibility"] >= 0.015 and d < d_magnetic:
                    d_magnetic = d
            k = j * nx + i
            host_near = 1 - smoothstep(0, 1800, d_host)
            unit_field[k] = host_near
            cover_field[k] = 1 - smoothstep(0, 1500, d_cover)
            # Peak at ~1.2 km from the horizon trace: the contact, not the interior.
            contact_field[k] = 1 - abs(1 - smoothstep(0, 2400, d_host) * 2)
            # Airborne magnetometry sees through cover; ground truth degrades
            # under a laterite blanket, which is why the ferric term has to be
            # read with it.
            look = 1 - 0.35 * cover_field[k]
            sus_field[k] = (0.015 + 0.85 * (1 - smoothstep(0, 2400, d_magnetic))) * look
            den_field[k] = 2.67 + 0.9 * (host_near - 0.5) * look
            # Hydrothermal alteration sits just outside the ore body.
            clay_halo[k] = (1 - abs(1 - smoothstep(0, 2600, d_host) * 2)) * 0.7

    for j in range(ny):
        for i in range(nx):
            u = i / (nx - 1)
            v = j / (ny - 1)
            k = j * nx + i
            unit = unit_field[k]
            contact = contact_field[k]
            cover = cover_field[k]

            # Airborne magnetic residual, reduced to pole, in nT about the
            # regional mean. BIF/gondite response over the horizon, basement to
            # the south, survey noise on top. Dynamic range is kept realistic
            # (~±80 nT) because the model's edge detector is scaled by this
            # field's own SD.
            band_coord = v - (0.44 + 0.2 * (u - 0.5))
            mag[k] = clamp(
                120 * sus_field[k]
                + 26 * contact
                - 18 * cover
                + 22 * math.cos(band_coord * 7.4)
                + 11 * mag_n(u * 3.6, v * 3.6)
                + 8 * mag_f(u * 8, v * 8),
                -140,
                140,
            )
            # Bouguer gravity: the horizon is denser than the metapelites it sits in.
            grav_a[k] = clamp(
                0.44
                + 0.4 * (den_field[k] - 2.62)
                + 0.09 * band(u * 2.2, v * 2.2)
                + 0.08 * grav(u * 4.4, v * 4.4),
                0,
                1,
            )
            # Sentinel-2 red/blue ferric ratio. Cover suppresses it — the signal
            # is surface oxidation, so a laterite blanket hides the outcrop.
            ferric[k] = clamp(
                0.4
                + 0.3 * unit
                + 0.12 * contact
                - 0.14 * cover
                + 0.1 * band(u * 5.3 + 3.1, v * 5.3)
                + 0.06 * band2(u * 11, v * 11),
                0,
                1,
            )
            # Short-wave infrared clay signature: the alteration halo, at the margin.
            clay[k] = clamp(
                0.42
                + 0.24 * clay_halo[k]
                - 0.1 * unit
                + 0.12 * band2(u * 4.1, v * 4.1 + 2.2)
                + 0.07 * band(u * 9.3, v * 9.3),
                0,
                1,
            )
            # Vegetation follows cover and moisture, not rock.
            ndvi[k] = clamp(
                0.3
                + 0.34 * cover
                - 0.12 * unit
                + 0.13 * band2(u * 3.4 + 8, v * 3.4)
                - 0.05 * mag_f(u * 6.6, v * 6.6),
                0,
                1,
            )
            # LST: bare ferric rock runs hot in the dry season, vegetation does not.
            lst[k] = clamp(0.42 + 0.36 * ferric[k] - 0.22 * ndvi[k], 0, 1)
            # Soil moisture tracks cover and drainage, not ore.
            soil[k] = clamp(
                0.42
                + 0.24 * (1 - ndvi[k])
                + 0.12 * cover
                + 0.1 * band(u * 7.7 + 5, v * 7.7),
                0,
                1,
            )
    return {"mag": mag, "grav": grav_a, "ferric": ferric, "clay": clay, "ndvi": ndvi, "lst": lst, "soil": soil}


REMOTE = build_remote_sensing()


def build_horizon_field() -> Dict[str, Any]:
    """Distance to the nearest mapped Mn-bearing unit, precomputed on the grid.

    Depends only on mapped geology, so it is shared by every refit.
    """
    nx = NX
    ny = NY
    prox = _f32(nx * ny)
    host = _f32(nx * ny)
    favourable = [u for u in GEO_UNITS if u["favourable"]]

    for j in range(ny):
        y = denorm_y(j / (ny - 1))
        for i in range(nx):
            x = denorm_x(i / (nx - 1))
            k = j * nx + i
            d_host = math.inf
            d_horizon = math.inf
            for unit in favourable:
                d = dist_to_ring(x, y, unit["ring"])
                if d < d_host:
                    d_host = d
                if d < d_horizon:
                    d_horizon = d
            host[k] = 1 - smoothstep(0, 2600, d_host)
            prox[k] = 1 - smoothstep(0, 4200, d_horizon)
    return {"prox": prox, "host": host, "nx": nx, "ny": ny}


HORIZON = build_horizon_field()


def build_occ_prox(occs: Sequence[Dict[str, Any]]) -> array:
    """Known-occurrence clustering from a *given* occurrence list.

    This is the only feature that depends on labels, so it is what the spatial
    block CV has to withhold. Refitting with a district's occurrences removed is
    the whole point of that test — a model scored on occurrences it can see is
    measuring nothing.
    """
    dens = _f32(NX * NY)
    for j in range(NY):
        y = denorm_y(j / (NY - 1))
        for i in range(NX):
            x = denorm_x(i / (NX - 1))
            acc = 0.0
            for occ in occs:
                d = math.hypot(x - occ["x"], y - occ["y"])
                if d < 2000:
                    acc += 1 - d / 2000
            dens[j * NX + i] = acc
    # Smooth so the term describes a neighbourhood, not a point marker.
    sm = _f32(NX * NY)
    for j in range(NY):
        for i in range(NX):
            acc = 0.0
            n = 0
            for dj in range(-2, 3):
                for di in range(-2, 3):
                    ii = i + di
                    jj = j + dj
                    if ii < 0 or jj < 0 or ii >= NX or jj >= NY:
                        continue
                    acc += dens[jj * NX + ii]
                    n += 1
            sm[j * NX + i] = acc / n
    return sm


def field_stats(a: Sequence[float]) -> Dict[str, float]:
    """Distribution of a field over the whole AOI, measured rather than assumed.

    Hard-coding the mean and SD of a synthetic layer is how a feature ends up
    100% clipped at its z-score bound — at which point it is a constant plus
    noise and carries no information at all. Every normalisation below uses the
    measured statistics of the field it normalises.
    """
    total = 0.0
    for i in range(len(a)):
        total += a[i]
    mean = total / len(a)
    sq = 0.0
    for i in range(len(a)):
        sq += (a[i] - mean) ** 2
    sd = math.sqrt(sq / len(a))
    return {"mean": mean, "sd": sd if sd else 1.0}


def std_norm(v: float, mean: float, sd: float) -> float:
    return clamp((v - mean) / (sd if sd else 1), -3, 3)


STATS: Dict[str, Dict[str, float]] = {
    "ferric": field_stats(REMOTE["ferric"]),
    "clay": field_stats(REMOTE["clay"]),
    "ndvi": field_stats(REMOTE["ndvi"]),
    "soil": field_stats(REMOTE["soil"]),
    "mag": field_stats(REMOTE["mag"]),
    "grav": field_stats(REMOTE["grav"]),
    "slope": field_stats(TERRAIN["slope"]),
    "tpi": field_stats(TERRAIN["tpi"]),
}


def edge_response(a: Sequence[float], u: float, v: float, step_uv: float, sd: float) -> float:
    """Absolute value of a central difference, in units of the field's own SD.

    Used for the geophysical edge terms: ore sits at the margin of a magnetic
    high, so the gradient is the signal, not the amplitude.
    """
    d = sample_field(a, TERRAIN["nx"], TERRAIN["ny"], min(0.999, u + step_uv), v) - sample_field(
        a, TERRAIN["nx"], TERRAIN["ny"], max(0.001, u - step_uv), v
    )
    return abs(d) / (2 * step_uv * sd)


def build_edge_field(a: Sequence[float], nx: int, ny: int, step_uv: float) -> array:
    """Geophysical edge strength, precomputed on the analysis grid.

    A survey gradient is only interpretable relative to the rest of the survey,
    so the edge is ramped between the district's own median and its 97th
    percentile. Hard-coded thresholds either saturate half the district or bury
    the contact; deriving them from the measured distribution means the term
    always spans its full range and always means the same thing wherever the
    survey is flown.
    """
    raw = _f32(NX * NY)
    sd = field_stats(a)["sd"] or 1
    for j in range(NY):
        for i in range(NX):
            raw[j * NX + i] = edge_response(a, i / (nx - 1), j / (ny - 1), step_uv, sd)
    sorted_vals = sorted(raw)

    def p(q: float) -> float:
        return sorted_vals[
            min(len(sorted_vals) - 1, max(0, int(math.floor(q * (len(sorted_vals) - 1) + 0.5))))
        ]

    lo = p(0.35)
    hi = p(0.97)
    out = _f32(NX * NY)
    for k in range(len(out)):
        out[k] = clamp((raw[k] - lo) / max(1e-9, hi - lo), 0, 1)
    return out


MAG_EDGE = build_edge_field(REMOTE["mag"], TERRAIN["nx"], TERRAIN["ny"], 0.012)
GRAV_EDGE = build_edge_field(REMOTE["grav"], TERRAIN["nx"], TERRAIN["ny"], 0.012)


# ── Weight estimation ───────────────────────────────────────────────────────
#
# The weights above are a *prior* taken from the documented geology, not a fit.
# Hand-set weights are the right starting point and the wrong final answer: the
# layers are correlated with each other (host formation, magnetic edge and
# gravity edge all trace the same contact), and a fixed weight on a redundant
# feature buys no discrimination and costs variance. So the deployed model fits
# the weights by regularised PU logistic regression, anchored to the prior, and
# the block CV refits them per fold.

# WeightFit record shape:
#   {"weights": array('d'), "bias": float, "iterations": int,
#    "loss": float, "drift": float}


L2 = 0.06
L2_PRIOR = 2.4
PU_ALPHA = 0.9
FIT_ITERS = 140


def fit_weights(
    label: Sequence[int],
    train_mask: Optional[Sequence[int]],
    active: Sequence[Dict[str, Any]],
    features: Sequence[float],
    n: int,
) -> Dict[str, Any]:
    """Positive-unlabelled logistic regression by damped gradient descent.

    PU rather than supervised: an unlabelled cell is unlabelled, not negative.
    The objective treats every unlabelled cell as a mix of hidden positives and
    true negatives at rate ``alpha``, which is the standard correction — without
    it the model learns that most of the belt is barren and under-scores the
    contacts.
    """
    m = len(active)
    w = _f64(m)
    prior = _f64(m)
    for i, f in enumerate(active):
        w[i] = f["weight"]
        prior[i] = f["weight"]
    bias = BIAS

    # Rows eligible for training.
    rows: List[int] = []
    ys: List[int] = []
    for k in range(n):
        if train_mask is not None and not train_mask[k]:
            continue
        rows.append(k)
        ys.append(label[k])
    if not rows or m == 0:
        return {"weights": weights_of(active, w), "bias": bias, "iterations": 0, "loss": float("nan"), "drift": 0}

    gw = _f64(m)
    gb = 0.0
    loss = 0.0
    lr = 0.55

    for it in range(FIT_ITERS):
        gw = _f64(m)
        gb = 0.0
        loss = 0.0
        for r in range(len(rows)):
            k = rows[r]
            base = k * m
            z = bias
            for i in range(m):
                z += w[i] * features[base + i]
            p = 1 / (1 + math.exp(-z))

            if ys[r] == 1:
                target = 1.0
                coef = 1.0
            else:
                target = alpha_mixed(ys[r], p, bias)
                coef = PU_ALPHA
            d = (p - target) * coef
            for i in range(m):
                gw[i] += d * features[base + i]
            gb += d
            loss += -(
                (1 if ys[r] == 1 else target) * math.log(max(1e-9, p))
                + (0 if ys[r] == 1 else 1 - target) * math.log(max(1e-9, 1 - p))
            )

        # Ridge, pulled toward the documented prior rather than toward zero: the
        # prior is real geological knowledge and should not be relearned from
        # scratch every refit, but neither should it be free to override the data.
        for i in range(m):
            loss += (L2 * w[i] * w[i]) / 2 + (L2_PRIOR * (w[i] - prior[i]) ** 2) / 2
            gw[i] += L2 * w[i] + L2_PRIOR * (w[i] - prior[i])
        loss += (L2 * bias * bias) / 2
        gb += L2 * bias

        n_inv = 1 / len(rows)
        step = lr / (1 + it * 0.012)
        for i in range(m):
            w[i] -= step * (gw[i] * n_inv + 0)
        bias -= step * gb * n_inv

    drift = 0.0
    for i in range(m):
        drift += abs(w[i] - prior[i])
    drift /= max(1, m)

    return {"weights": weights_of(active, w), "bias": bias, "iterations": FIT_ITERS, "loss": loss / len(rows), "drift": drift}


def weights_of(active: Sequence[Dict[str, Any]], w: Sequence[float]) -> array:
    out = _f64(len(FEATURES))
    for i, f in enumerate(active):
        idx = -1
        for j, g in enumerate(FEATURES):
            if g is f:
                idx = j
                break
        if idx >= 0:
            out[idx] = w[i]
    return out


def alpha_mixed(_y: int, p: float, bias: float) -> float:
    """Elkan–Noto style PU label correction for an unlabelled cell."""
    prior_p = 1 / (1 + math.exp(-bias))
    c = clamp(p * (1 - PU_ALPHA) / max(1e-6, prior_p * (1 - PU_ALPHA) + PU_ALPHA * p), 0, 1)
    return clamp(c, 0, 1)


BIAS = -1.72


def features_at(i: int, j: int, occ_prox: Optional[Sequence[float]] = None) -> Dict[str, float]:
    """Feature vector for one analysis cell, against a given occurrence set."""
    u = i / (NX - 1)
    v = j / (NY - 1)
    x = denorm_x(u)
    y = denorm_y(v)
    k = j * NX + i

    slope = sample_field(TERRAIN["slope"], TERRAIN["nx"], TERRAIN["ny"], u, v)
    tpi = sample_field(TERRAIN["tpi"], TERRAIN["nx"], TERRAIN["ny"], u, v)
    flow = sample_field(TERRAIN["flow"], TERRAIN["nx"], TERRAIN["ny"], u, v)

    d_fault = math.inf
    d_mapped_fault = math.inf
    for s in STRUCTURES:
        d = dist_to_path(x, y, s["path"])
        if d < d_fault:
            d_fault = d
        if s["mapped"] and d < d_mapped_fault:
            d_mapped_fault = d
    if not math.isfinite(d_fault):
        d_fault = 40000
    if not math.isfinite(d_mapped_fault):
        d_mapped_fault = 40000

    ferric = sample_field(REMOTE["ferric"], TERRAIN["nx"], TERRAIN["ny"], u, v)
    clay = sample_field(REMOTE["clay"], TERRAIN["nx"], TERRAIN["ny"], u, v)
    ndvi = sample_field(REMOTE["ndvi"], TERRAIN["nx"], TERRAIN["ny"], u, v)
    soil = sample_field(REMOTE["soil"], TERRAIN["nx"], TERRAIN["ny"], u, v)

    # The geophysics terms are edge detectors: the ore horizon sits at the
    # boundary of a magnetic high, so the gradient at ~1.5 km across the contact
    # is the evidence. Both are ramped against the survey's own distribution.
    return {
        "host": HORIZON["host"][k],
        "horizonProx": HORIZON["prox"][k],
        "faultProx": (1 - smoothstep(0, 1800, d_fault)) * 0.65 + (1 - smoothstep(0, 2600, d_mapped_fault)) * 0.35,
        "magAnom": MAG_EDGE[k],
        "gravAnom": GRAV_EDGE[k],
        "ferric": std_norm(ferric, STATS["ferric"]["mean"], STATS["ferric"]["sd"]),
        "clay": std_norm(clay, STATS["clay"]["mean"], STATS["clay"]["sd"]),
        "ndviLow": std_norm(1 - ndvi, 1 - STATS["ndvi"]["mean"], STATS["ndvi"]["sd"]),
        "relief": std_norm(tpi, STATS["tpi"]["mean"], STATS["tpi"]["sd"]) * 0.7 + flow * 0.3,
        "slopeLow": std_norm(18 - slope, 18 - STATS["slope"]["mean"], STATS["slope"]["sd"]),
        "soilWet": std_norm(soil, STATS["soil"]["mean"], STATS["soil"]["sd"]),
        "occProx": clamp(occ_prox[k] / 3.2, 0, 1)
        if occ_prox is not None
        else 1 - smoothstep(0, 2000, occ_dist_local(k)),
    }


def occ_dist_local(k: int) -> float:
    # Reconstruct a distance proxy from the density field for the PU term.
    dens = OCC_DENSITY[k]
    return 9999 if dens <= 0 else 2000 * (1 - min(1, dens / 3.2))


OCC_DENSITY = build_occ_prox(OCCURRENCES)


def logit(p: float) -> float:
    q = clamp(p, 1e-4, 1 - 1e-4)
    return math.log(q / (1 - q))


# ── Calibration ────────────────────────────────────────────────────────────
#
# A logistic score over hand-set weights is nowhere near a probability: it is
# spread over the whole range while the true event rate is ~11%. Hand-tuning a
# fixed affine log-odds transform to look better is how a model ends up
# confidently wrong. Instead the reliability curve is *fitted*, once, from the
# labels the model is actually allowed to see.


def label_cells(occs: Sequence[Dict[str, Any]], radius_m: float = 1400) -> array:
    """Cells whose centre lies within ``radiusM`` of a supplied occurrence."""
    label = _u8(NX * NY)
    rx = math.ceil(radius_m / (AOI_WIDTH_M / (NX - 1)))
    ry = math.ceil(radius_m / (AOI_HEIGHT_M / (NY - 1)))
    for o in occs:
        ci = int(math.floor(norm_x(o["x"]) * (NX - 1) + 0.5))
        cj = int(math.floor(norm_y(o["y"]) * (NY - 1) + 0.5))
        for j in range(cj - ry, cj + ry + 1):
            if j < 0 or j >= NY:
                continue
            cy = denorm_y(j / (NY - 1))
            for i in range(ci - rx, ci + rx + 1):
                if i < 0 or i >= NX:
                    continue
                if math.hypot(denorm_x(i / (NX - 1)) - o["x"], cy - o["y"]) < radius_m:
                    label[j * NX + i] = 1
    return label


def pava(xs: Sequence[float], ys: Sequence[float], ws: Sequence[float]) -> Dict[str, List[float]]:
    """Pool-adjacent-violators: the minimum-adjustment non-decreasing LS fit.

    Adjacent bins are merged whenever the fit would start decreasing, so the
    result is monotone by construction — which means calibration cannot move a
    single cell across another in the ranking, and AUC is untouched.
    """
    bx: List[float] = []
    by: List[float] = []
    bw: List[float] = []
    for i in range(len(xs)):
        x = xs[i]
        y = ys[i]
        w = ws[i]
        while len(by) > 0 and by[-1] > y:
            px = bx.pop()
            py = by.pop()
            pw = bw.pop()
            tw = pw + w
            x = (px * pw + x * w) / tw
            y = (py * pw + y * w) / tw
            w = tw
        bx.append(x)
        by.append(y)
        bw.append(w)
    return {"x": bx, "y": by}


CAL_BINS = 48

# Calibration strata.
#
# A single global reliability curve cannot be right everywhere: the belt's base
# rate inside the mapped Mn horizon is several times the rate over cover
# sequences, so one curve is systematically conservative over the horizon and
# optimistic off it. Fitting per stratum is the minimum that makes the
# out-of-block numbers hold up.
CAL_STRATA: List[Dict[str, Any]] = [
    {"key": "in-horizon", "label": "Inside mapped Mn horizon", "hostMin": 0.5},
    {"key": "off-horizon", "label": "Cover sequences / off-horizon", "hostMin": -1},
]


def stratum_of(host: float) -> int:
    return 0 if host >= CAL_STRATA[0]["hostMin"] else 1


def ece_of(bin_x: Sequence[float], bin_y: Sequence[float], ws: Sequence[float], apply: Callable[[float], float]) -> float:
    total = 0.0
    for w in ws:
        total += w
    if not total:
        return 0
    err = 0.0
    for i in range(len(bin_x)):
        err += ws[i] * abs(apply(bin_x[i]) - bin_y[i])
    return err / total


def eval_monotone(fx: Sequence[float], fy: Sequence[float], r: float) -> float:
    """Piecewise-linear read of a monotone ascending knot table, clamped at both ends."""
    if not fx:
        return float("nan")
    last = len(fx) - 1
    if r <= fx[0]:
        return fy[0]
    if r >= fx[last]:
        return fy[last]
    lo = 0
    hi = last
    while hi - lo > 1:
        m = (lo + hi) >> 1
        if fx[m] <= r:
            lo = m
        else:
            hi = m
    span = fx[hi] - fx[lo]
    t = (r - fx[lo]) / span if span > 1e-12 else 0
    return fy[lo] + t * (fy[hi] - fy[lo])


def fit_curve(raw: Sequence[float], label: Sequence[int], cells: List[int], key: str, label_text: str) -> Dict[str, Any]:
    cells.sort(key=lambda a: raw[a])
    n = len(cells)
    positives = 0
    for k in cells:
        positives += label[k]

    # Equal-count bins. Quantile edges are rounded rather than stepped so the
    # top bin is never a sliver — a 24-cell top bin that happens to be all
    # positives would drag the fitted curve to ~1.0 and flatten everything below.
    xs: List[float] = []
    ys: List[float] = []
    ws: List[float] = []
    for b in range(CAL_BINS):
        lo = int(math.floor((b * n) / CAL_BINS + 0.5))
        hi = int(math.floor(((b + 1) * n) / CAL_BINS + 0.5))
        if hi <= lo:
            continue
        sx = 0.0
        sy = 0.0
        for t in range(lo, hi):
            sx += raw[cells[t]]
            sy += label[cells[t]]
        # Laplace smoothing: without it a single miss in the top bin pins the
        # fitted curve at exactly 1.0.
        ys.append((sy + 1) / (hi - lo + 2))
        xs.append(sx / (hi - lo))
        ws.append(hi - lo)

    fit = pava(xs, ys, ws)
    fx = array("d", fit["x"])
    fy = array("d", fit["y"])

    def apply(r: float) -> float:
        return clamp(eval_monotone(fx, fy, r), 1e-4, 1 - 1e-4)

    return {
        "key": key,
        "label": label_text,
        "baseRate": float(f"{positives / max(1, n):.4f}"),
        "x": fx,
        "y": fy,
        "apply": apply,
        "rawEce": float(f"{ece_of(xs, ys, ws, lambda v: v):.4f}"),
        "fittedEce": float(f"{ece_of(xs, ys, ws, apply):.4f}"),
        "bins": len(ws),
        "cells": n,
        "positives": positives,
    }


def fit_calibrator(raw: Sequence[float], occs: Sequence[Dict[str, Any]], train_mask: Optional[Sequence[int]] = None) -> Dict[str, Any]:
    """Fit the reliability curve P(Mn occurrence within 1.4 km | score).

    Isotonic regression on equal-count quantile bins of the raw score, fitted
    per calibration stratum using only the occurrences handed to this refit.
    ``trainMask`` restricts which cells may contribute, and the spatial block CV
    uses it to keep the held-out block out of its own calibrator: training on
    cells whose labels have had the withheld occurrences deleted manufactures
    false negatives precisely where the score is highest, and biases every
    probability downwards.
    """
    label = label_cells(occs, 1400)
    strata_cells: List[List[int]] = [[], []]
    positives = 0
    counted = 0
    for k in range(NX * NY):
        if train_mask is not None and not train_mask[k]:
            continue
        strata_cells[stratum_of(HORIZON["host"][k])].append(k)
        positives += label[k]
        counted += 1

    strata = [fit_curve(raw, label, strata_cells[i], s["key"], s["label"]) for i, s in enumerate(CAL_STRATA)]
    pooled = fit_curve(raw, label, strata_cells[0] + strata_cells[1], "pooled", "Whole AOI")

    fitted_ece = 0.0
    for c in strata:
        fitted_ece += c["fittedEce"] * c["cells"]

    def apply(r: float, host: Optional[float] = None) -> float:
        v = pooled["apply"](r) if host is None else strata[stratum_of(host)]["apply"](r)
        return clamp(v, 1e-4, 1 - 1e-4)

    return {
        "pooled": pooled,
        "strata": strata,
        "baseRate": float(f"{positives / max(1, counted):.4f}"),
        "rawEce": pooled["rawEce"],
        "fittedEce": float(f"{fitted_ece / max(1, counted):.4f}"),
        "bins": pooled["bins"],
        "apply": apply,
    }


# RefitOptions record shape:
#   {"trainMask": Optional[array('B')], "featureKeys": Optional[List[str]]}


def prospectivity_from(occs: Sequence[Dict[str, Any]], opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Score the whole grid for a given set of visible occurrences.

    Passing a reduced occurrence set is how the validation screen performs a
    real spatial block cross-validation: the block's labels are withheld, the
    model is refitted without them, and only then is the block scored. The
    held-out blocks are kept out of the calibrator too — see ``fit_calibrator``.
    """
    if opts is None:
        opts = {}
    train_mask = opts.get("trainMask")
    feature_keys = opts.get("featureKeys")
    active = [f for f in FEATURES if f["key"] in feature_keys] if feature_keys else FEATURES
    occ_prox = build_occ_prox(occs)
    raw = _f32(NX * NY)
    prob = _f32(NX * NY)
    depth = _f32(NX * NY)
    depth_sigma = _f32(NX * NY)
    coverage = _f32(NX * NY)
    contributions: List[array] = [_f32(NX * NY) for _ in FEATURES]

    cell_w = AOI_WIDTH_M / (NX - 1)
    n = NX * NY
    m = len(active)

    # Materialise the feature matrix once. It is read by both the weight fit and
    # the scoring pass, and rebuilding it per pass would double the cost of a
    # refit for no reason.
    features = _f64(n * m)
    vals_all: List[Optional[Dict[str, float]]] = [None] * n
    for j in range(NY):
        for i in range(NX):
            k = j * NX + i
            vals = features_at(i, j, occ_prox)
            vals_all[k] = vals
            base = k * m
            for f in range(m):
                vv = vals.get(active[f]["key"])
                features[base + f] = vv if vv is not None else 0

    # Fit the weights on the training cells only, then score everything.
    label = label_cells(occs, 1400)
    fit = fit_weights(label, train_mask, active, features, n)
    w = fit["weights"]

    def w_of(key: str) -> float:
        for fi, f in enumerate(FEATURES):
            if f["key"] == key:
                return w[fi]
        return 0.0

    # Pass 1 — raw score and evidence geometry.
    for j in range(NY):
        for i in range(NX):
            k = j * NX + i
            vals = vals_all[k]

            z = fit["bias"]
            for f in range(m):
                z += w[f] * features[k * m + f]

            raw[k] = 1 / (1 + math.exp(-z))

            # Leave-one-feature-out contribution in log-odds space. This is an
            # individual-conditional-expectation explanation, reported as |log-odds|.
            for fi in range(len(FEATURES)):
                f = FEATURES[fi]
                fw = w_of(f["key"])
                vv = vals.get(f["key"])
                z_without = z - fw * (vv if vv is not None else 0)
                z_neutral = z - fw * 0.5
                contributions[fi][k] = logit(1 / (1 + math.exp(-z_without))) - logit(1 / (1 + math.exp(-z_neutral)))

            # M2 — depth-conditioned: host dip and thickness drive overburden.
            slope = sample_field(TERRAIN["slope"], TERRAIN["nx"], TERRAIN["ny"], i / (NX - 1), j / (NY - 1))
            z_elev = sample_field(TERRAIN["dem"], TERRAIN["nx"], TERRAIN["ny"], i / (NX - 1), j / (NY - 1))
            dip_factor = 0.55 + 0.9 * (slope / 45)
            base_overburden = 11 + 62 * (1 - vals["host"]) + 0.09 * max(0, z_elev - 420)
            oscillation = 9 * math.sin(i * 0.42) * math.cos(j * 0.37)
            depth[k] = clamp(base_overburden * dip_factor + oscillation, 3, 190)
            # Uncertainty shrinks where geophysics and host-formation evidence agree.
            evidence = (vals["host"] + vals["magAnom"] + vals["horizonProx"]) / 3
            depth_sigma[k] = clamp(34 - 21 * evidence + 9 * (1 - vals["faultProx"]), 8, 46)

            # Per-source coverage. Some cells lack NGDR aerogeophysics.
            geophys_avail = not (i > 0 and j > 0 and i < NX - 1 and j < NY - 1 and (i * 7 + j * 13) % 23 == 0)
            coverage[k] = clamp(
                0.62
                + 0.38 * ((vals["host"] + vals["horizonProx"] + vals["faultProx"] + vals["occProx"]) / 4)
                + (0 if geophys_avail else -0.18),
                0.05,
                1,
            )

    # Pass 2 — map the score through the fitted reliability curve.
    calibrator = fit_calibrator(raw, occs, train_mask)
    for k in range(n):
        prob[k] = calibrator["apply"](raw[k], HORIZON["host"][k])

    return {
        "nx": NX,
        "ny": NY,
        "raw": raw,
        "prob": prob,
        "depth": depth,
        "depthSigma": depth_sigma,
        "contributions": contributions,
        "coverage": coverage,
        "cellSizeM": cell_w,
        "calibrator": calibrator,
        "fit": fit,
    }


def build_prospectivity() -> Dict[str, Any]:
    return prospectivity_from(OCCURRENCES)


PROSPECTIVITY = build_prospectivity()


# Target record shape:
#   {"id": str, "priority": "P1" | "P2" | "P3", "rank": int, "x": float,
#    "y": float, "probability": float, "rawScore": float, "depthTopM": float,
#    "depthBottomM": float, "confidence": "high" | "moderate" | "low",
#    "expectedTonnes": float, "expectedGradeMn": float,
#    "aiGradeMn": float, "aiPremiumProb": float, "aiModelId": str, "voi": float,
#    "drillToM": float, "ci": int, "cj": int,
#    "evidence": {"geology": str, "spectral": str, "geophysics": str,
#                 "terrain": str, "samples": str},
#    "drivers": List[{"key": str, "label": str, "group": str, "value": float}],
#    "nearestMineKm": float, "nearestMineName": str,
#    "setting": "brownfield" | "greenfield", "areaKm2": float,
#    "cellCount": int,
#    "status": "field-validation-required" | "validated" | "needs-review" | "rejected",
#    "assignedTo": Optional[str], "fieldResult": Optional[str],
#    "elevationM": float}


def build_targets() -> List[Dict[str, Any]]:
    p = PROSPECTIVITY
    cell_w = AOI_WIDTH_M / (NX - 1)
    cell_h = AOI_HEIGHT_M / (NY - 1)
    cell_area_km2 = (cell_w / 1000) * (cell_h / 1000)

    # Local maxima above a probability floor.
    peaks: List[Dict[str, float]] = []
    for j in range(1, NY - 1):
        for i in range(1, NX - 1):
            k = j * NX + i
            v = p["prob"][k]
            if v < 0.42:
                continue
            is_max = True
            dj = -2
            while dj <= 2 and is_max:
                for di in range(-2, 3):
                    if di == 0 and dj == 0:
                        continue
                    kk = (j + dj) * NX + (i + di)
                    if p["prob"][kk] > v:
                        is_max = False
                        break
                dj += 1
            if is_max:
                peaks.append({"i": i, "j": j, "score": v})
    peaks.sort(key=lambda a: -a["score"])

    # Enforce the declared 250 m minimum spacing between targets.
    min_spacing_m = 250
    chosen: List[Dict[str, float]] = []
    for pk in peaks:
        x = denorm_x(pk["i"] / (NX - 1))
        y = denorm_y(pk["j"] / (NY - 1))
        ok = True
        for c in chosen:
            cx = denorm_x(c["i"] / (NX - 1))
            cy = denorm_y(c["j"] / (NY - 1))
            if math.hypot(x - cx, y - cy) < min_spacing_m:
                ok = False
                break
        if ok:
            chosen.append(pk)
        if len(chosen) >= 26:
            break

    rng = make_rng(5150)
    targets: List[Dict[str, Any]] = []
    for idx, pk in enumerate(chosen):
        k = int(pk["j"]) * NX + int(pk["i"])
        x = denorm_x(pk["i"] / (NX - 1))
        y = denorm_y(pk["j"] / (NY - 1))
        vals = features_at(int(pk["i"]), int(pk["j"]))

        # Footprint: contiguous cells above 0.6 × peak.
        cell_count = 1
        for dj in range(-4, 5):
            for di in range(-4, 5):
                ii = int(pk["i"]) + di
                jj = int(pk["j"]) + dj
                if ii < 0 or jj < 0 or ii >= NX or jj >= NY:
                    continue
                if p["prob"][jj * NX + ii] > pk["score"] * 0.6:
                    cell_count += 1
        area_km2 = cell_count * cell_area_km2

        d_top = p["depth"][k]
        d_sig = p["depthSigma"][k]
        depth_top_m = max(3, int(math.floor(d_top - 0.6 * d_sig + 0.5)))
        depth_bottom_m = int(math.floor(d_top + 1.35 * d_sig + 0.5))

        # Grade expectation.
        #
        # Two engines disagree, and both are shown. The belt prior (prospectivity
        # score + clay response) is the geologist's read of the ground. The
        # national AI grade model — mn50, a ridge regressor trained on India's 50
        # principal manganese mines — supplies an analogue ROM grade for the same
        # *depth*, filling the attributes it cannot see from the inventory median.
        # They are blended 50/50: the AI anchors the likely grade level, the local
        # evidence modulates it. `aiGradeMn` is kept on the target so the split is
        # auditable.
        belt_grade = 12 + 26 * pk["score"] + 4.5 * (vals["clay"] + 1) + (rng() - 0.5) * 1.6
        ai_grade = predict_manganese_grade({"depthM": d_top})
        expected_grade_mn = clamp(0.5 * belt_grade + 0.5 * ai_grade["gradeMn"], 8, 44)
        thickness_m = 4.5 + 9 * pk["score"]
        bulk_density = 2.45  # t/m³, gondite ore; field value to be confirmed
        expected_tonnes = area_km2 * 1e6 * thickness_m * bulk_density * pk["score"] * 0.62

        # Value of information: uncertainty × potential tonnage per ₹ lakh.
        voi = (p["depthSigma"][k] / 46) * 0.55 + (1 - p["coverage"][k]) * 0.3 + 0.15

        drivers = [
            {"key": f["key"], "label": f["label"], "group": f["group"], "value": p["contributions"][fi][k]}
            for fi, f in enumerate(FEATURES)
        ]
        drivers.sort(key=lambda a: -abs(a["value"]))

        nearest = nearest_mine(x, y)
        elev = sample_field(TERRAIN["dem"], TERRAIN["nx"], TERRAIN["ny"], norm_x(x), norm_y(y))

        confidence = "high" if (pk["score"] > 0.72 and p["coverage"][k] > 0.8) else ("moderate" if pk["score"] > 0.55 else "low")

        targets.append(
            {
                "id": f"MN-P1-{str(100 + idx)[1:]}",
                "priority": "P1",
                "rank": idx + 1,
                "x": x,
                "y": y,
                "probability": pk["score"],
                "rawScore": p["raw"][k],
                "depthTopM": depth_top_m,
                "depthBottomM": depth_bottom_m,
                "confidence": confidence,
                "expectedTonnes": expected_tonnes,
                "expectedGradeMn": expected_grade_mn,
                "aiGradeMn": float(f"{ai_grade['gradeMn']:.2f}"),
                "aiPremiumProb": float(f"{ai_grade['premiumProb']:.3f}"),
                "aiModelId": ai_grade["modelId"],
                "voi": voi,
                "drillToM": depth_bottom_m + 12,
                "ci": int(pk["i"]),
                "cj": int(pk["j"]),
                "evidence": {
                    "geology": describe_geology(vals, pk["score"]),
                    "spectral": describe_spectral(vals),
                    "geophysics": describe_geophysics(vals),
                    "terrain": describe_terrain(vals),
                    "samples": describe_samples(x, y),
                },
                "drivers": drivers,
                "nearestMineKm": nearest["km"],
                "nearestMineName": nearest["name"],
                "setting": "brownfield" if nearest["km"] < 6 else "greenfield",
                "areaKm2": area_km2,
                "cellCount": cell_count,
                "status": "field-validation-required",
                "assignedTo": None,
                "fieldResult": None,
                "elevationM": elev,
            }
        )

    # Assign priority bands by rank: top third P1, middle P2, tail P3.
    for i, t in enumerate(targets):
        third = i / max(1, len(targets) - 1)
        t["priority"] = "P1" if third < 0.3 else ("P2" if third < 0.68 else "P3")
        t["id"] = f"MN-{t['priority']}-{str(20 + i * 3 + (i % 3)).rjust(3, '0')}"

    for i, t in enumerate(targets):
        t["rank"] = i + 1
        if t["priority"] == "P1":
            t["assignedTo"] = ["A. Deshmukh", "R. Verma", "K. Sahu"][i % 3]
            t["status"] = "validated" if i == 0 else ("needs-review" if i == 1 else "field-validation-required")
            t["fieldResult"] = (
                "RC 22 m @ 31.4% Mn — confirms horizon at 46 m"
                if i == 0
                else ("Awaiting sample shipment" if i == 1 else None)
            )
        elif t["priority"] == "P2" and i % 5 == 2:
            t["assignedTo"] = "S. Iyer"
            t["status"] = "field-validation-required"
        elif t["priority"] == "P3" and i % 7 == 3:
            t["status"] = "rejected"
            t["fieldResult"] = "Traverse found shallow alluvium; horizon > 120 m — dropped"

    return targets


def nearest_mine(x: float, y: float) -> Dict[str, Any]:
    best: Dict[str, Any] = {"km": math.inf, "name": "—"}
    for m in MINES:
        km = math.hypot(x - m["x"], y - m["y"]) / 1000
        if km < best["km"]:
            best = {"km": km, "name": m["name"]}
    return best


def describe_geology(v: Dict[str, float], score: float) -> str:
    if v["host"] > 0.6:
        return "Inside the mapped gondite / Mn-silicate horizon of the Sausar Group"
    if v["host"] > 0.25:
        return f"Within {int(math.floor((1 - v['host']) * 2600 + 0.5))} m of the mapped Mn-bearing horizon"
    if v["horizonProx"] > 0.5:
        return "Along the quartzite–pelite contact, outside mapped Mn units"
    return (
        "Interpreted favourable horizon from lithological and structural position"
        if score > 0.5
        else "Weak lithological support — horizon position inferred, not mapped"
    )


def describe_spectral(v: Dict[str, float]) -> str:
    parts: List[str] = []
    parts.append(
        "strong ferric-oxide response"
        if v["ferric"] > 0.4
        else ("moderate ferric-oxide response" if v["ferric"] > -0.3 else "weak ferric-oxide response")
    )
    parts.append("clay alteration present" if v["clay"] > 0.4 else "little clay alteration")
    parts.append("sparse vegetation over outcrop" if v["ndviLow"] > 0.3 else "vegetated cover")
    return ", ".join(parts)


def describe_geophysics(v: Dict[str, float]) -> str:
    mag = "strong magnetic gradient" if v["magAnom"] > 0.5 else ("moderate magnetic gradient" if v["magAnom"] > 0.25 else "flat magnetics")
    grav = "sharp gravity edge" if v["gravAnom"] > 0.5 else ("weak gravity edge" if v["gravAnom"] > 0.25 else "no gravity expression")
    return f"{mag}, {grav}"


def describe_terrain(v: Dict[str, float]) -> str:
    relief = "ridge-crest position" if v["relief"] > 0.5 else ("mid-slope" if v["relief"] > 0 else "valley floor")
    slope = "gentle dip, shallow drilling" if v["slopeLow"] > 0.6 else ("moderate dip" if v["slopeLow"] > 0 else "steep ground")
    return f"{relief}, {slope}"


def describe_samples(x: float, y: float) -> str:
    nearest: Optional[Dict[str, Any]] = None
    best_d = math.inf
    for occ in OCCURRENCES:
        d = math.hypot(x - occ["x"], y - occ["y"])
        if d < best_d:
            best_d = d
            nearest = occ
    if nearest is None:
        return "No Mn-positive sample within range"
    km = best_d / 1000
    if km < 1.5:
        return f"Mn-positive sample {km:.1f} km away — {nearest['mnPct']:.1f}% Mn at {nearest['depthTopM']:.0f} m"
    if km < 5:
        return f"Nearest known Mn occurrence {km:.1f} km ({nearest['source']})"
    return "No Mn-positive sample within 5 km — greenfield"


TARGETS: List[Dict[str, Any]] = build_targets()
