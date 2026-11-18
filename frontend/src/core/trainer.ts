/**
 * A small, real generalised-linear trainer that runs in the browser.
 *
 * Why hand-rolled: this prototype has no Python backend any more, and the point
 * of the training screen is that the numbers on it are the actual result of
 * fitting a model on the mine inventory — not a hard-coded footnote. The
 * implementations below are standard full-batch gradient descent:
 *
 *   - `trainRidge`      — L2-regularised least squares (continuous target).
 *   - `trainLogistic`   — L2-regularised logistic regression (binary target).
 *
 * Features are standardised before fitting so the L2 penalty is scale-uniform
 * and the weights are directly comparable as importances. Everything is
 * deterministic: the fold shuffle is driven by the project's seeded RNG.
 */

import { makeRng } from './rng';

export interface Standardizer {
  mean: number[];
  std: number[];
}

export interface LinearModel {
  weights: number[];
  bias: number;
  featureNames: string[];
}

export interface TrainConfig {
  epochs: number;
  learningRate: number;
  /** L2 penalty. Not applied to the bias. */
  l2: number;
}

export interface RegressionMetrics {
  mae: number;
  rmse: number;
  r2: number;
}

export interface ClassificationMetrics {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  auc: number;
}

/** Defaults tuned for a ~50-row, ~20-feature standardised design matrix. */
export const DEFAULT_TRAIN: TrainConfig = { epochs: 900, learningRate: 0.08, l2: 0.06 };

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);

export function fitStandardizer(X: number[][]): Standardizer {
  const d = X[0]?.length ?? 0;
  const meanV = new Array<number>(d).fill(0);
  const stdV = new Array<number>(d).fill(1);
  const n = X.length;
  if (!n) return { mean: meanV, std: stdV };
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += X[i][j];
    meanV[j] = s / n;
  }
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const dv = X[i][j] - meanV[j];
      s += dv * dv;
    }
    const sd = Math.sqrt(s / n);
    stdV[j] = sd > 1e-9 ? sd : 1;
  }
  return { mean: meanV, std: stdV };
}

export function applyStandardizer(X: number[][], s: Standardizer): number[][] {
  return X.map((row) => row.map((v, j) => (v - s.mean[j]) / s.std[j]));
}

/** Fit ridge regression on an already-standardised design matrix. */
export function trainRidge(
  X: number[][],
  y: number[],
  featureNames: string[],
  config: TrainConfig = DEFAULT_TRAIN,
): { model: LinearModel; loss: number[] } {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const weights = new Array<number>(d).fill(0);
  let bias = mean(y);
  const loss: number[] = [];
  const lr = config.learningRate;

  for (let epoch = 0; epoch < config.epochs; epoch++) {
    const gw = new Array<number>(d).fill(0);
    let gb = 0;
    let sse = 0;
    for (let i = 0; i < n; i++) {
      let pred = bias;
      for (let j = 0; j < d; j++) pred += weights[j] * X[i][j];
      const err = pred - y[i];
      sse += err * err;
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
    }
    for (let j = 0; j < d; j++) {
      const g = gw[j] / n + config.l2 * weights[j];
      weights[j] -= lr * g;
    }
    bias -= lr * (gb / n);
    loss.push(sse / n + config.l2 * weights.reduce((s, w) => s + w * w, 0));
  }

  return { model: { weights, bias, featureNames }, loss };
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function predictLinear(model: LinearModel, x: number[]): number {
  let z = model.bias;
  for (let j = 0; j < model.weights.length; j++) z += model.weights[j] * x[j];
  return z;
}

export function predictProba(model: LinearModel, x: number[]): number {
  return sigmoid(predictLinear(model, x));
}

/** Fit logistic regression on an already-standardised design matrix. */
export function trainLogistic(
  X: number[][],
  y: number[],
  featureNames: string[],
  config: TrainConfig = DEFAULT_TRAIN,
): { model: LinearModel; loss: number[] } {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const weights = new Array<number>(d).fill(0);
  let bias = 0;
  const loss: number[] = [];
  const lr = config.learningRate * 2;

  for (let epoch = 0; epoch < config.epochs; epoch++) {
    const gw = new Array<number>(d).fill(0);
    let gb = 0;
    let bce = 0;
    for (let i = 0; i < n; i++) {
      let z = bias;
      for (let j = 0; j < d; j++) z += weights[j] * X[i][j];
      const p = sigmoid(z);
      const yv = y[i];
      bce += -(yv * Math.log(p + 1e-12) + (1 - yv) * Math.log(1 - p + 1e-12));
      const err = p - yv;
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
    }
    for (let j = 0; j < d; j++) {
      const g = gw[j] / n + config.l2 * weights[j];
      weights[j] -= lr * g;
    }
    bias -= lr * (gb / n);
    loss.push(bce / n + (config.l2 / 2) * weights.reduce((s, w) => s + w * w, 0));
  }

  return { model: { weights, bias, featureNames }, loss };
}

export function regressionMetrics(yTrue: number[], yPred: number[]): RegressionMetrics {
  const n = yTrue.length;
  if (!n) return { mae: 0, rmse: 0, r2: 0 };
  let sae = 0;
  let sse = 0;
  const ym = mean(yTrue);
  let sst = 0;
  for (let i = 0; i < n; i++) {
    const e = yPred[i] - yTrue[i];
    sae += Math.abs(e);
    sse += e * e;
    sst += (yTrue[i] - ym) ** 2;
  }
  return { mae: sae / n, rmse: Math.sqrt(sse / n), r2: sst > 0 ? 1 - sse / sst : 0 };
}

/** ROC-AUC via the Mann–Whitney rank statistic (ties count as half). */
export function rocAuc(yTrue: number[], scores: number[]): number {
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < yTrue.length; i++) (yTrue[i] ? pos : neg).push(scores[i]);
  if (!pos.length || !neg.length) return 0.5;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function classificationMetrics(yTrue: number[], scores: number[]): ClassificationMetrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const pred = scores[i] >= 0.5 ? 1 : 0;
    if (pred === 1 && yTrue[i] === 1) tp++;
    else if (pred === 1 && yTrue[i] === 0) fp++;
    else if (pred === 0 && yTrue[i] === 0) tn++;
    else fn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const total = tp + fp + tn + fn;
  return { accuracy: total ? (tp + tn) / total : 0, precision, recall, f1, auc: rocAuc(yTrue, scores) };
}

/** Deterministic k-fold split. Returns `k` arrays of test indices. */
export function kFold(n: number, k: number, seed: number): number[][] {
  const rng = makeRng(seed);
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const folds: number[][] = Array.from({ length: k }, () => []);
  idx.forEach((v, pos) => folds[pos % k].push(v));
  return folds;
}

/** Coefficients sorted by absolute magnitude — the importance ranking. */
export function rankCoefficients(model: LinearModel): { feature: string; weight: number }[] {
  return model.featureNames
    .map((feature, j) => ({ feature, weight: model.weights[j] }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}

/** Thin a loss curve down to at most `max` points for charting. */
export function thinCurve(loss: number[], max = 60): number[] {
  if (loss.length <= max) return loss;
  const stride = loss.length / max;
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(loss[Math.floor(i * stride)]);
  out[out.length - 1] = loss[loss.length - 1];
  return out;
}
