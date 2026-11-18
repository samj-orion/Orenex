import { AOI_HEIGHT_M, AOI_WIDTH_M, denormX, denormY, normX, normY } from './geo';
import { clamp, makeFbm, makeNoise2D, makeRidged, sampleField, smoothstep } from './noise';
import { makeRng } from './rng';
import { GEO_UNITS, MINES, OCCURRENCES, STRUCTURES, TERRAIN, distToPath, distToRing } from './geology';
import { MANGANESE_PREDICTOR } from './manganeseModel';

/**
 * M1 — Manganese prospectivity (greenfield).
 *
 * Positive-unlabelled learning: known occurrences are positives, everything
 * else is *unlabelled*, not negative. The scoring surface below is a logistic
 * model over the same feature set the architecture lists, with weights taken
 * from the documented geology prior (host-formation membership and distance to
 * mapped Mn horizons dominate). Explanations are produced by leave-one-feature
 * ablation in log-odds space, which is what the SHAP panel reports.
 */

export const NX = 132; // 132 × 30 m ≈ 3.96 km tiles → 4 km blocks
export const NY = 118;

export interface FeatureDef {
  key: string;
  label: string;
  group: 'geology' | 'geophysics' | 'spectral' | 'terrain' | 'environment';
  weight: number;
  unit: string;
  /** Human-readable meaning, shown in the evidence panel. */
  note: string;
}

export const FEATURES: FeatureDef[] = [
  {
    key: 'host',
    label: 'Host-formation membership',
    group: 'geology',
    weight: 2.15,
    unit: '0–1',
    note: 'Distance to the nearest Sausar Group gondite / Mn-silicate horizon.',
  },
  {
    key: 'horizonProx',
    label: 'Proximity to mapped Mn horizon',
    group: 'geology',
    weight: 1.62,
    unit: '0–1',
    note: 'Inverse distance to mapped Mn-bearing units within the belt.',
  },
  {
    key: 'faultProx',
    label: 'Fault / lineament intersection',
    group: 'geology',
    weight: 1.05,
    unit: '0–1',
    note: 'Structural channelisation — ore fluids follow high-angle structures.',
  },
  {
    key: 'magAnom',
    label: 'Magnetic high–low transition',
    group: 'geophysics',
    weight: 0.92,
    unit: 'σ',
    note: 'Reduced-to-pole residual at the margin of the BIF–pelite contact.',
  },
  {
    key: 'gravAnom',
    label: 'Gravity residual gradient',
    group: 'geophysics',
    weight: 0.61,
    unit: 'mGal',
    note: 'Edges at the ferruginous cover over the ore-bearing horizon.',
  },
  {
    key: 'ferric',
    label: 'Ferric iron band ratio',
    group: 'spectral',
    weight: 0.74,
    unit: 'σ',
    note: 'Sentinel-2 B4/B2 style ratio — surface Mn–Fe oxide expressions.',
  },
  {
    key: 'clay',
    label: 'Clay / alteration index',
    group: 'spectral',
    weight: 0.48,
    unit: 'σ',
    note: 'Short-wave infrared clay-mineral signature over altered host.',
  },
  {
    key: 'ndviLow',
    label: 'Low vegetation response',
    group: 'spectral',
    weight: 0.53,
    unit: 'σ',
    note: 'Sparse cover on outcrop horizons versus vegetated alluvium.',
  },
  {
    key: 'relief',
    label: 'Ridge-gully position',
    group: 'terrain',
    weight: 0.4,
    unit: 'σ',
    note: 'Eroded ridge crests expose the horizon; TPI plus drainage density.',
  },
  {
    key: 'slopeLow',
    label: 'Gentle dip slope',
    group: 'terrain',
    weight: 0.28,
    unit: 'σ',
    note: 'Shallow-dipping host is easier to evaluate and to drill.',
  },
  {
    key: 'soilWet',
    label: 'Soil moisture anomaly',
    group: 'environment',
    weight: -0.22,
    unit: 'σ',
    note: 'Standing moisture and alluvial cover depress surface expression.',
  },
  {
    key: 'occProx',
    label: 'Known-occurrence clustering',
    group: 'geology',
    weight: 0.83,
    unit: '0–1',
    note: 'Density of Mn-positive drill intervals within 2 km.',
  },
];

export interface CalCurve {
  key: string;
  label: string;
  /** Prior event rate of the training labels for this stratum. */
  baseRate: number;
  /** Raw-score midpoints of the pooled isotonic blocks, ascending. */
  x: Float64Array;
  /** Fitted probability at those midpoints — non-decreasing by construction. */
  y: Float64Array;
  /** Reliability of the uncalibrated score, in-sample ECE. */
  rawEce: number;
  /** Reliability after the fit, in-sample ECE. */
  fittedEce: number;
  /** Quantile bins used by the fit. */
  bins: number;
  cells: number;
  positives: number;
  apply(raw: number): number;
}

export interface Calibrator {
  /** Whole-AOI curve, used when no stratum is supplied. */
  pooled: CalCurve;
  /** Per-stratum curves, chosen by host-formation membership. */
  strata: CalCurve[];
  /** Prior event rate of the training labels. */
  baseRate: number;
  /** Reliability of the uncalibrated score, in-sample ECE. */
  rawEce: number;
  /** Cell-weighted reliability after the fit, in-sample ECE. */
  fittedEce: number;
  bins: number;
  /** `host` is host-formation membership in [0,1]; omit for the pooled curve. */
  apply(raw: number, host?: number): number;
}

export interface ProspectivityField {
  nx: number;
  ny: number;
  /** Raw logistic output before calibration, 0–1. */
  raw: Float32Array;
  /** Isotonic-calibrated P(Mn), 0–1. */
  prob: Float32Array;
  /** Predicted top-of-mineralisation depth, m. */
  depth: Float32Array;
  /** Predicted depth 80% interval half-width, m. */
  depthSigma: Float32Array;
  /** Per-feature contribution to log-odds, length = FEATURES.length × cells. */
  contributions: Float32Array[];
  /** Fraction of features with data for this cell. */
  coverage: Float32Array;
  cellSizeM: number;
  /** The reliability curve the probabilities were mapped through. */
  calibrator: Calibrator;
  /** What the weight estimator did on this refit, for the model card. */
  fit: WeightFit;
}

// ── Synthetic observation layers (stand-ins for the real satellite feeds) ──
//
// These are not decorative noise. A banded iron formation is magnetic, a ferric
// gossan weathers to haematite and goethite that show up in the Sentinel-2
// red/blue ratio, and a clay alteration halo has a short-wave-infrared
// signature. So each layer is the geological field sampled at that wavelength,
// plus the survey texture a real instrument has. The layers are *derived from*
// mapped geology rather than independent of it, which is the only reason a
// multi-layer model can beat a geology-only one — otherwise the extra inputs
// would be noise that dilutes the signal.

function buildRemoteSensing() {
  const nx = TERRAIN.nx;
  const ny = TERRAIN.ny;
  const magN = makeRidged(1201, 4);
  const magF = makeFbm(1307, 5);
  const grav = makeFbm(1447, 4, 2.1, 0.55);
  const band = makeNoise2D(1511);
  const band2 = makeNoise2D(1613);

  const mag = new Float32Array(nx * ny);
  const gravA = new Float32Array(nx * ny);
  const ferric = new Float32Array(nx * ny);
  const clay = new Float32Array(nx * ny);
  const ndvi = new Float32Array(nx * ny);
  const lst = new Float32Array(nx * ny);
  const soil = new Float32Array(nx * ny);

  // Rock properties aggregated over the mapped units, plus a soft contact
  // response — the survey sees the edge, not the unit.
  const unitField = new Float32Array(nx * ny);
  const contactField = new Float32Array(nx * ny);
  const coverField = new Float32Array(nx * ny);
  const susField = new Float32Array(nx * ny);
  const denField = new Float32Array(nx * ny);
  const clayHalo = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = denormY(j / (ny - 1));
    for (let i = 0; i < nx; i++) {
      const x = denormX(i / (nx - 1));
      let dHost = Infinity;
      let dCover = Infinity;
      // The magnetic source is the ferruginous sequence — gondite, Mn-silicate
      // and the banded iron formation it intergrades with. Selecting only the
      // BIF would put the magnetic edge somewhere else on the ground entirely,
      // because the BIF bands and the Mn-bearing bands are not coincident.
      let dMagnetic = Infinity;
      for (const unit of GEO_UNITS) {
        const d = distToRing(x, y, unit.ring);
        if (unit.favourable && d < dHost) dHost = d;
        if (unit.cover && d < dCover) dCover = d;
        if (unit.susceptibility >= 0.015 && d < dMagnetic) dMagnetic = d;
      }
      const k = j * nx + i;
      const hostNear = 1 - smoothstep(0, 1800, dHost);
      unitField[k] = hostNear;
      coverField[k] = 1 - smoothstep(0, 1500, dCover);
      // Peak at ~1.2 km from the horizon trace: the contact, not the interior.
      contactField[k] = 1 - Math.abs(1 - smoothstep(0, 2400, dHost) * 2);
      // Airborne magnetometry sees through cover; ground truth degrades under
      // a laterite blanket, which is why the ferric term has to be read with it.
      const look = 1 - 0.35 * coverField[k];
      susField[k] = (0.015 + 0.85 * (1 - smoothstep(0, 2400, dMagnetic))) * look;
      denField[k] = 2.67 + 0.9 * (hostNear - 0.5) * look;
      // Hydrothermal alteration sits just outside the ore body.
      clayHalo[k] = (1 - Math.abs(1 - smoothstep(0, 2600, dHost) * 2)) * 0.7;
    }
  }

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const u = i / (nx - 1);
      const v = j / (ny - 1);
      const k = j * nx + i;
      const unit = unitField[k];
      const contact = contactField[k];
      const cover = coverField[k];

      // Airborne magnetic residual, reduced to pole, in nT about the regional
      // mean. BIF/gondite response over the horizon, basement to the south,
      // survey noise on top. Dynamic range is kept realistic (~±80 nT) because
      // the model's edge detector is scaled by this field's own SD.
      const bandCoord = v - (0.44 + 0.2 * (u - 0.5));
      mag[k] = clamp(
        120 * susField[k] + 26 * contact - 18 * cover + 22 * Math.cos(bandCoord * 7.4) + 11 * magN(u * 3.6, v * 3.6) + 8 * magF(u * 8, v * 8),
        -140,
        140,
      );
      // Bouguer gravity: the horizon is denser than the metapelites it sits in.
      gravA[k] = clamp(0.44 + 0.4 * (denField[k] - 2.62) + 0.09 * band(u * 2.2, v * 2.2) + 0.08 * grav(u * 4.4, v * 4.4), 0, 1);
      // Sentinel-2 red/blue ferric ratio. Cover suppresses it — the signal is
      // surface oxidation, so a laterite blanket hides the outcrop.
      ferric[k] = clamp(0.4 + 0.3 * unit + 0.12 * contact - 0.14 * cover + 0.1 * band(u * 5.3 + 3.1, v * 5.3) + 0.06 * band2(u * 11, v * 11), 0, 1);
      // Short-wave infrared clay signature: the alteration halo, at the margin.
      clay[k] = clamp(0.42 + 0.24 * clayHalo[k] - 0.1 * unit + 0.12 * band2(u * 4.1, v * 4.1 + 2.2) + 0.07 * band(u * 9.3, v * 9.3), 0, 1);
      // Vegetation follows cover and moisture, not rock.
      ndvi[k] = clamp(0.3 + 0.34 * cover - 0.12 * unit + 0.13 * band2(u * 3.4 + 8, v * 3.4) - 0.05 * magF(u * 6.6, v * 6.6), 0, 1);
      // LST: bare ferric rock runs hot in the dry season, vegetation does not.
      lst[k] = clamp(0.42 + 0.36 * ferric[k] - 0.22 * ndvi[k], 0, 1);
      // Soil moisture tracks cover and drainage, not ore.
      soil[k] = clamp(0.42 + 0.24 * (1 - ndvi[k]) + 0.12 * cover + 0.1 * band(u * 7.7 + 5, v * 7.7), 0, 1);
    }
  }
  return { mag, grav: gravA, ferric, clay, ndvi, lst, soil };
}

export const REMOTE = buildRemoteSensing();

/**
 * Distance to the nearest mapped Mn-bearing unit, precomputed on the analysis
 * grid. Depends only on mapped geology, so it is shared by every refit.
 */
function buildHorizonField(): { prox: Float32Array; host: Float32Array; nx: number; ny: number } {
  const nx = NX;
  const ny = NY;
  const prox = new Float32Array(nx * ny);
  const host = new Float32Array(nx * ny);
  const favourable = GEO_UNITS.filter((u) => u.favourable);

  for (let j = 0; j < ny; j++) {
    const y = denormY(j / (ny - 1));
    for (let i = 0; i < nx; i++) {
      const x = denormX(i / (nx - 1));
      const k = j * nx + i;
      let dHost = Infinity;
      let dHorizon = Infinity;
      for (const unit of favourable) {
        const d = distToRing(x, y, unit.ring);
        if (d < dHost) dHost = d;
        if (d < dHorizon) dHorizon = d;
      }
      host[k] = 1 - smoothstep(0, 2600, dHost);
      prox[k] = 1 - smoothstep(0, 4200, dHorizon);
    }
  }
  return { prox, host, nx, ny };
}

const HORIZON = buildHorizonField();

/**
 * Known-occurrence clustering from a *given* occurrence list.
 *
 * This is the only feature that depends on labels, so it is what the spatial
 * block CV has to withhold. Refitting with a district's occurrences removed is
 * the whole point of that test — a model scored on occurrences it can see is
 * measuring nothing.
 */
function buildOccProx(occs: typeof OCCURRENCES): Float32Array {
  const dens = new Float32Array(NX * NY);
  for (let j = 0; j < NY; j++) {
    const y = denormY(j / (NY - 1));
    for (let i = 0; i < NX; i++) {
      const x = denormX(i / (NX - 1));
      let acc = 0;
      for (const occ of occs) {
        const d = Math.hypot(x - occ.x, y - occ.y);
        if (d < 2000) acc += 1 - d / 2000;
      }
      dens[j * NX + i] = acc;
    }
  }
  // Smooth so the term describes a neighbourhood, not a point marker.
  const sm = new Float32Array(NX * NY);
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      let acc = 0;
      let n = 0;
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= NX || jj >= NY) continue;
          acc += dens[jj * NX + ii];
          n++;
        }
      }
      sm[j * NX + i] = acc / n;
    }
  }
  return sm;
}

/**
 * Distribution of a field over the whole AOI, measured rather than assumed.
 *
 * Hard-coding the mean and SD of a synthetic layer is how a feature ends up
 * 100% clipped at its z-score bound — at which point it is a constant plus
 * noise and carries no information at all. Every normalisation below uses the
 * measured statistics of the field it normalises.
 */
function fieldStats(a: Float32Array): { mean: number; sd: number } {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i];
  const mean = sum / a.length;
  let sq = 0;
  for (let i = 0; i < a.length; i++) sq += (a[i] - mean) ** 2;
  return { mean, sd: Math.sqrt(sq / a.length) || 1 };
}

function stdNorm(v: number, mean: number, sd: number): number {
  return clamp((v - mean) / (sd || 1), -3, 3);
}

export const STATS = {
  ferric: fieldStats(REMOTE.ferric),
  clay: fieldStats(REMOTE.clay),
  ndvi: fieldStats(REMOTE.ndvi),
  soil: fieldStats(REMOTE.soil),
  mag: fieldStats(REMOTE.mag),
  grav: fieldStats(REMOTE.grav),
  slope: fieldStats(TERRAIN.slope),
  tpi: fieldStats(TERRAIN.tpi),
};

/**
 * Absolute value of a central difference, expressed in units of the field's own
 * standard deviation. Used for the geophysical edge terms: ore sits at the
 * margin of a magnetic high, so the gradient is the signal, not the amplitude.
 */
function edgeResponse(a: Float32Array, u: number, v: number, stepUv: number, sd: number): number {
  const d =
    sampleField(a, TERRAIN.nx, TERRAIN.ny, Math.min(0.999, u + stepUv), v) -
    sampleField(a, TERRAIN.nx, TERRAIN.ny, Math.max(0.001, u - stepUv), v);
  return Math.abs(d) / (2 * stepUv * sd);
}

/**
 * Geophysical edge strength, precomputed on the analysis grid.
 *
 * A survey gradient is only interpretable relative to the rest of the survey, so
 * the edge is ramped between the district's own median and its 97th percentile.
 * Hard-coded thresholds either saturate half the district or bury the contact;
 * deriving them from the measured distribution means the term always spans its
 * full range and always means the same thing wherever the survey is flown.
 */
function buildEdgeField(a: Float32Array, nx: number, ny: number, stepUv: number): Float32Array {
  const raw = new Float32Array(NX * NY);
  const sd = fieldStats(a).sd || 1;
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      raw[j * NX + i] = edgeResponse(a, i / (nx - 1), j / (ny - 1), stepUv, sd);
    }
  }
  const sorted = Float32Array.from(raw).sort();
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  const lo = p(0.35);
  const hi = p(0.97);
  const out = new Float32Array(NX * NY);
  for (let k = 0; k < out.length; k++) out[k] = clamp((raw[k] - lo) / Math.max(1e-9, hi - lo), 0, 1);
  return out;
}

const MAG_EDGE = buildEdgeField(REMOTE.mag, TERRAIN.nx, TERRAIN.ny, 0.012);
const GRAV_EDGE = buildEdgeField(REMOTE.grav, TERRAIN.nx, TERRAIN.ny, 0.012);

// ── Weight estimation ───────────────────────────────────────────────────────
//
// The weights above are a *prior* taken from the documented geology, not a fit.
// Hand-set weights are the right starting point and the wrong final answer: the
// layers are correlated with each other (host formation, magnetic edge and
// gravity edge all trace the same contact), and a fixed weight on a redundant
// feature buys no discrimination and costs variance. So the deployed model fits
// the weights by regularised PU logistic regression, anchored to the prior, and
// the block CV refits them per fold.

export interface WeightFit {
  /** Final weight per active feature, in FEATURES order; 0 for excluded ones. */
  weights: Float64Array;
  bias: number;
  iterations: number;
  /** Mean negative log-likelihood over the training cells, per refit. */
  loss: number;
  /** Mean |w − prior| — how far the fit moved from the documented geology. */
  drift: number;
}

const L2 = 0.06;
const L2_PRIOR = 2.4;
const PU_ALPHA = 0.9;
const FIT_ITERS = 140;

/**
 * Positive-unlabelled logistic regression by damped gradient descent.
 *
 * PU rather than supervised: an unlabelled cell is unlabelled, not negative. The
 * objective treats every unlabelled cell as a mix of hidden positives and true
 * negatives at rate `alpha`, which is the standard correction — without it the
 * model learns that most of the belt is barren and under-scores the contacts.
 */
function fitWeights(
  label: Uint8Array,
  trainMask: Uint8Array | undefined,
  active: FeatureDef[],
  features: Float64Array,
  n: number,
): WeightFit {
  const m = active.length;
  const w = new Float64Array(m);
  const prior = new Float64Array(m);
  active.forEach((f, i) => {
    w[i] = f.weight;
    prior[i] = f.weight;
  });
  let bias = BIAS;

  // Rows eligible for training.
  const rows: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k < n; k++) {
    if (trainMask && !trainMask[k]) continue;
    rows.push(k);
    ys.push(label[k]);
  }
  if (!rows.length || m === 0) {
    return { weights: weightsOf(active, w), bias, iterations: 0, loss: NaN, drift: 0 };
  }

  const gw = new Float64Array(m);
  let gb = 0;
  let loss = 0;
  const lr = 0.55;

  for (let it = 0; it < FIT_ITERS; it++) {
    gw.fill(0);
    gb = 0;
    loss = 0;
    for (let r = 0; r < rows.length; r++) {
      const k = rows[r];
      const base = k * m;
      let z = bias;
      for (let i = 0; i < m; i++) z += w[i] * features[base + i];
      const p = 1 / (1 + Math.exp(-z));

      let target: number;
      let coef: number;
      if (ys[r] === 1) {
        target = 1;
        coef = 1;
      } else {
        target = alphaMixed(ys[r], p, bias);
        coef = PU_ALPHA;
      }
      const d = (p - target) * coef;
      for (let i = 0; i < m; i++) gw[i] += d * features[base + i];
      gb += d;
      loss += -((ys[r] === 1 ? 1 : target) * Math.log(Math.max(1e-9, p)) + (ys[r] === 1 ? 0 : 1 - target) * Math.log(Math.max(1e-9, 1 - p)));
    }

    // Ridge, pulled toward the documented prior rather than toward zero: the
    // prior is real geological knowledge and should not be relearned from
    // scratch every refit, but neither should it be free to override the data.
    for (let i = 0; i < m; i++) {
      loss += (L2 * w[i] * w[i]) / 2 + (L2_PRIOR * (w[i] - prior[i]) ** 2) / 2;
      gw[i] += L2 * w[i] + L2_PRIOR * (w[i] - prior[i]);
    }
    loss += (L2 * bias * bias) / 2;
    gb += L2 * bias;

    const nInv = 1 / rows.length;
    const step = lr / (1 + it * 0.012);
    for (let i = 0; i < m; i++) w[i] -= step * (gw[i] * nInv + 0);
    bias -= step * gb * nInv;
    void loss;
  }

  let drift = 0;
  for (let i = 0; i < m; i++) drift += Math.abs(w[i] - prior[i]);
  drift /= Math.max(1, m);

  return { weights: weightsOf(active, w), bias, iterations: FIT_ITERS, loss: loss / rows.length, drift };
}

function weightsOf(active: FeatureDef[], w: Float64Array): Float64Array {
  const out = new Float64Array(FEATURES.length);
  active.forEach((f, i) => {
    const idx = FEATURES.indexOf(f);
    if (idx >= 0) out[idx] = w[i];
  });
  return out;
}

/** Elkan–Noto style PU label correction for an unlabelled cell. */
function alphaMixed(_y: number, p: number, bias: number): number {
  const priorP = 1 / (1 + Math.exp(-bias));
  const c = clamp(p * (1 - PU_ALPHA) / Math.max(1e-6, priorP * (1 - PU_ALPHA) + PU_ALPHA * p), 0, 1);
  return clamp(c, 0, 1);
}

export const BIAS = -1.72;

/** Feature vector for one analysis cell, against a given occurrence set. */
export function featuresAt(i: number, j: number, occProx?: Float32Array): Record<string, number> {
  const u = i / (NX - 1);
  const v = j / (NY - 1);
  const x = denormX(u);
  const y = denormY(v);
  const k = j * NX + i;

  const slope = sampleField(TERRAIN.slope, TERRAIN.nx, TERRAIN.ny, u, v);
  const tpi = sampleField(TERRAIN.tpi, TERRAIN.nx, TERRAIN.ny, u, v);
  const flow = sampleField(TERRAIN.flow, TERRAIN.nx, TERRAIN.ny, u, v);

  let dFault = Infinity;
  let dMappedFault = Infinity;
  for (const s of STRUCTURES) {
    const d = distToPath(x, y, s.path);
    if (d < dFault) dFault = d;
    if (s.mapped && d < dMappedFault) dMappedFault = d;
  }
  if (!Number.isFinite(dFault)) dFault = 40000;
  if (!Number.isFinite(dMappedFault)) dMappedFault = 40000;

  const ferric = sampleField(REMOTE.ferric, TERRAIN.nx, TERRAIN.ny, u, v);
  const clay = sampleField(REMOTE.clay, TERRAIN.nx, TERRAIN.ny, u, v);
  const ndvi = sampleField(REMOTE.ndvi, TERRAIN.nx, TERRAIN.ny, u, v);
  const soil = sampleField(REMOTE.soil, TERRAIN.nx, TERRAIN.ny, u, v);

  // The geophysics terms are edge detectors: the ore horizon sits at the
  // boundary of a magnetic high, so the gradient at ~1.5 km across the contact
  // is the evidence. Both are ramped against the survey's own distribution.
  return {
    host: HORIZON.host[k],
    horizonProx: HORIZON.prox[k],
    faultProx: (1 - smoothstep(0, 1800, dFault)) * 0.65 + (1 - smoothstep(0, 2600, dMappedFault)) * 0.35,
    magAnom: MAG_EDGE[k],
    gravAnom: GRAV_EDGE[k],
    ferric: stdNorm(ferric, STATS.ferric.mean, STATS.ferric.sd),
    clay: stdNorm(clay, STATS.clay.mean, STATS.clay.sd),
    ndviLow: stdNorm(1 - ndvi, 1 - STATS.ndvi.mean, STATS.ndvi.sd),
    relief: stdNorm(tpi, STATS.tpi.mean, STATS.tpi.sd) * 0.7 + flow * 0.3,
    slopeLow: stdNorm(18 - slope, 18 - STATS.slope.mean, STATS.slope.sd),
    soilWet: stdNorm(soil, STATS.soil.mean, STATS.soil.sd),
    occProx: occProx
      ? clamp(occProx[k] / 3.2, 0, 1)
      : 1 - smoothstep(0, 2000, occDistLocal(k)),
  };
}

function occDistLocal(k: number): number {
  // Reconstruct a distance proxy from the density field for the PU term.
  const dens = OCC_DENSITY[k];
  return dens <= 0 ? 9999 : 2000 * (1 - Math.min(1, dens / 3.2));
}

let OCC_DENSITY: Float32Array = (() => buildOccProx(OCCURRENCES))();

function logit(p: number): number {
  const q = clamp(p, 1e-4, 1 - 1e-4);
  return Math.log(q / (1 - q));
}

// ── Calibration ────────────────────────────────────────────────────────────
//
// A logistic score over hand-set weights is nowhere near a probability: it is
// spread over the whole range while the true event rate is ~11%. Hand-tuning a
// fixed affine log-odds transform to look better is how a model ends up
// confidently wrong. Instead the reliability curve is *fitted*, once, from the
// labels the model is actually allowed to see.

/** Cells whose centre lies within `radiusM` of a supplied occurrence. */
export function labelCells(occs: typeof OCCURRENCES, radiusM = 1400): Uint8Array {
  const label = new Uint8Array(NX * NY);
  const rx = Math.ceil(radiusM / (AOI_WIDTH_M / (NX - 1)));
  const ry = Math.ceil(radiusM / (AOI_HEIGHT_M / (NY - 1)));
  for (const o of occs) {
    const ci = Math.round(normX(o.x) * (NX - 1));
    const cj = Math.round(normY(o.y) * (NY - 1));
    for (let j = cj - ry; j <= cj + ry; j++) {
      if (j < 0 || j >= NY) continue;
      const cy = denormY(j / (NY - 1));
      for (let i = ci - rx; i <= ci + rx; i++) {
        if (i < 0 || i >= NX) continue;
        if (Math.hypot(denormX(i / (NX - 1)) - o.x, cy - o.y) < radiusM) label[j * NX + i] = 1;
      }
    }
  }
  return label;
}

/**
 * Pool-adjacent-violators: the minimum-adjustment non-decreasing least-squares
 * fit. Adjacent bins are merged whenever the fit would start decreasing, so the
 * result is monotone by construction — which means calibration cannot move a
 * single cell across another in the ranking, and AUC is untouched.
 */
function pava(xs: number[], ys: number[], ws: number[]): { x: number[]; y: number[] } {
  const bx: number[] = [];
  const by: number[] = [];
  const bw: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    let x = xs[i];
    let y = ys[i];
    let w = ws[i];
    while (by.length > 0 && by[by.length - 1] > y) {
      const px = bx.pop() as number;
      const py = by.pop() as number;
      const pw = bw.pop() as number;
      const tw = pw + w;
      x = (px * pw + x * w) / tw;
      y = (py * pw + y * w) / tw;
      w = tw;
    }
    bx.push(x);
    by.push(y);
    bw.push(w);
  }
  return { x: bx, y: by };
}

const CAL_BINS = 48;

/**
 * Calibration strata.
 *
 * A single global reliability curve cannot be right everywhere: the belt's base
 * rate inside the mapped Mn horizon is several times the rate over cover
 * sequences, so one curve is systematically conservative over the horizon and
 * optimistic off it. Fitting per stratum is the minimum that makes the
 * out-of-block numbers hold up.
 */
export const CAL_STRATA = [
  { key: 'in-horizon', label: 'Inside mapped Mn horizon', hostMin: 0.5 },
  { key: 'off-horizon', label: 'Cover sequences / off-horizon', hostMin: -1 },
];

const stratumOf = (host: number): number => (host >= CAL_STRATA[0].hostMin ? 0 : 1);

function eceOf(binX: number[], binY: number[], ws: number[], apply: (v: number) => number): number {
  const total = ws.reduce((s, w) => s + w, 0);
  if (!total) return 0;
  let err = 0;
  for (let i = 0; i < binX.length; i++) err += ws[i] * Math.abs(apply(binX[i]) - binY[i]);
  return err / total;
}

function fitCurve(raw: Float32Array, label: Uint8Array, cells: number[], key: string, labelText: string): CalCurve {
  cells.sort((a, b) => raw[a] - raw[b]);
  const n = cells.length;
  let positives = 0;
  for (const k of cells) positives += label[k];

  // Equal-count bins. Quantile edges are rounded rather than stepped so the
  // top bin is never a sliver — a 24-cell top bin that happens to be all
  // positives would drag the fitted curve to ~1.0 and flatten everything below.
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  for (let b = 0; b < CAL_BINS; b++) {
    const lo = Math.round((b * n) / CAL_BINS);
    const hi = Math.round(((b + 1) * n) / CAL_BINS);
    if (hi <= lo) continue;
    let sx = 0;
    let sy = 0;
    for (let t = lo; t < hi; t++) {
      sx += raw[cells[t]];
      sy += label[cells[t]];
    }
    // Laplace smoothing: without it a single miss in the top bin pins the
    // fitted curve at exactly 1.0.
    ys.push((sy + 1) / (hi - lo + 2));
    xs.push(sx / (hi - lo));
    ws.push(hi - lo);
  }

  const fit = pava(xs, ys, ws);
  const fx = Float64Array.from(fit.x);
  const fy = Float64Array.from(fit.y);
  const apply = (r: number): number => clamp(evalMonotone(fx, fy, r), 1e-4, 1 - 1e-4);

  return {
    key,
    label: labelText,
    baseRate: Number((positives / Math.max(1, n)).toFixed(4)),
    x: fx,
    y: fy,
    apply,
    rawEce: Number(eceOf(xs, ys, ws, (v) => v).toFixed(4)),
    fittedEce: Number(eceOf(xs, ys, ws, apply).toFixed(4)),
    bins: ws.length,
    cells: n,
    positives,
  };
}

/**
 * Fit the reliability curve P(Mn occurrence within 1.4 km | score).
 *
 * Isotonic regression on equal-count quantile bins of the raw score, fitted per
 * calibration stratum using only the occurrences handed to this refit.
 * `trainMask` restricts which cells may contribute, and the spatial block CV uses
 * it to keep the held-out block out of its own calibrator: training on cells
 * whose labels have had the withheld occurrences deleted manufactures false
 * negatives precisely where the score is highest, and biases every probability
 * downwards.
 */
export function fitCalibrator(raw: Float32Array, occs: typeof OCCURRENCES, trainMask?: Uint8Array): Calibrator {
  const label = labelCells(occs, 1400);
  const strataCells: number[][] = [[], []];
  let positives = 0;
  let counted = 0;
  for (let k = 0; k < NX * NY; k++) {
    if (trainMask && !trainMask[k]) continue;
    strataCells[stratumOf(HORIZON.host[k])].push(k);
    positives += label[k];
    counted++;
  }

  const strata = CAL_STRATA.map((s, i) => fitCurve(raw, label, strataCells[i], s.key, s.label));
  const pooled = fitCurve(raw, label, strataCells[0].concat(strataCells[1]), 'pooled', 'Whole AOI');

  return {
    pooled,
    strata,
    baseRate: Number((positives / Math.max(1, counted)).toFixed(4)),
    rawEce: pooled.rawEce,
    fittedEce: Number(
      (strata.reduce((s, c) => s + c.fittedEce * c.cells, 0) / Math.max(1, counted)).toFixed(4),
    ),
    bins: pooled.bins,
    apply: (r: number, host?: number): number =>
      clamp(host === undefined ? pooled.apply(r) : strata[stratumOf(host)].apply(r), 1e-4, 1 - 1e-4),
  };
}

/** Piecewise-linear read of a monotone ascending knot table, clamped at both ends. */
function evalMonotone(fx: Float64Array, fy: Float64Array, r: number): number {
  const last = fx.length - 1;
  if (r <= fx[0]) return fy[0];
  if (r >= fx[last]) return fy[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (fx[m] <= r) lo = m;
    else hi = m;
  }
  const span = fx[hi] - fx[lo];
  const t = span > 1e-12 ? (r - fx[lo]) / span : 0;
  return fy[lo] + t * (fy[hi] - fy[lo]);
}

export interface RefitOptions {
  /** Cells eligible to train the calibrator. The scored cells must be excluded. */
  trainMask?: Uint8Array;
  /**
   * Restrict the score to a subset of FEATURES keys — the data-contribution
   * ablation ladder. Contributions stay aligned to the full FEATURES list so a
   * chart can be read the same way whatever subset produced it.
   */
  featureKeys?: string[];
}

/**
 * Score the whole grid for a given set of visible occurrences.
 *
 * Passing a reduced occurrence set is how the validation screen performs a real
 * spatial block cross-validation: the block's labels are withheld, the model is
 * refitted without them, and only then is the block scored. The held-out blocks
 * are kept out of the calibrator too — see `fitCalibrator`.
 */
export function prospectivityFrom(occs: typeof OCCURRENCES, opts: RefitOptions = {}): ProspectivityField {
  const { trainMask, featureKeys } = opts;
  const active = featureKeys ? FEATURES.filter((f) => featureKeys.includes(f.key)) : FEATURES;
  const occProx = buildOccProx(occs);
  const raw = new Float32Array(NX * NY);
  const prob = new Float32Array(NX * NY);
  const depth = new Float32Array(NX * NY);
  const depthSigma = new Float32Array(NX * NY);
  const coverage = new Float32Array(NX * NY);
  const contributions: Float32Array[] = FEATURES.map(() => new Float32Array(NX * NY));

  const cellW = AOI_WIDTH_M / (NX - 1);
  const n = NX * NY;
  const m = active.length;

  // Materialise the feature matrix once. It is read by both the weight fit and
  // the scoring pass, and rebuilding it per pass would double the cost of a
  // refit for no reason.
  const features = new Float64Array(n * m);
  const valsAll: Record<string, number>[] = new Array(n);
  const occProxTmp = occProx;
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const k = j * NX + i;
      const vals = featuresAt(i, j, occProxTmp);
      valsAll[k] = vals;
      const base = k * m;
      for (let f = 0; f < m; f++) features[base + f] = vals[active[f].key] ?? 0;
    }
  }

  // Fit the weights on the training cells only, then score everything.
  const label = labelCells(occs, 1400);
  const fit = fitWeights(label, trainMask, active, features, n);
  const w = fit.weights;
  const wOf = (key: string): number => w[FEATURES.findIndex((f) => f.key === key)] ?? 0;

  // Pass 1 — raw score and evidence geometry.
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const k = j * NX + i;
      const vals = valsAll[k];

      let z = fit.bias;
      for (let f = 0; f < m; f++) z += w[f] * features[k * m + f];

      raw[k] = 1 / (1 + Math.exp(-z));

      // Leave-one-feature-out contribution in log-odds space. This is an
      // individual-conditional-expectation explanation, reported as |log-odds|.
      for (let fi = 0; fi < FEATURES.length; fi++) {
        const f = FEATURES[fi];
        const fw = wOf(f.key);
        const zWithout = z - fw * (vals[f.key] ?? 0);
        const zNeutral = z - fw * 0.5;
        contributions[fi][k] = logit(1 / (1 + Math.exp(-zWithout))) - logit(1 / (1 + Math.exp(-zNeutral)));
      }

      // M2 — depth-conditioned: host dip and thickness drive overburden.
      const slope = sampleField(TERRAIN.slope, TERRAIN.nx, TERRAIN.ny, i / (NX - 1), j / (NY - 1));
      const zElev = sampleField(TERRAIN.dem, TERRAIN.nx, TERRAIN.ny, i / (NX - 1), j / (NY - 1));
      const dipFactor = 0.55 + 0.9 * (slope / 45);
      const baseOverburden = 11 + 62 * (1 - vals.host) + 0.09 * Math.max(0, zElev - 420);
      const oscillation = 9 * Math.sin(i * 0.42) * Math.cos(j * 0.37);
      depth[k] = clamp(baseOverburden * dipFactor + oscillation, 3, 190);
      // Uncertainty shrinks where geophysics and host-formation evidence agree.
      const evidence = (vals.host + vals.magAnom + vals.horizonProx) / 3;
      depthSigma[k] = clamp(34 - 21 * evidence + 9 * (1 - vals.faultProx), 8, 46);

      // Per-source coverage. Some cells lack NGDR aerogeophysics.
      const geophysAvail = !(i > 0 && j > 0 && i < NX - 1 && j < NY - 1 && (i * 7 + j * 13) % 23 === 0);
      coverage[k] = clamp(0.62 + 0.38 * ((vals.host + vals.horizonProx + vals.faultProx + vals.occProx) / 4) + (geophysAvail ? 0 : -0.18), 0.05, 1);
    }
  }

  // Pass 2 — map the score through the fitted reliability curve.
  const calibrator = fitCalibrator(raw, occs, trainMask);
  for (let k = 0; k < n; k++) prob[k] = calibrator.apply(raw[k], HORIZON.host[k]);

  return { nx: NX, ny: NY, raw, prob, depth, depthSigma, contributions, coverage, cellSizeM: cellW, calibrator, fit };
}

export function buildProspectivity(): ProspectivityField {
  return prospectivityFrom(OCCURRENCES);
}

export const PROSPECTIVITY: ProspectivityField = buildProspectivity();

export interface Target {
  id: string;
  priority: 'P1' | 'P2' | 'P3';
  /** Rank after ranking all candidates. */
  rank: number;
  x: number;
  y: number;
  /** Calibrated P(Mn occurrence within 300 m). */
  probability: number;
  /** Raw model score before calibration — shown in the model card. */
  rawScore: number;
  depthTopM: number;
  depthBottomM: number;
  confidence: 'high' | 'moderate' | 'low';
  /** Expected contained Mn tonnes at the median grade and 80 m of vertical extent. */
  expectedTonnes: number;
  expectedGradeMn: number;
  /**
   * ROM grade (%) implied by the national **mn50 AI** grade model for this
   * target's predicted depth — the analogue-mine estimate, before it is blended
   * with the belt prior into `expectedGradeMn`.
   */
  aiGradeMn?: number;
  /** P(ROM grade ≥ premium threshold) from the mn50 AI classifier. */
  aiPremiumProb?: number;
  /** Registry id of the AI model that produced `aiGradeMn`. */
  aiModelId?: string;
  /** Value of information: expected reduction in uncertainty per ₹ lakh drilled. */
  voi: number;
  /** Recommended first-pass hole depth, m. */
  drillToM: number;
  /** Cell indices, so the detail panel can read the exact grid values. */
  ci: number;
  cj: number;
  /** Local evidence summary. */
  evidence: { geology: string; spectral: string; geophysics: string; terrain: string; samples: string };
  /** Ranked feature contributions for the explanation chart. */
  drivers: { key: string; label: string; group: string; value: number }[];
  /** Distance to nearest existing mine, km — informs brownfield vs greenfield. */
  nearestMineKm: number;
  nearestMineName: string;
  setting: 'brownfield' | 'greenfield';
  areaKm2: number;
  cellCount: number;
  status: 'field-validation-required' | 'validated' | 'needs-review' | 'rejected';
  assignedTo: string | null;
  fieldResult: string | null;
  elevationM: number;
}

function buildTargets(): Target[] {
  const p = PROSPECTIVITY;
  const cellW = AOI_WIDTH_M / (NX - 1);
  const cellH = AOI_HEIGHT_M / (NY - 1);
  const cellAreaKm2 = (cellW / 1000) * (cellH / 1000);

  // Local maxima above a probability floor.
  const peaks: { i: number; j: number; score: number }[] = [];
  for (let j = 1; j < NY - 1; j++) {
    for (let i = 1; i < NX - 1; i++) {
      const k = j * NX + i;
      const v = p.prob[k];
      if (v < 0.42) continue;
      let isMax = true;
      for (let dj = -2; dj <= 2 && isMax; dj++) {
        for (let di = -2; di <= 2; di++) {
          if (di === 0 && dj === 0) continue;
          const kk = (j + dj) * NX + (i + di);
          if (p.prob[kk] > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ i, j, score: v });
    }
  }
  peaks.sort((a, b) => b.score - a.score);

  // Enforce the declared 250 m minimum spacing between targets.
  const minSpacingM = 250;
  const chosen: { i: number; j: number; score: number }[] = [];
  for (const pk of peaks) {
    const x = denormX(pk.i / (NX - 1));
    const y = denormY(pk.j / (NY - 1));
    let ok = true;
    for (const c of chosen) {
      const cx = denormX(c.i / (NX - 1));
      const cy = denormY(c.j / (NY - 1));
      if (Math.hypot(x - cx, y - cy) < minSpacingM) {
        ok = false;
        break;
      }
    }
    if (ok) chosen.push(pk);
    if (chosen.length >= 26) break;
  }

  const rng = makeRng(5150);
  const targets: Target[] = chosen.map((pk, idx) => {
    const k = pk.j * NX + pk.i;
    const x = denormX(pk.i / (NX - 1));
    const y = denormY(pk.j / (NY - 1));
    const vals = featuresAt(pk.i, pk.j);

    // Footprint: contiguous cells above 0.6 × peak.
    let cellCount = 1;
    for (let dj = -4; dj <= 4; dj++) {
      for (let di = -4; di <= 4; di++) {
        const ii = pk.i + di;
        const jj = pk.j + dj;
        if (ii < 0 || jj < 0 || ii >= NX || jj >= NY) continue;
        if (p.prob[jj * NX + ii] > pk.score * 0.6) cellCount++;
      }
    }
    const areaKm2 = cellCount * cellAreaKm2;

    const dTop = p.depth[k];
    const dSig = p.depthSigma[k];
    const depthTopM = Math.max(3, Math.round(dTop - 0.6 * dSig));
    const depthBottomM = Math.round(dTop + 1.35 * dSig);

    // Grade expectation.
    //
    // Two engines disagree, and both are shown. The belt prior (prospectivity
    // score + clay response) is the geologist's read of the ground. The national
    // AI grade model — mn50, a ridge regressor trained on India's 50 principal
    // manganese mines — supplies an analogue ROM grade for the same *depth*,
    // filling the attributes it cannot see from the inventory median. They are
    // blended 50/50: the AI anchors the likely grade level, the local evidence
    // modulates it. `aiGradeMn` is kept on the target so the split is auditable.
    const beltGrade = 12 + 26 * pk.score + 4.5 * (vals.clay + 1) + (rng() - 0.5) * 1.6;
    const aiGrade = MANGANESE_PREDICTOR.predict({ depthM: dTop });
    const expectedGradeMn = clamp(0.5 * beltGrade + 0.5 * aiGrade.gradeMn, 8, 44);
    const thicknessM = 4.5 + 9 * pk.score;
    const bulkDensity = 2.45; // t/m³, gondite ore; field value to be confirmed
    const expectedTonnes = areaKm2 * 1e6 * thicknessM * bulkDensity * pk.score * 0.62;

    // Value of information: uncertainty × potential tonnage per ₹ lakh.
    const voi = (p.depthSigma[k] / 46) * 0.55 + (1 - p.coverage[k]) * 0.3 + 0.15;

    const drivers = FEATURES.map((f, fi) => ({
      key: f.key,
      label: f.label,
      group: f.group,
      value: p.contributions[fi][k],
    })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

    const nearest = nearestMine(x, y);
    const elev = sampleField(TERRAIN.dem, TERRAIN.nx, TERRAIN.ny, normX(x), normY(y));

    const confidence: Target['confidence'] =
      pk.score > 0.72 && p.coverage[k] > 0.8 ? 'high' : pk.score > 0.55 ? 'moderate' : 'low';

    return {
      id: `MN-P1-${String(100 + idx).slice(1)}`,
      priority: 'P1',
      rank: idx + 1,
      x,
      y,
      probability: pk.score,
      rawScore: p.raw[k],
      depthTopM,
      depthBottomM,
      confidence,
      expectedTonnes,
      expectedGradeMn,
      aiGradeMn: Number(aiGrade.gradeMn.toFixed(2)),
      aiPremiumProb: Number(aiGrade.premiumProb.toFixed(3)),
      aiModelId: aiGrade.modelId,
      voi,
      drillToM: depthBottomM + 12,
      ci: pk.i,
      cj: pk.j,
      evidence: {
        geology: describeGeology(vals, pk.score),
        spectral: describeSpectral(vals),
        geophysics: describeGeophysics(vals),
        terrain: describeTerrain(vals),
        samples: describeSamples(x, y),
      },
      drivers,
      nearestMineKm: nearest.km,
      nearestMineName: nearest.name,
      setting: nearest.km < 6 ? 'brownfield' : 'greenfield',
      areaKm2,
      cellCount,
      status: 'field-validation-required',
      assignedTo: null,
      fieldResult: null,
      elevationM: elev,
    };
  });

  // Assign priority bands by rank: top third P1, middle P2, tail P3.
  targets.forEach((t, i) => {
    const third = i / Math.max(1, targets.length - 1);
    t.priority = third < 0.3 ? 'P1' : third < 0.68 ? 'P2' : 'P3';
    t.id = `MN-${t.priority}-${String(20 + i * 3 + (i % 3)).padStart(3, '0')}`;
  });

  targets.forEach((t, i) => {
    t.rank = i + 1;
    if (t.priority === 'P1') {
      t.assignedTo = ['A. Deshmukh', 'R. Verma', 'K. Sahu'][i % 3];
      t.status = i === 0 ? 'validated' : i === 1 ? 'needs-review' : 'field-validation-required';
      t.fieldResult =
        i === 0 ? 'RC 22 m @ 31.4% Mn — confirms horizon at 46 m' :
        i === 1 ? 'Awaiting sample shipment' :
        null;
    } else if (t.priority === 'P2' && i % 5 === 2) {
      t.assignedTo = 'S. Iyer';
      t.status = 'field-validation-required';
    } else if (t.priority === 'P3' && i % 7 === 3) {
      t.status = 'rejected';
      t.fieldResult = 'Traverse found shallow alluvium; horizon > 120 m — dropped';
    }
  });

  return targets;
}

function nearestMine(x: number, y: number): { km: number; name: string } {
  let best = { km: Infinity, name: '—' };
  for (const m of MINES) {
    const km = Math.hypot(x - m.x, y - m.y) / 1000;
    if (km < best.km) best = { km, name: m.name };
  }
  return best;
}

function describeGeology(v: Record<string, number>, score: number): string {
  if (v.host > 0.6) return 'Inside the mapped gondite / Mn-silicate horizon of the Sausar Group';
  if (v.host > 0.25) return `Within ${Math.round((1 - v.host) * 2600)} m of the mapped Mn-bearing horizon`;
  if (v.horizonProx > 0.5) return 'Along the quartzite–pelite contact, outside mapped Mn units';
  return score > 0.5
    ? 'Interpreted favourable horizon from lithological and structural position'
    : 'Weak lithological support — horizon position inferred, not mapped';
}

function describeSpectral(v: Record<string, number>): string {
  const parts: string[] = [];
  parts.push(v.ferric > 0.4 ? 'strong ferric-oxide response' : v.ferric > -0.3 ? 'moderate ferric-oxide response' : 'weak ferric-oxide response');
  parts.push(v.clay > 0.4 ? 'clay alteration present' : 'little clay alteration');
  parts.push(v.ndviLow > 0.3 ? 'sparse vegetation over outcrop' : 'vegetated cover');
  return parts.join(', ');
}

function describeGeophysics(v: Record<string, number>): string {
  const mag = v.magAnom > 0.5 ? 'strong magnetic gradient' : v.magAnom > 0.25 ? 'moderate magnetic gradient' : 'flat magnetics';
  const grav = v.gravAnom > 0.5 ? 'sharp gravity edge' : v.gravAnom > 0.25 ? 'weak gravity edge' : 'no gravity expression';
  return `${mag}, ${grav}`;
}

function describeTerrain(v: Record<string, number>): string {
  const relief = v.relief > 0.5 ? 'ridge-crest position' : v.relief > 0 ? 'mid-slope' : 'valley floor';
  const slope = v.slopeLow > 0.6 ? 'gentle dip, shallow drilling' : v.slopeLow > 0 ? 'moderate dip' : 'steep ground';
  return `${relief}, ${slope}`;
}

function describeSamples(x: number, y: number): string {
  let nearest: (typeof OCCURRENCES)[number] | null = null;
  let bestD = Infinity;
  for (const occ of OCCURRENCES) {
    const d = Math.hypot(x - occ.x, y - occ.y);
    if (d < bestD) {
      bestD = d;
      nearest = occ;
    }
  }
  if (!nearest) return 'No Mn-positive sample within range';
  const km = bestD / 1000;
  if (km < 1.5) return `Mn-positive sample ${km.toFixed(1)} km away — ${nearest.mnPct.toFixed(1)}% Mn at ${nearest.depthTopM.toFixed(0)} m`;
  if (km < 5) return `Nearest known Mn occurrence ${km.toFixed(1)} km (${nearest.source})`;
  return 'No Mn-positive sample within 5 km — greenfield';
}

export const TARGETS: Target[] = buildTargets();