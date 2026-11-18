/**
 * Trained national manganese models (M6).
 *
 * Two models are fitted on `manganeseIndia.ts` at module load, entirely in the
 * browser, using the generalised-linear trainer in `trainer.ts`:
 *
 *   - M6-A  Grade regressor      — predicts ROM grade % Mn from capacity, reserve,
 *                                   age, depth, phosphorus, mining method and
 *                                   geographic/ore-type dummies.
 *   - M6-B  Premium-grade classifier — P(ROM grade ≥ threshold), the flag a
 *                                   marketing desk actually trades on.
 *
 * Reported quality is 5-fold cross-validated (out-of-fold), not train-set. With
 * only 50 rows the honest expectation is a modest R² — the screen says so — but
 * the fit, the folds and the metrics are real, and the loss curves are the ones
 * gradient descent actually produced.
 */

import { MANGANESE_MINES, OreType } from './manganeseIndia';
import { nowIso } from './clock';
import {
  DEFAULT_TRAIN,
  TrainConfig,
  fitStandardizer,
  applyStandardizer,
  trainRidge,
  trainLogistic,
  predictLinear,
  predictProba,
  regressionMetrics,
  classificationMetrics,
  kFold,
  rankCoefficients,
  thinCurve,
} from './trainer';
import type { RegressionMetrics, ClassificationMetrics } from './trainer';

/** ROM grade at or above which ore is classed premium/medium-high. */
export const GRADE_THRESHOLD = 28;

const ORE_TYPES: OreType[] = ['gondite', 'kodurite', 'lateritic', 'mixed', 'sedimentary'];

function stateList(): string[] {
  return Array.from(new Set(MANGANESE_MINES.map((m) => m.state))).sort();
}

export interface DesignMatrix {
  X: number[][];
  featureNames: string[];
  grades: number[];
  high: number[];
}

/**
 * The nine-plus-dummy feature inputs the model consumes. `ManganeseMine`
 * satisfies this structurally, and so does a greenfield *target* once its
 * analogue attributes are supplied — which is exactly what the prospectivity
 * engine does (see `prospectivity.ts`).
 */
export interface ManganeseInput {
  capacityKt: number;
  reserveMt: number;
  commissioned: number;
  depthM: number;
  phosphorusP: number;
  miningMethod: 'opencast' | 'underground';
  oreType: OreType;
  state: string;
}

function featureNamesFor(states: string[]): string[] {
  const names: string[] = [
    'log_capacity', 'log_reserve', 'age_years', 'depth_m', 'phosphorus_pct', 'underground',
  ];
  for (const t of ORE_TYPES.slice(1)) names.push(`ore_${t}`);
  for (const s of states.slice(1)) names.push(`state_${s.replace(/\s+/g, '_').toLowerCase()}`);
  return names;
}

/** One design row. Shared by training and by the deployed predictor. */
function featureRow(m: ManganeseInput, states: string[]): number[] {
  const row: number[] = [
    Math.log(Math.max(1e-6, m.capacityKt)),
    Math.log(Math.max(1e-6, m.reserveMt)),
    2026 - m.commissioned,
    m.depthM,
    m.phosphorusP * 100,
    m.miningMethod === 'underground' ? 1 : 0,
  ];
  for (const t of ORE_TYPES.slice(1)) row.push(m.oreType === t ? 1 : 0);
  for (const s of states.slice(1)) row.push(m.state === s ? 1 : 0);
  return row;
}

export function buildDesign(): DesignMatrix {
  const states = stateList();
  const featureNames = featureNamesFor(states);
  const X = MANGANESE_MINES.map((m) => featureRow(m, states));

  return {
    X,
    featureNames,
    grades: MANGANESE_MINES.map((m) => m.gradeMn),
    high: MANGANESE_MINES.map((m) => (m.gradeMn >= GRADE_THRESHOLD ? 1 : 0)),
  };
}

export interface MinePrediction {
  mineId: string;
  name: string;
  state: string;
  operator: string;
  miningMethod: 'opencast' | 'underground';
  capacityKt: number;
  actualGrade: number;
  cvPredictedGrade: number;
  fittedGrade: number;
  residual: number;
  highProb: number;
  actualHigh: boolean;
}

export interface RegressionHead {
  task: string;
  algorithm: string;
  metrics: RegressionMetrics;
  trainMetrics: RegressionMetrics;
  loss: number[];
  coefficients: { feature: string; weight: number }[];
}

export interface ClassificationHead {
  task: string;
  algorithm: string;
  metrics: ClassificationMetrics;
  trainMetrics: ClassificationMetrics;
  loss: number[];
  coefficients: { feature: string; weight: number }[];
}

export interface ManganeseTraining {
  modelId: string;
  version: string;
  trainedAt: string;
  seed: number;
  rows: number;
  features: string[];
  gradeThreshold: number;
  config: TrainConfig;
  regression: RegressionHead;
  classification: ClassificationHead;
  predictions: MinePrediction[];
}

export function trainManganeseModel(seed = 2601, config: TrainConfig = DEFAULT_TRAIN): ManganeseTraining {
  const { X, featureNames, grades, high } = buildDesign();
  const n = X.length;
  const folds = kFold(n, 5, seed);

  // Out-of-fold predictions: each mine is scored by a model that never saw it.
  const oofGrade = new Array<number>(n).fill(0);
  const oofProb = new Array<number>(n).fill(0);
  for (const testIdx of folds) {
    const testSet = new Set(testIdx);
    const trainIdx = Array.from({ length: n }, (_, i) => i).filter((i) => !testSet.has(i));
    const std = fitStandardizer(trainIdx.map((i) => X[i]));
    const stdTrain = applyStandardizer(trainIdx.map((i) => X[i]), std);
    const stdTest = applyStandardizer(testIdx.map((i) => X[i]), std);

    const { model: regModel } = trainRidge(stdTrain, trainIdx.map((i) => grades[i]), featureNames, config);
    const { model: clfModel } = trainLogistic(stdTrain, trainIdx.map((i) => high[i]), featureNames, config);
    testIdx.forEach((idx, k) => {
      oofGrade[idx] = predictLinear(regModel, stdTest[k]);
      oofProb[idx] = predictProba(clfModel, stdTest[k]);
    });
  }

  // Full-data fit for the deployed coefficients and the loss curves.
  const std = fitStandardizer(X);
  const stdX = applyStandardizer(X, std);
  const { model: regModel, loss: regLoss } = trainRidge(stdX, grades, featureNames, config);
  const { model: clfModel, loss: clfLoss } = trainLogistic(stdX, high, featureNames, config);
  const fittedGrade = X.map((_, i) => predictLinear(regModel, stdX[i]));
  const fittedProb = X.map((_, i) => predictProba(clfModel, stdX[i]));

  const predictions: MinePrediction[] = MANGANESE_MINES.map((m, i) => ({
    mineId: m.id,
    name: m.name,
    state: m.state,
    operator: m.operator,
    miningMethod: m.miningMethod,
    capacityKt: m.capacityKt,
    actualGrade: grades[i],
    cvPredictedGrade: oofGrade[i],
    fittedGrade: fittedGrade[i],
    residual: oofGrade[i] - grades[i],
    highProb: oofProb[i],
    actualHigh: high[i] === 1,
  }));

  return {
    modelId: 'mn50',
    version: 'mn50-v1.0.0',
    trainedAt: nowIso(),
    seed,
    rows: n,
    features: featureNames,
    gradeThreshold: GRADE_THRESHOLD,
    config,
    regression: {
      task: `ROM grade % Mn (regression)`,
      algorithm: 'Ridge regression — full-batch gradient descent, L2',
      metrics: regressionMetrics(grades, oofGrade),
      trainMetrics: regressionMetrics(grades, fittedGrade),
      loss: thinCurve(regLoss),
      coefficients: rankCoefficients(regModel),
    },
    classification: {
      task: `Premium grade ≥ ${GRADE_THRESHOLD}% Mn (classification)`,
      algorithm: 'Logistic regression — full-batch gradient descent, L2',
      metrics: classificationMetrics(high, oofProb),
      trainMetrics: classificationMetrics(high, fittedProb),
      loss: thinCurve(clfLoss),
      coefficients: rankCoefficients(clfModel),
    },
    predictions,
  };
}

/** The model as shipped — trained once, deterministically, on module load. */
export const MANGANESE_TRAINING: ManganeseTraining = trainManganeseModel();

/* ─── Deployed predictor ─────────────────────────────────────────────────────
 *
 * `trainManganeseModel` above *reports* quality. This is the served model: the
 * same two heads, refit on all 50 rows and frozen together with their
 * standardiser, so another engine — the Mn prospectivity engine — can score
 * ground the model never saw. The input is partial on purpose: any attribute the
 * caller does not know is filled from the national-inventory median, which is
 * what makes the predictor usable for greenfield ground where only a predicted
 * depth is available.
 */

export interface ManganeseGradePrediction {
  /** Predicted ROM feed grade, % Mn. */
  gradeMn: number;
  /** P(ROM grade ≥ GRADE_THRESHOLD) — the premium-grade flag. */
  premiumProb: number;
  modelId: string;
  version: string;
}

export interface ManganesePredictor {
  modelId: string;
  version: string;
  gradeThreshold: number;
  featureNames: string[];
  /** Median analogue applied to any attribute the caller omits. */
  defaults: ManganeseInput;
  predict(input: Partial<ManganeseInput>): ManganeseGradePrediction;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function fitDeployedPredictor(): ManganesePredictor {
  const states = stateList();
  const featureNames = featureNamesFor(states);
  const X = MANGANESE_MINES.map((m) => featureRow(m, states));
  const grades = MANGANESE_MINES.map((m) => m.gradeMn);
  const high = MANGANESE_MINES.map((m) => (m.gradeMn >= GRADE_THRESHOLD ? 1 : 0));

  const std = fitStandardizer(X);
  const stdX = applyStandardizer(X, std);
  const { model: regModel } = trainRidge(stdX, grades, featureNames, DEFAULT_TRAIN);
  const { model: clfModel } = trainLogistic(stdX, high, featureNames, DEFAULT_TRAIN);

  const defaults: ManganeseInput = {
    capacityKt: median(MANGANESE_MINES.map((m) => m.capacityKt)),
    reserveMt: median(MANGANESE_MINES.map((m) => m.reserveMt)),
    commissioned: median(MANGANESE_MINES.map((m) => m.commissioned)),
    depthM: median(MANGANESE_MINES.map((m) => m.depthM)),
    phosphorusP: median(MANGANESE_MINES.map((m) => m.phosphorusP)),
    miningMethod: 'underground',
    oreType: 'gondite',
    state: 'Madhya Pradesh',
  };

  return {
    modelId: 'mn50',
    version: 'mn50-v1.0.0',
    gradeThreshold: GRADE_THRESHOLD,
    featureNames,
    defaults,
    predict(input: Partial<ManganeseInput>): ManganeseGradePrediction {
      const full: ManganeseInput = {
        capacityKt: input.capacityKt ?? defaults.capacityKt,
        reserveMt: input.reserveMt ?? defaults.reserveMt,
        commissioned: input.commissioned ?? defaults.commissioned,
        depthM: input.depthM ?? defaults.depthM,
        phosphorusP: input.phosphorusP ?? defaults.phosphorusP,
        miningMethod: input.miningMethod ?? defaults.miningMethod,
        oreType: input.oreType ?? defaults.oreType,
        state: input.state ?? defaults.state,
      };
      const z = applyStandardizer([featureRow(full, states)], std)[0];
      return {
        gradeMn: predictLinear(regModel, z),
        premiumProb: predictProba(clfModel, z),
        modelId: 'mn50',
        version: 'mn50-v1.0.0',
      };
    },
  };
}

/** The deployed national grade/premium model — trained once on module load. */
export const MANGANESE_PREDICTOR: ManganesePredictor = fitDeployedPredictor();
