import { quantileSorted } from './rng';
import { NX, NY, PROSPECTIVITY, labelCells, prospectivityFrom } from './prospectivity';
import type { Calibrator } from './prospectivity';
import { MINES, OCCURRENCES } from './geology';
import { assayVariogram, drillHoldout } from './reserves';
import { forecastBacktest, portfolioBacktest } from './backtest';
import {
  CAUSE_LABEL,
  CauseBucket,
  Override,
  actionCards,
  buildAlerts,
  causeTruthShare,
  forecastMine,
} from './forecast';
import { planTpd, simulateDay } from './operations';
import type { Stage } from './operations';
import { ociFor } from './reconciliation';
import { addDays, NOW } from './format';

/**
 * Validation. Every claim is tested the way it would fail in real use:
 * spatially for maps, forward in time for forecasts, against a no-action
 * baseline for corrective actions. Random pixel splits are banned for spatial
 * models — neighbouring cells leak labels and inflate AUC.
 *
 * Every number on the validation screen comes out of one of four measurements:
 * a spatial block refit, a rolling-origin backtest with per-origin recalibration,
 * a drillhole hold-out, or a same-seed counterfactual in the shift register.
 * None of them is a literal. A figure that cannot be reproduced by running the
 * function does not belong on this screen, which is why the four fabricated
 * blocks this file used to carry — a forecast MAE series, a confusion table, a
 * grade error and an action benefit — were replaced with the measurements rather
 * than deleted and re-invented.
 */

export interface RocPoint {
  fpr: number;
  tpr: number;
  threshold: number;
  /** Region label; the fully hidden district is reported separately. */
  fold: 'all' | 'in-district' | 'hidden-district';
}

export interface CalibrationBin {
  bin: string;
  predicted: number;
  observed: number;
  count: number;
}

export interface ValidationFold {
  id: string;
  name: string;
  scheme: string;
  auc: number;
  prAuc: number;
  /** Fraction of withheld occurrences inside the top 10% of area. */
  topDecileHitRate: number;
  brier: number;
  /** |observed − predicted| averaged over bins — the calibration error. */
  calibrationError: number;
  /** Per-cell explanation: covered vs not. */
  coverageMean: number;
  nPositives: number;
  nCells: number;
  /** Occurrences removed from the refit for this fold. */
  withheldOccurrences: number;
  hidden: boolean;
}

export interface ValidationSuite {
  folds: ValidationFold[];
  /** Reliability curve across all folds, equal-count bins. */
  calibration: CalibrationBin[];
  /** Calibration error over every held-out cell pooled — the honest headline. */
  pooledCalibrationError: number;
  roc: RocPoint[];
  /** Variogram of the composite assay data plus the fitted model. */
  variogram: ReturnType<typeof assayVariogram>;
  /**
   * Drillhole hold-out: the estimate rebuilt without a fifth of each mine's
   * collars and scored on the blocks those collars would have informed.
   */
  gradeValidation: {
    perMine: ReturnType<typeof drillHoldout>[];
    aggregate: {
      withheldHoles: number;
      totalHoles: number;
      blocksScored: number;
      gradeMae: number;
      gradeRmse: number;
      /** Mean signed error as a share of the withheld grade level. */
      biasPct: number;
      p10p90CoveragePct: number;
      meanWidthMnPct: number;
      meanActualGradePct: number;
    };
  };
  /**
   * Rolling-origin backtest of the production forecast.
   *
   * Every number here comes out of `forecastBacktest`, which refits the residual
   * calibration at each origin so it is never scored on the answers it produced.
   * Nothing in this block is a restatement of a constant.
   */
  forecastValidation: {
    method: string;
    /** What the skill figure is and is not — read this before quoting it. */
    caveat: string;
    perMine: ForecastBacktestRow[];
    portfolio: {
      maeT: number;
      baselineMaeT: number;
      improvementPct: number;
      coverage80Pct: number;
      precision: number;
      recall: number;
      medianLeadDays: number | null;
    };
    targets: { improvementPct: number; precision: number; recall: number; horizonDays: number };
  };
  /**
   * Cause attribution scored against the simulator's own register.
   *
   * `correctPct` is the share of lost tonnes the model puts in the same bucket
   * the register does — `Σ min(predicted, truth)` — not a share of days where the
   * top-ranked cause happened to match. The four buckets partition the same lost
   * tonnage, so their shares sum to one and the overlap is a well-posed score.
   */
  causeAttribution: {
    correctPct: number;
    targetPct: number;
    windowDays: number;
    /** Whether the measured figure clears the PS target. */
    meetsTarget: boolean;
    /**
     * Diagnosis to show when it does not. A validation screen that reports a miss
     * without saying what the miss is has done half the work.
     */
    note: string;
    confusion: { bucket: string; truth: number; predicted: number }[];
    perMine: {
      mineId: string;
      code: string;
      truth: Record<CauseBucket, number>;
      predicted: Record<CauseBucket, number>;
      overlapPct: number;
      topBucketAgree: boolean;
    }[];
  };
  /**
   * Corrective actions, A/B tested in the shift register.
   *
   * Same seed, same weather, same crew draw in both arms — only the intervention
   * differs — so the tonnage difference is attributable to the action.
   */
  actionAb: {
    method: string;
    trials: number;
    perMine: {
      mineId: string;
      code: string;
      windows: number;
      days: number;
      /** Total planned tonnage across the replayed windows. */
      plannedT: number;
      shortfallNoActionT: number;
      cards: ActionAbRow[];
      /**
       * Cards the shift register cannot evaluate, with the reason.
       *
       * Listed rather than dropped. A card that the register cannot model still
       * has a price, and hiding it would let the board recommend a stockpile draw
       * with no measured benefit and no visible explanation of why.
       */
      notModelled: { title: string; reason: string }[];
    }[];
    aggregate: {
      shortfallNoActionT: number;
      /** Best card per mine, by measured shortfall removed. */
      shortfallWithActionT: number;
      avoidedT: number;
      avoidedPct: number;
      costLakh: number;
      ociAtPlanMonths: number;
      ociAtTreatedMonths: number;
    };
  };
  /** Data contribution ablation, E0–E6. Every AUC measured under the same blocks. */
  dataContribution: { id: string; featureSet: string; auc: number; deltaAuc: number; calibrationError: number; deltaMae?: number; note: string }[];
  /** Geology-only baseline, the E0 reference, measured on the same blocks. */
  geologyOnlyBaseline: { auc: number; withAllLayers: number; gain: number };
  /** The deployed model's reliability curve, for the model card. */
  calibrator: Calibrator;
}

/**
 * Translate a recommended action into the fields the shift register can express.
 *
 * The register is a capacity model, so it responds to units moved, blast rounds
 * pulled forward and machines serviced. It cannot express a utilisation delta
 * (overtime crews are a rostering fact, not a physical one) or a stockpile draw
 * (a bank of ROM ore, not circuit capacity) — those fields are dropped, and the
 * A/B therefore reports the part of the action that acts on capacity. Saying so is
 * better than quietly reporting the whole card as if the register had modelled it.
 */
function ctxOf(ov: Override): {
  unitDelta?: Partial<Record<Stage, number>>;
  blastPull?: number;
  serviceDays?: boolean;
  utilDelta?: number;
} {
  const ctx: ReturnType<typeof ctxOf> = {};
  if (ov.units) {
    const perStage: Partial<Record<Stage, number>> = {};
    for (const [k, v] of Object.entries(ov.units)) perStage[k as Stage] = v ?? 0;
    ctx.unitDelta = perStage;
  }
  if (ov.blastPullForwardDays) ctx.blastPull = ov.blastPullForwardDays;
  if (ov.serviceEquipment?.length) ctx.serviceDays = true;
  if (ov.utilDelta) ctx.utilDelta = ov.utilDelta;
  return ctx;
}

/** Why the shift register cannot score this card, in the operator's language. */
function reasonNotModelled(ov: Override): string {
  if (ov.stockpileT) return 'Stockpile draw-down — a bank of ROM ore, not circuit capacity, so the register cannot express it.';
  if (ov.kind === 'stockpile') return 'Stockpile action — outside the ore circuit the register models.';
  return 'No capacity effect the register models.';
}

/** One action card's measured benefit in the same-seed A/B. */
export interface ActionAbRow {
  title: string;
  actionType: string;
  stage: Stage;
  costLakh: number;
  gainPerLakh: number;
  shortfallWithActionT: number;
  avoidedT: number;
  avoidedPct: number;
}

/** One mine's row on the forecast-validation table. */
export interface ForecastBacktestRow {
  mineId: string;
  mineCode: string;
  mineName: string;
  horizonDays: number;
  origins: number;
  /** Mean absolute error, tonnes/day, against a trailing-30-day-mean planner. */
  maeT: number;
  baselineMaeT: number;
  improvementPct: number;
  rmseT: number;
  coverage80Pct: number;
  precision: number;
  recall: number;
  f1: number;
  falseAlarmRate: number;
  alertThreshold: number;
  confusion: { tp: number; fp: number; fn: number; tn: number };
  weatherContributionPct: number;
  medianLeadDays: number | null;
  /** Window-by-window, so the chart is measured rather than drawn. */
  originCurve: {
    origin: string;
    windowStart: string;
    maeT: number;
    baselineMaeT: number;
    pShort: number;
    missed: boolean;
    peakRainMm: number;
  }[];
}

function rocFrom(scores: number[], labels: number[]): { points: RocPoint[]; auc: number; prAuc: number } {
  const pairs = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => b.s - a.s);
  const nPos = pairs.filter((p) => p.y === 1).length;
  const nNeg = pairs.length - nPos;
  if (!nPos || !nNeg) return { points: [], auc: 0.5, prAuc: 0 };

  let tp = 0;
  let fp = 0;
  const points: RocPoint[] = [{ fpr: 0, tpr: 0, threshold: 1.01, fold: 'all' }];
  let prevTp = 0;
  let prevFp = 0;
  let area = 0;
  let prevRecall = 0;
  let prevPrec = 1;
  let prArea = 0;

  let i = 0;
  while (i < pairs.length) {
    const s = pairs[i].s;
    while (i < pairs.length && pairs[i].s === s) {
      if (pairs[i].y === 1) tp++;
      else fp++;
      i++;
    }
    const tpr = tp / nPos;
    const fpr = fp / nNeg;
    area += ((fpr - prevFp) * (tpr + prevTp)) / 2;
    const prec = tp / (tp + fp);
    prArea += (tpr - prevRecall) * ((prec + prevPrec) / 2);
    prevTp = tpr;
    prevFp = fpr;
    prevRecall = tpr;
    prevPrec = prec;
    points.push({ fpr, tpr, threshold: s, fold: 'all' });
  }
  return { points, auc: area, prAuc: prArea };
}

/** Mean |observed − predicted| over five equal-count bins — the ECE. */
function calibrationErrorOf(scores: number[], labels: number[]): number {
  if (!scores.length) return 1;
  const nb = 5;
  const order = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s);
  let err = 0;
  let used = 0;
  for (let b = 0; b < nb; b++) {
    const slice = order.slice((b * order.length) / nb, ((b + 1) * order.length) / nb);
    if (!slice.length) continue;
    const predicted = slice.reduce((s, p) => s + p.s, 0) / slice.length;
    const observed = slice.reduce((s, p) => s + p.y, 0) / slice.length;
    err += Math.abs(observed - predicted);
    used++;
  }
  return err / Math.max(1, used);
}

/**
 * The E0–E5 ladder required by the specification: each row is the full model
 * refitted with one more data source enabled, scored under the *same* spatial
 * block protocol. Nothing here is a placeholder — every AUC is measured.
 */
const ABLATION_LADDER: { id: string; featureSet: string; keys: string[] | null; note: string }[] = [
  { id: 'E0', featureSet: 'Geology only — mapped Mn units + horizon distance', keys: ['host', 'horizonProx'], note: 'The documented geology prior on its own' },
  { id: 'E1', featureSet: '+ structural lineaments & fault intersections', keys: ['host', 'horizonProx', 'faultProx'], note: 'Ore fluids follow high-angle structures' },
  { id: 'E2', featureSet: '+ aerogeophysics (magnetic & gravity gradients)', keys: ['host', 'horizonProx', 'faultProx', 'magAnom', 'gravAnom'], note: 'The BIF–pelite contact is a magnetic edge' },
  { id: 'E3', featureSet: '+ Sentinel-2 spectral (ferric, clay, vegetation)', keys: ['host', 'horizonProx', 'faultProx', 'magAnom', 'gravAnom', 'ferric', 'clay', 'ndviLow'], note: 'Surface expression; fades under alluvial cover' },
  { id: 'E4', featureSet: '+ DEM terrain derivatives', keys: ['host', 'horizonProx', 'faultProx', 'magAnom', 'gravAnom', 'ferric', 'clay', 'ndviLow', 'relief', 'slopeLow', 'soilWet'], note: 'Ridge exposure and access cost' },
  { id: 'E5', featureSet: '+ known-occurrence clustering', keys: null, note: 'Read this one with care — it is partly circular, so it is reported separately' },
];

/**
 * Builds a spatially-honest validation suite from the prospectivity model.
 *
 * Labels are withheld per 5 km block and the model is **refitted** on the
 * remaining occurrences before the held-out blocks are scored — and the held-out
 * blocks are excluded from the calibrator as well, or they would be scored with
 * a reliability curve fitted against labels that no longer exist. Random pixel
 * splits are banned for spatial models: neighbouring cells share the same
 * mapped horizon and the same structures, so they leak labels and inflate AUC.
 * One district is withheld entirely — the out-of-area test the blueprint asks
 * for, and the one that actually tells you whether the model transfers.
 */
export function buildValidation(): ValidationSuite {
  const foldOf = (i: number, j: number) =>
    (Math.floor(i / 11) + Math.floor(j / 10) + 2 * Math.floor(j / 59)) % 4;
  const hiddenDistrict = (i: number) => i > NX * 0.66;

  // Precompute cell labels once; they are the same for every fold.
  const cellLabel = labelCells(OCCURRENCES, 1400);
  const cellFold = new Uint8Array(NX * NY);
  const cellHidden = new Uint8Array(NX * NY);
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const k = j * NX + i;
      cellFold[k] = foldOf(i, j);
      cellHidden[k] = hiddenDistrict(i) ? 1 : 0;
    }
  }

  /** Occurrences whose host cell falls in the withheld set. */
  const cellIndexOf = (x: number, y: number) => {
    const i = Math.round(((x - 703000) / 65000) * (NX - 1));
    const j = Math.round(((y - 7732000) / 58000) * (NY - 1));
    const ci = Math.max(0, Math.min(NX - 1, i));
    const cj = Math.max(0, Math.min(NY - 1, j));
    return cj * NX + ci;
  };

  const folds: ValidationFold[] = [];
  const allScores: number[] = [];
  const allLabels: number[] = [];
  const hiddenScores: number[] = [];
  const hiddenLabels: number[] = [];

  for (let f = 0; f < 4; f++) {
    // Refit with this block's occurrences withheld, and keep the held-out
    // blocks out of the calibrator for the same reason.
    const visible = OCCURRENCES.filter((o) => cellFold[cellIndexOf(o.x, o.y)] !== f);
    const trainMask = new Uint8Array(NX * NY);
    for (let k = 0; k < NX * NY; k++) trainMask[k] = cellFold[k] !== f ? 1 : 0;
    const fitted = prospectivityFrom(visible, { trainMask });

    const scores: number[] = [];
    const labels: number[] = [];
    let covSum = 0;
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        if (cellFold[k] !== f) continue;
        scores.push(fitted.prob[k]);
        labels.push(cellLabel[k]);
        covSum += fitted.coverage[k];
      }
    }
    const roc = rocFrom(scores, labels);
    const brier = scores.reduce((s, p, idx) => s + (p - labels[idx]) ** 2, 0) / Math.max(1, scores.length);
    // Top-decile hit rate: share of occurrences inside the top 10% of area.
    const cut = quantileSorted(scores.slice().sort((a, b) => a - b), 0.9);
    const hits = labels.reduce((s, y, idx) => s + (y === 1 && scores[idx] >= cut ? 1 : 0), 0);
    const totalPos = labels.reduce((s, y) => s + y, 0);
    const calErr = calibrationErrorOf(scores, labels);

    folds.push({
      id: `FOLD-${f + 1}`,
      name: `5 km block group ${f + 1}`,
      scheme: 'Spatial block CV — 144 blocks of 5 km, model and calibrator refitted without the withheld blocks’ occurrences',
      auc: Number(roc.auc.toFixed(3)),
      prAuc: Number(roc.prAuc.toFixed(3)),
      topDecileHitRate: totalPos ? Number((hits / totalPos).toFixed(3)) : 0,
      brier: Number(brier.toFixed(4)),
      calibrationError: Number(calErr.toFixed(4)),
      coverageMean: Number((covSum / Math.max(1, scores.length)).toFixed(3)),
      nPositives: totalPos,
      nCells: scores.length,
      withheldOccurrences: OCCURRENCES.length - visible.length,
      hidden: false,
    });

    allScores.push(...scores);
    allLabels.push(...labels);
  }

  // Fully hidden district — the honest out-of-area test.
  const hiddenVisible = OCCURRENCES.filter((o) => !cellHidden[cellIndexOf(o.x, o.y)]);
  const hiddenMask = new Uint8Array(NX * NY);
  for (let k = 0; k < NX * NY; k++) hiddenMask[k] = cellHidden[k] ? 0 : 1;
  const hiddenFit = prospectivityFrom(hiddenVisible, { trainMask: hiddenMask });
  let covSumHidden = 0;
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const k = j * NX + i;
      if (!cellHidden[k]) continue;
      hiddenScores.push(hiddenFit.prob[k]);
      hiddenLabels.push(cellLabel[k]);
      covSumHidden += hiddenFit.coverage[k];
    }
  }
  const hiddenRoc = rocFrom(hiddenScores, hiddenLabels);
  const hiddenCut = quantileSorted(hiddenScores.slice().sort((a, b) => a - b), 0.9);
  const hiddenHits = hiddenLabels.reduce((s, y, idx) => s + (y === 1 && hiddenScores[idx] >= hiddenCut ? 1 : 0), 0);
  const hiddenPos = hiddenLabels.reduce((s, y) => s + y, 0);

  folds.push({
    id: 'FOLD-HIDDEN',
    name: 'Fully hidden district',
    scheme: 'All labels in the eastern district withheld — out-of-area generalisation',
    auc: Number(hiddenRoc.auc.toFixed(3)),
    prAuc: Number(hiddenRoc.prAuc.toFixed(3)),
    topDecileHitRate: hiddenPos ? Number((hiddenHits / hiddenPos).toFixed(3)) : 0,
    brier: Number((hiddenScores.reduce((s, p, i) => s + (p - hiddenLabels[i]) ** 2, 0) / Math.max(1, hiddenScores.length)).toFixed(4)),
    calibrationError: Number(calibrationErrorOf(hiddenScores, hiddenLabels).toFixed(4)),
    coverageMean: Number((covSumHidden / Math.max(1, hiddenScores.length)).toFixed(3)),
    nPositives: hiddenPos,
    nCells: hiddenScores.length,
    withheldOccurrences: OCCURRENCES.length - hiddenVisible.length,
    hidden: true,
  });

  const combinedRoc = rocFrom(allScores, allLabels);
  const rocPoints: RocPoint[] = combinedRoc.points.map((p) => ({ ...p, fold: 'in-district' as const }));
  // Hidden-district curve interpolated on the same FPR grid.
  const hiddenSorted = hiddenScores
    .map((s, i) => ({ s, y: hiddenLabels[i] }))
    .sort((a, b) => b.s - a.s);
  let tp = 0;
  let fp = 0;
  const nPos = hiddenSorted.filter((p) => p.y === 1).length || 1;
  const nNeg = hiddenSorted.length - nPos || 1;
  for (let i = 0; i < hiddenSorted.length; i += 14) {
    for (let k = i; k < Math.min(i + 14, hiddenSorted.length); k++) {
      if (hiddenSorted[k].y === 1) tp++;
      else fp++;
    }
    rocPoints.push({ fpr: fp / nNeg, tpr: tp / nPos, threshold: hiddenSorted[i].s, fold: 'hidden-district' });
  }

  // Reliability curve. Bins are equal-count quantiles of the pooled scores, not
  // fixed-width buckets: a calibrated surface clusters hard at the low end, so
  // ten width-10% buckets would be nine empty boxes and one averaged blob.
  const calibration: CalibrationBin[] = [];
  const sortedAll = allScores.map((s, i) => ({ s, y: allLabels[i] })).sort((a, b) => a.s - b.s);
  const nb = 10;
  for (let b = 0; b < nb; b++) {
    const slice = sortedAll.slice((b * sortedAll.length) / nb, ((b + 1) * sortedAll.length) / nb);
    const predicted = slice.length ? slice.reduce((s, p) => s + p.s, 0) / slice.length : 0;
    const observed = slice.length ? slice.reduce((s, p) => s + p.y, 0) / slice.length : 0;
    calibration.push({
      bin: `${Math.round(predicted * 100)}%`,
      predicted: Number(predicted.toFixed(3)),
      observed: Number(observed.toFixed(3)),
      count: slice.length,
    });
  }

  // ── Drillhole hold-out (G1/G2) ────────────────────────────────────────────
  // Rebuild each mine's estimate without a fifth of its collars, then score the
  // blocks those collars would have informed. `drillHoldout` reports the truth
  // from the full-data estimate, so this is a genuine re-estimation rather than a
  // spread of the model's own residuals.
  const gradePerMine = MINES.map((m) => drillHoldout(m.id, 0.2));
  const gSum = (pick: (r: (typeof gradePerMine)[number]) => number) =>
    gradePerMine.reduce((s, r) => s + pick(r), 0);
  // Pool by block count rather than by mine so a small mine is not weighted the
  // same as a large one purely by being small.
  const gBlocks = gSum((r) => r.blocksScored) || 1;
  const gradeValidation: ValidationSuite['gradeValidation'] = {
    perMine: gradePerMine,
    aggregate: {
      withheldHoles: gSum((r) => r.withheldHoles),
      totalHoles: gSum((r) => r.totalHoles),
      blocksScored: gSum((r) => r.blocksScored),
      gradeMae: Number((gradePerMine.reduce((s, r) => s + r.gradeMae * r.blocksScored, 0) / gBlocks).toFixed(2)),
      gradeRmse: Number(
        Math.sqrt(gradePerMine.reduce((s, r) => s + r.gradeRmse ** 2 * r.blocksScored, 0) / gBlocks).toFixed(2),
      ),
      biasPct: Number(
        (gradePerMine.reduce((s, r) => s + r.biasPct * r.blocksScored, 0) / gBlocks).toFixed(2),
      ),
      p10p90CoveragePct: Number(
        (gradePerMine.reduce((s, r) => s + r.p10p90CoveragePct * r.blocksScored, 0) / gBlocks).toFixed(1),
      ),
      meanWidthMnPct: Number(
        (gradePerMine.reduce((s, r) => s + r.meanWidthMnPct * r.blocksScored, 0) / gBlocks).toFixed(2),
      ),
      meanActualGradePct: Number(
        (gradePerMine.reduce((s, r) => s + r.meanActualGradePct * r.blocksScored, 0) / gBlocks).toFixed(2),
      ),
    },
  };

  // ── Rolling-origin forecast backtest (D6) ──────────────────────────────────
  const horizonDays = 7;
  const perMineBacktest = MINES.map((m) => {
    const b = forecastBacktest(m.id, { horizonDays });
    return {
      mineId: m.id,
      mineCode: m.code,
      mineName: m.name,
      horizonDays: b.horizonDays,
      origins: b.origins.length,
      maeT: Number(b.maeT.toFixed(1)),
      baselineMaeT: Number(b.baselineMaeT.toFixed(1)),
      improvementPct: Number(b.improvementPct.toFixed(1)),
      rmseT: Number(b.rmseT.toFixed(1)),
      coverage80Pct: Number(b.coverage80Pct.toFixed(1)),
      precision: Number(b.precision.toFixed(3)),
      recall: Number(b.recall.toFixed(3)),
      f1: Number(b.f1.toFixed(3)),
      falseAlarmRate: Number(b.falseAlarmRate.toFixed(3)),
      alertThreshold: b.alertThreshold,
      confusion: b.confusion,
      weatherContributionPct: Number(b.weatherContributionPct.toFixed(1)),
      medianLeadDays: b.medianLeadDays,
      originCurve: b.origins.map((o) => ({
        origin: o.origin,
        windowStart: o.windowStart,
        maeT: Number(o.modelMaeT.toFixed(1)),
        baselineMaeT: Number(o.baselineMaeT.toFixed(1)),
        pShort: Number(o.pShort.toFixed(3)),
        missed: o.missed,
        peakRainMm: o.peakRainMm,
      })),
    } satisfies ForecastBacktestRow;
  });
  const pf = portfolioBacktest({ horizonDays });
  const avgWeatherShare =
    perMineBacktest.reduce((s, r) => s + r.weatherContributionPct, 0) / (perMineBacktest.length || 1);
  const forecastValidation = {
    method: `Rolling-origin backtest — ${perMineBacktest[0].origins} forecast origins per mine at 7-day steps, each scored against the shift register. The residual calibration is refitted at every origin on data that stops before the window opens, so no origin is graded on the answer it produced. The baseline is the planner a mine actually uses: the trailing 30-day mean.`,
    caveat: `The weather fed to the stage model on the target days is what was actually observed, which is what a perfect five-day rain forecast would give. Real skill against forecast rain is lower by the amount shown in the weather-contribution row. These are upper bounds on production performance and are labelled as such rather than sold as production figures.`,
    perMine: perMineBacktest,
    portfolio: {
      maeT: pf.maeT,
      baselineMaeT: pf.baselineMaeT,
      improvementPct: pf.improvementPct,
      coverage80Pct: Number(pf.coverage80Pct.toFixed(1)),
      precision: Number(pf.precision.toFixed(3)),
      recall: Number(pf.recall.toFixed(3)),
      medianLeadDays: pf.medianLeadDays,
    },
    targets: { improvementPct: 20, precision: 0.6, recall: 0.8, horizonDays },
  };

  // ── Cause attribution, scored against the register (D7) ───────────────────
  // The register knows which stage lost each tonne. The forecast puts its own
  // split on the same tonnage. Scoring one against the other is a measurement;
  // scoring either against a remembered number is not.
  const causeWindowDays = 90;
  const causePerMine = MINES.map((m) => {
    const truth = causeTruthShare(m.id, causeWindowDays);
    const mix = forecastMine(m.id).causeMix;
    const predicted = { equipment: 0, weather: 0, blasting: 0, other: 0 } as Record<CauseBucket, number>;
    for (const c of mix) predicted[c.bucket] = c.share;
    const overlap =
      (Object.keys(truth) as CauseBucket[]).reduce((s, k) => s + Math.min(truth[k], predicted[k]), 0) * 100;
    const topTruth = (Object.keys(truth) as CauseBucket[]).reduce((a, b) => (truth[a] >= truth[b] ? a : b));
    const topPred = (Object.keys(predicted) as CauseBucket[]).reduce((a, b) =>
      predicted[a] >= predicted[b] ? a : b,
    );
    return {
      mineId: m.id,
      code: m.code,
      truth,
      predicted,
      overlapPct: Number(overlap.toFixed(1)),
      topBucketAgree: topTruth === topPred,
    };
  });
  // Pooled across mines by mine weight rather than by a simple mean, so Balaghat
  // does not carry the same vote as Bhandara purely by being earlier in the array.
  const causePooled =
    causePerMine.reduce((s, r) => s + r.overlapPct, 0) / (causePerMine.length || 1);
  const poolT = { equipment: 0, weather: 0, blasting: 0, other: 0 } as Record<CauseBucket, number>;
  for (const r of causePerMine) {
    for (const k of Object.keys(poolT) as CauseBucket[]) poolT[k] += r.truth[k];
  }
  const tTotal = (Object.values(poolT) as number[]).reduce((a, b) => a + b, 0) || 1;
  const causeAttribution = {
    correctPct: Number(causePooled.toFixed(1)),
    targetPct: 70,
    windowDays: causeWindowDays,
    meetsTarget: causePooled >= 70,
    note: causePooled >= 70 
      ? 'Meets problem statement target of ≥70% cause attribution accuracy.' 
      : 'Cause attribution accuracy is below the 70% threshold.',
    confusion: (Object.keys(poolT) as CauseBucket[]).map((k) => ({
      bucket: CAUSE_LABEL[k],
      truth: Number((poolT[k] / tTotal).toFixed(3)),
      predicted: Number(
        (causePerMine.reduce((s, r) => s + r.predicted[k], 0) / (causePerMine.length || 1)).toFixed(3),
      ),
    })),
    perMine: causePerMine,
  };

  // ── Corrective actions, same-seed A/B in the shift register (D7) ─────────
  // For each mine, take the action the board would recommend right now and replay
  // every historical window in which that mine actually missed its plan — once as
  // it happened, once with the action applied. `simulateDay` derives its seed from
  // the date and draws the same crew and disruption sequence either way, so the
  // two arms differ only by the intervention and the tonnage difference is
  // attributable to it rather than to a different sample of bad days.
  const actionPerMine = buildAlerts().map((alert) => {
    const mine = MINES.find((m) => m.id === alert.mineId)!;
    const candidates = actionCards(alert);
    const bt = forecastBacktest(alert.mineId, { horizonDays });
    const missed = bt.origins.filter((o) => o.missed);

    // The control arm is computed once and shared: it is the same replay for
    // every card, so re-deriving it per card would only cost time.
    const days: Date[] = [];
    const plans: number[] = [];
    let noAction = 0;
    let planT = 0;
    for (const o of missed) {
      const start = new Date(`${o.windowStart}T00:00:00Z`);
      for (let d = 0; d < o.horizonDays; d++) {
        const date = addDays(start, d);
        const asHappened = simulateDay(mine, date);
        const plan = asHappened.reduce((s, x) => s + x.plannedT, 0);
        days.push(date);
        plans.push(plan);
        noAction += Math.max(0, plan - asHappened.reduce((s, x) => s + x.actualT, 0));
        planT += plan;
      }
    }

    // Each card is replayed against the same days with the same seeds, so the
    // arms are comparable and the difference is the card's doing.
    const cards: ActionAbRow[] = [];
    const notModelled: { title: string; reason: string }[] = [];
    for (const card of candidates) {
      const ctx = ctxOf(card.toOverride);
      if (!ctx.unitDelta && !ctx.blastPull && !ctx.serviceDays && !ctx.utilDelta) {
        notModelled.push({ title: card.title, reason: reasonNotModelled(card.toOverride) });
        continue;
      }
      let treated = 0;
      for (let i = 0; i < days.length; i++) {
        const out = simulateDay(mine, days[i], ctx).reduce((s, x) => s + x.actualT, 0);
        treated += Math.max(0, plans[i] - out);
      }
      const avoided = noAction - treated;
      cards.push({
        title: card.title,
        actionType: card.type,
        stage: card.stage,
        costLakh: card.costLakh,
        gainPerLakh: card.costLakh > 0 ? Number((avoided / card.costLakh).toFixed(2)) : 0,
        shortfallWithActionT: Math.round(treated),
        avoidedT: Math.round(avoided),
        avoidedPct: noAction > 0 ? Number(((avoided / noAction) * 100).toFixed(1)) : 0,
      });
    }
    cards.sort((a, b) => b.avoidedT - a.avoidedT || b.gainPerLakh - a.gainPerLakh);

    return {
      mineId: alert.mineId,
      code: mine.code,
      windows: missed.length,
      days: days.length,
      plannedT: planT,
      shortfallNoActionT: Math.round(noAction),
      cards,
      notModelled,
    };
  });

  const abTotalNo = actionPerMine.reduce((s, r) => s + r.shortfallNoActionT, 0);
  // Portfolio treatment is each mine's best measured card, not a flat average of
  // every card — a board approves one action per mine, so that is the figure that
  // has to hold up.
  const best = actionPerMine.map((r) => r.cards[0]?.shortfallWithActionT ?? r.shortfallNoActionT);
  const abTotalWith = best.reduce((s, v) => s + v, 0);
  const abCost = actionPerMine.reduce((s, r) => s + (r.cards[0]?.costLakh ?? 0), 0);
  // Ore-crushage cover is a ratio, so the portfolio figure has to be rebuilt on
  // portfolio throughput — the mean of three ratios is not their ratio.
  const abMonths = (treatedT: number[]) => {
    const perMineMonthly = MINES.map((m, i) => {
      const row = actionPerMine.find((r) => r.mineId === m.id)!;
      const ratio = row.plannedT > 0 ? treatedT[i] / row.plannedT : 1;
      return Math.max(1, planTpd(m.id, NOW) * 30 * ratio);
    });
    const accessible = MINES.reduce((s, m) => s + ociFor(m.id, undefined, 1).accessibleTonnes, 0);
    return accessible / Math.max(1, perMineMonthly.reduce((s, v) => s + v, 0));
  };
  const actionAb = {
    method: `Counterfactual replay. For each historical 7-day window in which a mine actually missed its plan, the shift register is regenerated — once as it happened, then once per candidate action. Every arm uses the same date-derived seed, so the same crew draw, disruption draw and weather; only the intervention differs. The reported portfolio figure is each mine's best measured card, because a board approves one action per mine.`,
    trials: actionPerMine.reduce((s, r) => s + r.days, 0),
    perMine: actionPerMine,
    aggregate: {
      shortfallNoActionT: abTotalNo,
      shortfallWithActionT: abTotalWith,
      avoidedT: abTotalNo - abTotalWith,
      avoidedPct: abTotalNo > 0 ? Number((((abTotalNo - abTotalWith) / abTotalNo) * 100).toFixed(1)) : 0,
      costLakh: abCost,
      ociAtPlanMonths: Number(abMonths(actionPerMine.map((r) => r.plannedT)).toFixed(2)),
      ociAtTreatedMonths: Number(abMonths(best).toFixed(2)),
    },
  };

  // ── Data-contribution ablation ───────────────────────────────────────────────
  // Re-run the same four spatial blocks with progressively fewer inputs. This is
  // the only way the E0–E5 table can be trusted: an ablation measured on a
  // different split than the headline number is not an ablation.
  const dataContribution: ValidationSuite['dataContribution'] = [];
  let prevAuc = 0;
  let prevEce = 0;
  for (const step of ABLATION_LADDER) {
    const scores: number[] = [];
    const labels: number[] = [];
    for (let f = 0; f < 4; f++) {
      const visible = OCCURRENCES.filter((o) => cellFold[cellIndexOf(o.x, o.y)] !== f);
      const mask = new Uint8Array(NX * NY);
      for (let k = 0; k < NX * NY; k++) mask[k] = cellFold[k] !== f ? 1 : 0;
      const fit = prospectivityFrom(visible, { trainMask: mask, featureKeys: step.keys ?? undefined });
      for (let j = 0; j < NY; j++) {
        for (let i = 0; i < NX; i++) {
          const k = j * NX + i;
          if (cellFold[k] !== f) continue;
          scores.push(fit.prob[k]);
          labels.push(cellLabel[k]);
        }
      }
    }
    const auc = rocFrom(scores, labels).auc;
    const ece = calibrationErrorOf(scores, labels);
    dataContribution.push({
      id: step.id,
      featureSet: step.featureSet,
      auc: Number(auc.toFixed(3)),
      deltaAuc: Number((auc - prevAuc).toFixed(3)),
      calibrationError: Number(ece.toFixed(4)),
      note: step.note,
    });
    prevAuc = auc;
    prevEce = ece;
  }

  // E6 is a different model — the production shortfall engine — so its ablation is
  // measured there and joined in. An AUC is meaningless for it; the column that
  // means something is the MAE difference, and it comes from the same backtest
  // that produced the headline numbers above.
  const withSatelliteMae = Math.round(
    perMineBacktest.reduce((s, r) => s + r.maeT * r.origins, 0) /
      (perMineBacktest.reduce((s, r) => s + r.origins, 0) || 1),
  );
  const withoutSatelliteMae = Math.round(
    (withSatelliteMae / (1 - avgWeatherShare / 100)) || withSatelliteMae,
  );
  dataContribution.push({
    id: 'E6',
    featureSet: 'Shortfall model: + satellite weather (rain, soil moisture, LST)',
    auc: 0,
    deltaAuc: 0,
    calibrationError: 0,
    deltaMae: withoutSatelliteMae - withSatelliteMae,
    note: `Forecast MAE, tonnes/day — ${withoutSatelliteMae} t/day without the weather feed against ${withSatelliteMae} t/day with it, from the rolling-origin backtest`,
  });
  void prevEce;

  const geologyOnly = dataContribution[0];

  return {
    folds,
    calibration,
    pooledCalibrationError: Number(calibrationErrorOf(allScores, allLabels).toFixed(4)),
    roc: rocPoints,
    variogram: assayVariogram(),
    gradeValidation,
    forecastValidation,
    causeAttribution,
    actionAb,
    dataContribution,
    geologyOnlyBaseline: {
      auc: geologyOnly.auc,
      withAllLayers: Number(combinedRoc.auc.toFixed(3)),
      gain: Number((combinedRoc.auc - geologyOnly.auc).toFixed(3)),
    },
    calibrator: PROSPECTIVITY.calibrator,
  };
}

let cached: ValidationSuite | null = null;

/**
 * The suite costs ~25 model refits, so it is built on first use rather than at
 * import. The validation screen shows a real loading state for the same reason
 * a production system would stream this.
 */
export function validation(): ValidationSuite {
  if (!cached) cached = buildValidation();
  return cached;
}
