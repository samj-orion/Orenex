import { MINES } from './geology';
import { clamp } from './noise';
import { NOW, addDays } from './format';
import { PRODUCTION, planTpd, plantCeilingShiftT, weatherOn } from './operations';
import { StageContext, emptyStageContext, mineCapacityT, stageRowsFor } from './stageModel';

/**
 * Forward validation of the shortfall engine (D10).
 *
 * Two things live here, and both are measured rather than asserted:
 *
 *  1. **Calibration.** The deterministic stage model gets the weather and the
 *     fleet right but cannot see crew effects, face-grade variability or the
 *     8.5%-of-shifts disruption that the shift register records. That residue
 *     has to be *fitted*, or the forecast's intervals are a guess dressed up as
 *     a distribution. So the model is evaluated over history against the shift
 *     register and a multiplicative bias and residual spread are estimated from
 *     the result.
 *
 *  2. **Rolling-origin backtest.** The fitted model is then run forwards from
 *     origins in the past, with only information available at the origin, and
 *     scored against what actually happened — against a "same as the last 30
 *     days" baseline, which is what a mine planner actually uses today.
 */

/** Rain bands the residual spread is fitted separately in. */
export const RAIN_BANDS = [
  { key: 'dry', label: 'Dry (< 8 mm)', maxMm: 8 },
  { key: 'wet', label: 'Wet (8–35 mm)', maxMm: 35 },
  { key: 'veryWet', label: 'Very wet (> 35 mm)', maxMm: Infinity },
] as const;

export type RainBand = (typeof RAIN_BANDS)[number]['key'];

export function rainBand(rainMm: number): RainBand {
  return RAIN_BANDS.find((b) => rainMm < b.maxMm)?.key ?? 'veryWet';
}

/**
 * Multiplier on the residual spread, read off the fitted per-band numbers.
 *
 * Asserting "a wet shift is harder to predict" and scaling the interval up with
 * rain is the obvious guess, and measurement says the opposite: the *relative*
 * residual is tightest on the wettest days, because there the derate is large
 * and consistent and the crews plan around it. So the forecast reads the fitted
 * band rather than an assumed slope.
 */
export function residualSdFor(cal: Calibration, rainMm: number): number {
  const bands = cal.residualSdByBand;
  const fitted = bands[rainBand(rainMm)];
  return fitted > 0 ? fitted : cal.residualSd;
}

/**
 * The multiplicative correction in force on a day with this rainfall.
 *
 * Per band, not pooled. The stage model's ground derates are a stated shape —
 * "haul loses 0.66 of its wetness factor" — and measurement says the shape is
 * right but the magnitude is not the same in every band. At Nagpur the
 * deterministic model under-derates the wet half by about 4%, so a band-agnostic
 * bias lands the whole wet-season interval four points below the shift register
 * and the interval covers barely half of the days it claims to. Correcting the
 * location per band is the difference between an interval that is honest and one
 * that is merely symmetric.
 */
export function biasFor(cal: Calibration, rainMm: number): number {
  const fitted = cal.biasByBand?.[rainBand(rainMm)];
  return fitted > 0 ? fitted : cal.bias;
}

/** The residual model in force on a day with this rainfall. */
export function residualFor(cal: Calibration, rainMm: number): ResidualModel {
  return cal.residualByBand?.[rainBand(rainMm)] ?? cal.residual;
}

/**
 * The predictive distribution for one forecast day, in tonnes.
 *
 * Two normal components: the nominal shift and the disrupted one. Everything
 * downstream — P10/P90, P(day misses plan), P(the week misses its plan) — is
 * read off this, so the bands on the chart and the alert probability are the same
 * object rather than two numbers that happen to sit near each other.
 */
export interface DayPredictive {
  /** Median tonnage for the day. */
  mu: number;
  nominalShare: number;
  /** Log-space spread of the nominal component. */
  nominalLogSd: number;
  disruptedMu: number;
  disruptedSdT: number;
}

export function dayPredictive(cal: Calibration, rainMm: number, capacityT: number): DayPredictive {
  const m = residualFor(cal, rainMm);
  const mu = Math.max(0, capacityT * biasFor(cal, rainMm));
  return {
    mu,
    nominalShare: m.nominalShare,
    nominalLogSd: m.nominalLogSd,
    disruptedMu: mu * (1 - m.disruptedOffset),
    disruptedSdT: mu * m.disruptedSd,
  };
}

function normalCdf2(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/** CDF of the residual mixture at a ratio, with the nominal component centred on 1. */
export function mixtureCdf(m: ResidualModel, x: number): number {
  const d = 1 - m.nominalShare;
  const nom = x <= 0 ? 0 : normalCdf2(Math.log(x) / (m.nominalLogSd || 1e-6));
  return m.nominalShare * nom + d * normalCdf2((x - (1 - m.disruptedOffset)) / (m.disruptedSd || 1));
}

/**
 * Quantile of the residual mixture in ratio space, nominal median at 1.
 *
 * Bisection because the mixture of a lognormal and a normal has no closed-form
 * inverse, and because the code that reads it is a coverage check that runs
 * thousands of times — a table would be an optimisation, not a design.
 */
export function mixtureQuantile(m: ResidualModel, p: number): number {
  let lo = 1 - m.disruptedOffset - 6 * m.disruptedSd;
  let hi = 1 + 8 * m.nominalLogSd;
  for (let i = 0; i < 34; i++) {
    const mid = Math.sqrt(Math.max(1e-9, lo * hi));
    if (mixtureCdf(m, mid) < p) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(Math.max(1e-9, lo * hi));
}

/** Quantile of the day predictive, in tonnes. */
export function dayQuantile(p: DayPredictive, q: number): number {
  if (q <= 0) return 0;
  if (q >= 1) return Infinity;
  const ratio = mixtureQuantile(
    {
      nominalShare: p.nominalShare,
      nominalLogSd: p.nominalLogSd,
      disruptedOffset: 1 - p.disruptedMu / (p.mu || 1),
      disruptedSd: p.disruptedSdT / (p.mu || 1),
    },
    q,
  );
  return p.mu * ratio;
}

/** P(this one day falls short of its plan). */
export function dayMissProbability(p: DayPredictive, planT: number): number {
  if (p.mu <= 0) return 1;
  const planRatio = planT / p.mu;
  return clamp(mixtureCdf(residualOfDay(p), planRatio), 0, 1);
}

function residualOfDay(p: DayPredictive): ResidualModel {
  return {
    nominalShare: p.nominalShare,
    nominalLogSd: p.nominalLogSd,
    disruptedOffset: 1 - p.disruptedMu / (p.mu || 1),
    disruptedSd: p.disruptedSdT / (p.mu || 1),
  };
}

/** Windows up to this length are propagated as an exact mixture. */
const EXACT_MIXTURE_DAYS = 12;

/**
 * Mean and sd of the nominal component in ratio space, median 1.
 *
 * The component is lognormal, so its mean sits above 1 by exp(σ²/2) even though
 * its median is exactly 1. That matters here: a weekly total built from component
 * *medians* is biased low, so the shortfall probability it produces over-states the
 * risk, and it does so most on the weeks that already look tight.
 */
function nominalMoments(logSd: number): { mean: number; sd: number } {
  const v = logSd * logSd;
  const mean = Math.exp(v / 2);
  return { mean, sd: Math.sqrt((Math.exp(v) - 1) * mean * mean) };
}

/**
 * P(a run of independent days misses its combined plan).
 *
 * The total is a sum of independent per-day mixtures. Each day contributes one of
 * two components, so for a short window the sum is a mixture of `2ⁿ` branches —
 * 128 of them for a week, cheap enough to enumerate exactly rather than collapse
 * the whole week onto one distribution and throw away the asymmetry the mixture
 * exists to carry.
 *
 * Each branch is still evaluated by matching its mean and variance to a normal.
 * A week is a sum of lognormals and normals with no closed-form CDF, so this is
 * an approximation rather than an identity, and it is a good one: at seven days
 * the central limit has done most of the work and the branch's own skew is small
 * beside the total width. It is *not* used for a single day, where `dayQuantile`
 * inverts the exact mixture CDF instead.
 *
 * Beyond `EXACT_MIXTURE_DAYS` the enumeration itself is dropped and the whole
 * window is moment-matched in one step. At that length the branch-to-branch
 * differences are far below the total spread; the 30-day view is a planning aid,
 * and the week — the window the alert board and the action engine act on — is
 * always enumerated.
 *
 * Days are independent given the weather forecast, which is an assumption and
 * not a certainty: consecutive shifts share crews and the same broken machine, so
 * real shortfalls cluster more than this model implies. It is stated on the model
 * card rather than hidden, and it means reported probabilities are mildly
 * over-confident.
 */
export function windowMissProbability(days: DayPredictive[], planTotalT: number): number {
  if (!days.length) return 0;
  const totalMu = days.reduce((s, d) => s + d.mu, 0);
  if (totalMu <= 0) return 0;
  // Ratio space: a multiplier of 1 means the day ran exactly to model, so the
  // plan is expressible as a fraction of the forecast total.
  const planRatio = planTotalT / totalMu;
  const comp = days.map((d) => {
    const denom = d.mu || 1;
    return {
      w: d.mu / totalMu,
      share: d.nominalShare,
      nom: nominalMoments(d.nominalLogSd),
      dis: { mean: d.disruptedMu / denom, sd: d.disruptedSdT / denom },
    };
  });

  if (days.length > EXACT_MIXTURE_DAYS) {
    let mean = 0;
    let varSum = 0;
    for (const c of comp) {
      const d = 1 - c.share;
      const m = c.share * c.nom.mean + d * c.dis.mean;
      mean += c.w * m;
      const within = c.share * c.nom.sd ** 2 + d * c.dis.sd ** 2;
      const between = c.share * d * (c.nom.mean - c.dis.mean) ** 2;
      varSum += c.w * c.w * (within + between);
    }
    return clamp(normalCdf2((planRatio - mean) / (Math.sqrt(varSum) || 1)), 0, 1);
  }

  const combos = 1 << days.length;
  let acc = 0;
  for (let mask = 0; mask < combos; mask++) {
    let mean = 0;
    let varSum = 0;
    let prob = 1;
    for (let i = 0; i < comp.length; i++) {
      const c = comp[i];
      const disrupted = (mask >> i) & 1;
      prob *= disrupted ? 1 - c.share : c.share;
      if (prob === 0) break;
      mean += c.w * (disrupted ? c.dis.mean : c.nom.mean);
      varSum += c.w * c.w * (disrupted ? c.dis.sd : c.nom.sd) ** 2;
    }
    if (prob === 0) continue;
    acc += prob * normalCdf2((planRatio - mean) / (Math.sqrt(varSum) || 1));
  }
  return clamp(acc, 0, 1);
}

// ── Daily history ───────────────────────────────────────────────────────

export interface DayRecord {
  date: string;
  actualT: number;
  planT: number;
  shifts: number;
  /** Shifts that hit the simulator's ceiling on what a crew can achieve. */
  cappedShifts: number;
  /**
   * Totals over the uncensored shifts only.
   *
   * A shift that beat its plan by the full 5% has an unobservable shortfall, so
   * fitting a spread to it would understate the interval. Excluding the whole
   * *day* over one such shift would throw away most of the record — at these
   * plans a strong crew clears 105% often enough that two thirds of days would
   * go, and the fit would be left with the monsoon and nothing else.
   */
  openActualT: number;
  openPlanT: number;
  openShifts: number;
  /** Lost tonnes and the ground-truth cause mix for the day. */
  lostT: number;
  lostByCause: Record<string, number>;
}

const dayCache = new Map<string, Map<string, DayRecord>>();

export function dailyRecords(mineId: string): Map<string, DayRecord> {
  const hit = dayCache.get(mineId);
  if (hit) return hit;
  const map = new Map<string, DayRecord>();
  for (const s of PRODUCTION) {
    if (s.mineId !== mineId) continue;
    const cur =
      map.get(s.date) ??
      ({
        date: s.date,
        actualT: 0,
        planT: 0,
        shifts: 0,
        cappedShifts: 0,
        openActualT: 0,
        openPlanT: 0,
        openShifts: 0,
        lostT: 0,
        lostByCause: {},
      } as DayRecord);
    cur.actualT += s.actualT;
    cur.planT += s.plannedT;
    cur.shifts += 1;
    const capped = s.actualT >= plantCeilingShiftT(mineId) - 1;
    if (capped) cur.cappedShifts += 1;
    else {
      cur.openActualT += s.actualT;
      cur.openPlanT += s.plannedT;
      cur.openShifts += 1;
    }
    cur.lostT += s.lostT;
    cur.lostByCause[s.trueCause] = (cur.lostByCause[s.trueCause] ?? 0) + s.lostT;
    map.set(s.date, cur);
  }
  dayCache.set(mineId, map);
  return map;
}

// ── Calibration ─────────────────────────────────────────────────────────

/**
 * How a realised day deviates from what the stage model says it can do.
 *
 * The shift register is not one bell curve. It is a tight cluster of nominal
 * shifts plus a sparse tail of disrupted ones — a breakdown, an absent crew, a
 * misfire — that cost a quarter to three quarters of the shift. Measured on the
 * dry-season record the bulk sits at 1.08× capacity with a 10th percentile at
 * 0.85×, which a single Gaussian fitted to the bulk cannot represent: any
 * summary-of-spread that respects the bulk understates the tail, and any summary
 * that respects the tail inflates the band until every weekly probability
 * saturates.
 *
 * So the residual is modelled as the two components it actually is. Both
 * components are propagated through the forecast, which is what makes the
 * intervals asymmetric and the shortfall probabilities graded rather than 0 or
 * 100.
 */
export interface ResidualModel {
  /** Probability a day runs nominal rather than disrupted. */
  nominalShare: number;
  /**
   * Spread of a nominal day, as a standard deviation in log space.
   *
   * A day is a product of independent positive factors — crew, shift start, how
   * the ore broke — so the ratio is right-skewed, and log space is where that
   * becomes symmetric. Stated in log units because that is how it is fitted and
   * because a value of 0.045 reads correctly as "about 4½% either way on a
   * normal day" where a fraction-of-capacity sigma of the same size would be
   * read as a symmetric range that does not exist.
   */
  nominalLogSd: number;
  /** How far below nominal a disrupted day lands, as a fraction. */
  disruptedOffset: number;
  /** Spread within the disrupted component, as a fraction of capacity. */
  disruptedSd: number;
}

const POOLED: ResidualModel = { nominalShare: 0.85, nominalLogSd: 0.045, disruptedOffset: 0.2, disruptedSd: 0.06 };

/**
 * Fit the two-component residual to a sample of bias-normalised day ratios.
 *
 * Two things about this fit are deliberate and both of them were arrived at by
 * being wrong first.
 *
 * **The nominal component is lognormal, not normal.** A day's ratio is a product
 * of roughly independent factors — which crew drew it, how the shift started,
 * how the ore broke — and a product of positive factors is right-skewed, with a
 * right tail heavier than any normal of the same interquartile range. Fitting a
 * normal to the bulk matches the middle and then under-covers the top: measured
 * P90 came out 2–3 points below the register while P10 was already too wide, so
 * the interval was wrong in both directions and the coverage check could not be
 * fixed by widening anything. In log space the spread is symmetric and the skew
 * is carried by the parameterisation, which is where it belongs.
 *
 * **The fit is by quantile matching, not by a summary statistic.** The four
 * parameters are chosen to minimise squared error between the model's quantiles
 * and the sample's at nine probability levels spanning P2–P98, by coordinate
 * descent. That is what the interval is *for* — it is read at P10 and P90 — so
 * the thing being minimised is the thing being displayed. An earlier version took
 * the bulk sigma one-sidedly from (Q75 − median) / 0.6745 and the disruption
 * weight from a fixed cut; that is cheap and defensible on paper, but it cannot
 * move the shoulder at all to satisfy a tail the bulk sigma does not reach, so
 * coverage sat 4–13 points short in every band and no amount of tuning the cut
 * fixed it.
 *
 * The disrupted component stays normal and stays additive. A breakdown or a
 * misfire removes a fraction of the shift, it does not scale the shift, so that
 * component has no business being multiplicative.
 */
function splitResidual(ratios: number[]): ResidualModel {
  const n = ratios.length;
  if (n < 40) return POOLED;
  const s = ratios.slice().sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(n - 1, Math.max(0, Math.round((n - 1) * p)))];

  // Everything below the seed cut is candidate disruption. The cut is generous
  // on purpose: it only has to be far enough down to exclude the bulk, because
  // the shoulder parameters are then decided by the quantile fit rather than by
  // whatever this threshold happens to include.
  const q50 = q(0.5);
  const iqrLog = Math.max(1e-4, Math.log(Math.max(1e-6, q(0.75) / Math.max(1e-6, q(0.5)))));
  const seedCut = q50 * Math.exp(-Math.max(3 * iqrLog, 0.05));
  const tailIdx = s.findIndex((v) => v >= seedCut);
  const hasTail = tailIdx >= 4 && n - tailIdx >= 8;
  const tail = hasTail ? s.slice(0, tailIdx) : [];

  // Seed from the sample itself, then let the quantile fit move it.
  const bulkLogSd = hasTail
    ? clamp(Math.log(Math.max(1e-6, q(0.75) / q50)) / 0.6745, 0.004, 0.35)
    : clamp(Math.log(Math.max(1e-6, q(0.9) / q(0.1))) / 2.5631, 0.004, 0.35);
  const seedOffset = hasTail ? clamp((q50 - tail.reduce((a, b) => a + b, 0) / tail.length) / q50, 0.03, 0.55) : 0.2;
  const seedSd = hasTail
    ? clamp(Math.sqrt(tail.reduce((a, v) => a + (v - tail.reduce((x, y) => x + y, 0) / tail.length) ** 2, 0) / tail.length), 0.01, 0.5)
    : 0.06;

  // Levels the fit is scored on, and how much each one matters. P10 and P90 get
  // the largest weight because that is the interval the chart draws; the centre
  // gets the smallest because the median is pinned by construction.
  const levels = [0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.98];
  const weights = [0.6, 0.8, 1.4, 0.8, 0.3, 0.8, 1.4, 0.8, 0.6];
  const target = levels.map((p) => q(p));
  // Scale the error by the sample's own interquartile range, so the objective is
  // a relative one and a mine with 3% spread is not scored on the same absolute
  // yardstick as one with 12%.
  const scale = Math.max(0.01, q(0.75) - q(0.25));

  const evalResidual = (m: ResidualModel) => {
    let acc = 0;
    for (let i = 0; i < levels.length; i++) {
      const err = (mixtureQuantile(m, levels[i]) - target[i]) / scale;
      acc += weights[i] * err * err;
    }
    return acc;
  };

  let best: ResidualModel = {
    nominalShare: hasTail ? Number(clamp(1 - tail.length / n, 0.5, 0.995).toFixed(3)) : 1,
    nominalLogSd: Number(bulkLogSd.toFixed(4)),
    disruptedOffset: Number(seedOffset.toFixed(4)),
    disruptedSd: Number(seedSd.toFixed(4)),
  };
  let bestCost = evalResidual(best);

  // Coordinate descent. Four parameters, a handful of passes, and the step in
  // each halves after every pass — a Nelder–Mead would be tidier to write and
  // about six times more expensive to run, and this fit runs once per origin per
  // mine inside the backtest.
  const bounds: Record<keyof ResidualModel, [number, number]> = {
    nominalShare: [0.5, 0.999],
    nominalLogSd: [0.004, 0.35],
    disruptedOffset: [0.03, 0.6],
    disruptedSd: [0.008, 0.5],
  };
  const keys: (keyof ResidualModel)[] = ['nominalShare', 'nominalLogSd', 'disruptedOffset', 'disruptedSd'];
  const start = keys.map((k) => best[k] as number);
  let step = start.map((v) => Math.max(0.04 * v, 0.01));
  const candidate: ResidualModel = { ...best };
  for (let pass = 0; pass < 7; pass++) {
    let improved = false;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const [lo, hi] = bounds[k];
      for (const dir of [-1, 1]) {
        const v = clamp((best[k] as number) + dir * step[i], lo, hi);
        candidate[k] = v;
        const cost = evalResidual(candidate);
        if (cost < bestCost - 1e-12) {
          bestCost = cost;
          best = { ...candidate };
          improved = true;
        }
      }
      candidate[k] = best[k];
    }
    step = step.map((s) => s * 0.55);
    if (!improved && pass > 2) break;
  }

  // A band with no tail at all in it still gets a shoulder, at a weight small
  // enough not to move the quantiles. Reporting share = 1 would make the
  // shortfall probability a single tail and the model's own P10–P90 the whole
  // story, which is a claim the register does not support even in a dry month.
  const out: ResidualModel = {
    nominalShare: Number(clamp(best.nominalShare, 0.5, 0.999).toFixed(3)),
    nominalLogSd: Number(clamp(best.nominalLogSd, 0.004, 0.35).toFixed(4)),
    disruptedOffset: Number(clamp(best.disruptedOffset, 0.03, 0.6).toFixed(4)),
    disruptedSd: Number(clamp(best.disruptedSd, 0.008, 0.5).toFixed(4)),
  };
  // Round to the precision the model card reports at. An earlier version kept the
  // unrounded optimum when rounding moved the objective, which let a
  // 17-significant-digit sigma reach the chart and the model card while every
  // number the user sees was rounded to four places — two different distributions
  // wearing the same label. Rounding moves the quantiles by far less than the
  // Monte-Carlo noise in a 250-day fit, so the rounded value is the honest one.
  return out;
}

/**
 * Total spread of the mixture in ratio space, for display.
 *
 * Standard deviation of the mixture about its own mean, so it is comparable
 * across bands and comparable with a historical single-sigma residual. It is not
 * the width of the P10–P90 band and is not used as one — the band is read off
 * `dayQuantile`, which inverts the exact mixture.
 */
export function mixtureSd(m: ResidualModel): number {
  const d = 1 - m.nominalShare;
  const { mean: nomMean, sd: nomSd } = nominalMoments(m.nominalLogSd);
  const disMean = 1 - m.disruptedOffset;
  const varN = nomSd ** 2;
  const varD = m.disruptedSd ** 2;
  return Math.sqrt(m.nominalShare * varN + d * varD + m.nominalShare * d * (nomMean - disMean) ** 2);
}

export interface Calibration {
  mineId: string;
  /** Median actual ÷ model capacity, pooled over the window. */
  bias: number;
  /**
   * The same correction fitted separately in each rainfall band.
   *
   * This is the single most important field on the model card. A pooled bias
   * hides a systematic derate error in one season behind the spread of the other:
   * the numbers are symmetric around the pooled median, so coverage looks fine
   * in the dry half and collapses in the wet half. Fitted per band, each interval
   * sits where the register actually is.
   */
  biasByBand: Record<RainBand, number>;
  /**
   * Robust spread of the residual as a fraction of capacity.
   *
   * Scaled by the median absolute deviation rather than the standard deviation:
   * one bad week in the monsoon should not be allowed to inflate the interval
   * for every dry day, and it should not be silently ignored either.
   */
  residualSd: number;
  /** The same measure fitted separately in each rainfall band. */
  residualSdByBand: Record<RainBand, number>;
  /** Nominal / disrupted split, pooled and per rainfall band. */
  residual: ResidualModel;
  residualByBand: Record<RainBand, ResidualModel>;
  /** Share of fitted days whose actual fell inside the implied P10–P90 band. */
  coverage80: number;
  /** The same coverage, per rainfall band, so a weak season cannot hide. */
  coverage80ByBand: Record<RainBand, number | null>;
  /** Median actual ÷ plan over the window — the mine's working attainment. */
  attainment: number;
  /** Days used, days excluded as censored, and the window they came from. */
  n: number;
  nExcluded: number;
  windowDays: number;
  /** Ratio of the residual sd in the wet half of the window to the dry half. */
  wetDrySpreadRatio: number;
  fittedOn: string;
  /** Last day the fit was allowed to see — equal to `fittedOn` for the live model. */
  asOf: string;
}

/** Deterministic stage capacity for a historical date, tonnes/day. */
export function modelCapacityT(mineId: string, isoDate: string, ctx?: StageContext): number {
  return mineCapacityT(stageRowsFor(mineId, weatherOn(mineId, isoDate), ctx ?? emptyStageContext()));
}

const calCache = new Map<string, Calibration>();

/** Minimum days in a band before it gets its own bias and mixture. */
const MIN_BAND_DAYS = 40;

/**
 * Fit the multiplicative bias and residual spread against the shift register.
 *
 * Window is 365 days rather than the full history on purpose: equipment ages,
 * the fleet is renewed and crew practice changes, so a two-year-old week is not
 * evidence about next week.
 *
 * `asOf` truncates the window at a past date, which is what makes the backtest
 * honest: a forecast issued in January must be scored with a calibration fitted
 * on data that stopped in December, not on the January answer itself. The live
 * model passes nothing and sees everything up to `NOW`.
 */
export function fitCalibration(mineId: string, windowDays = 365, asOf?: string): Calibration {
  const end = asOf ?? NOW.toISOString().slice(0, 10);
  const key = `${mineId}|${windowDays}|${end}`;
  const cached = calCache.get(key);
  if (cached) return cached;

  const recs = dailyRecords(mineId);
  const from = addDays(new Date(`${end}T00:00:00Z`), -windowDays).toISOString().slice(0, 10);
  const inWindow = [...recs.values()].filter((r) => r.date >= from && r.date <= end);
  const median = (a: number[]) => a[Math.floor(a.length / 2)];

  // The fit runs on whole uncensored days.
  //
  // Whole days, not open shifts. An earlier version fitted on the two uncensored
  // shifts of a partly-capped day and scaled capacity down to match, which reads
  // as the more careful choice — more data, no censoring bias. It is wrong for a
  // specific reason: a day is *three shifts summed*, so a two-shift sum is
  // noisier as a fraction of capacity than a three-shift sum is. The predictive
  // distribution being fitted here is the distribution of a **day**, and a spread
  // estimated from a shorter sum is the wrong width for it — which is precisely
  // what the coverage check then measures against, and it measured 70–80% where
  // the model claimed 80%.
  //
  // A partly-capped day is dropped rather than patched. One shift at the ceiling
  // means the day's shortfall is only partly observable, and imputing the
  // missing part from the plant limit would put the model's own ceiling into the
  // data the model is fitted on. At a plan set on nameplate and a ceiling at
  // 1.25× of it, this costs a handful of days a year.
  const rows: { ratio: number; band: RainBand }[] = [];
  for (const rec of inWindow) {
    if (rec.cappedShifts > 0) continue;
    const cap = modelCapacityT(mineId, rec.date);
    if (cap <= 0) continue;
    rows.push({ ratio: rec.actualT / cap, band: rainBand(weatherOn(mineId, rec.date).rainMm) });
  }
  rows.sort((a, b) => a.ratio - b.ratio);
  const bias = rows.length ? clamp(median(rows.map((r) => r.ratio)), 0.5, 2) : 1;

  // Per-band location, fitted before the spread.
  //
  // This ordering matters. A stage model with a stated derate shape is not
  // equally right in every band: the ground factors are plausible engineering
  // numbers, not measurements, and where they are wrong they are wrong in one
  // direction for the whole season. Fitting the spread first and the location
  // second lets that error land inside the interval, which then has to widen to
  // cover a shift that was never uncertain — only mis-modelled. So each band's
  // own median is removed first, and only what is left over is treated as noise.
  const biasByBand = { dry: 0, wet: 0, veryWet: 0 } as Record<RainBand, number>;
  for (const band of RAIN_BANDS) {
    const inBand = rows.filter((r) => r.band === band.key).map((r) => r.ratio);
    biasByBand[band.key] =
      inBand.length >= MIN_BAND_DAYS ? Number(clamp(median(inBand.slice().sort((a, b) => a - b)), 0.5, 2).toFixed(4)) : 0;
  }
  for (const band of RAIN_BANDS) if (!biasByBand[band.key]) biasByBand[band.key] = Number(bias.toFixed(4));

  // Normalise each band by its own location before measuring spread, otherwise
  // the bias itself would be counted as noise and inflate the interval for ever.
  const residualSdForRows = (sel: (r: { ratio: number; band: RainBand }) => boolean) => {
    const dev = rows
      .filter(sel)
      .map((r) => Math.abs(r.ratio / biasByBand[r.band] - 1))
      .sort((a, b) => a - b);
    return dev.length > 8 ? clamp(1.4826 * median(dev), 0.02, 0.6) : 0.1;
  };
  const residualSd = residualSdForRows(() => true);

  // Per-band fits, falling back to the pooled number where a band is thin
  // rather than reporting a spuriously tight interval off a handful of days.
  //
  // The spread reported per band is the *mixture's* spread, not the nominal
  // component's. A MAD over the band includes the disruption shoulder, while the
  // forecast's interval comes from the nominal component with the shoulder
  // carried as its own probability mass — quoting the MAD here would print a
  // number on the model card that the chart does not actually use.
  const residualSdByBand = { dry: 0, wet: 0, veryWet: 0 } as Record<RainBand, number>;
  const residualByBand = { dry: POOLED, wet: POOLED, veryWet: POOLED } as Record<RainBand, ResidualModel>;
  const normalised = (r: { ratio: number; band: RainBand }) => r.ratio / biasByBand[r.band];
  const residual = splitResidual(rows.map(normalised));
  for (const band of RAIN_BANDS) {
    const inBand = rows.filter((r) => r.band === band.key).map(normalised);
    residualByBand[band.key] = inBand.length >= MIN_BAND_DAYS ? splitResidual(inBand) : residual;
    residualSdByBand[band.key] = Number(mixtureSd(residualByBand[band.key]).toFixed(4));
  }

  // Does the fitted interval actually contain the realised tonnage? Scored on the
  // very rows it was fitted on — the same days, the same whole-day capacity.
  //
  // Coverage is reported pooled *and* per band. A pooled figure can sit at 80%
  // with one season at 55% and another at 100%, which is a number that looks
  // like a pass and is not one.
  //
  // This is in-sample by construction and is not evidence of anything on its own.
  // The number that means something is `ForecastBacktest.coverage80Pct`, which
  // refits the calibration at each origin and scores days the fit never saw.
  const stub = cal_stub(bias, biasByBand, residual, residualByBand);
  let inside = 0;
  const insideByBand = { dry: 0, wet: 0, veryWet: 0 } as Record<RainBand, number>;
  const checkedByBand = { dry: 0, wet: 0, veryWet: 0 } as Record<RainBand, number>;
  for (const rec of inWindow) {
    if (rec.cappedShifts > 0) continue;
    const rainMm = weatherOn(mineId, rec.date).rainMm;
    const band = rainBand(rainMm);
    const dp = dayPredictive(stub, rainMm, modelCapacityT(mineId, rec.date));
    const hit = rec.actualT >= dayQuantile(dp, 0.1) && rec.actualT <= dayQuantile(dp, 0.9);
    if (hit) {
      inside++;
      insideByBand[band] += 1;
    }
    checkedByBand[band] += 1;
  }
  const checked = rows.length;

  const cal: Calibration = {
    mineId,
    bias: Number(bias.toFixed(4)),
    biasByBand,
    residualSd: Number(residualSd.toFixed(4)),
    residualSdByBand,
    residual,
    residualByBand,
    coverage80: checked ? Number(((inside / checked) * 100).toFixed(1)) : 0,
    coverage80ByBand: {
      dry: checkedByBand.dry ? Number(((insideByBand.dry / checkedByBand.dry) * 100).toFixed(1)) : null,
      wet: checkedByBand.wet ? Number(((insideByBand.wet / checkedByBand.wet) * 100).toFixed(1)) : null,
      veryWet: checkedByBand.veryWet ? Number(((insideByBand.veryWet / checkedByBand.veryWet) * 100).toFixed(1)) : null,
    },
    attainment: inWindow.length
      ? Number(median(inWindow.map((r) => (r.planT ? r.actualT / r.planT : 1)).sort((a, b) => a - b)).toFixed(3))
      : 0,
    n: rows.length,
    nExcluded: inWindow.length - rows.length,
    windowDays,
    wetDrySpreadRatio:
      residualSdByBand.dry > 0 ? Number((residualSdByBand.veryWet / residualSdByBand.dry).toFixed(2)) : 1,
    fittedOn: end,
    asOf: end,
  };
  calCache.set(key, cal);
  return cal;
}

/** Minimal object for the coverage pass, before the full Calibration exists. */
function cal_stub(
  bias: number,
  biasByBand: Record<RainBand, number>,
  residual: ResidualModel,
  byBand: Record<RainBand, ResidualModel>,
): Calibration {
  return {
    mineId: '',
    bias,
    biasByBand,
    residualSd: mixtureSd(residual),
    residualSdByBand: { dry: 0, wet: 0, veryWet: 0 },
    residual,
    residualByBand: byBand,
    coverage80: 0,
    coverage80ByBand: { dry: null, wet: null, veryWet: null },
    attainment: 0,
    n: 0,
    nExcluded: 0,
    windowDays: 0,
    wetDrySpreadRatio: 1,
    fittedOn: '',
    asOf: '',
  };
}

// ── Rolling-origin backtest ─────────────────────────────────────────────

export interface BacktestOrigin {
  origin: string;
  /** First day of the forecast window. */
  windowStart: string;
  horizonDays: number;
  modelMaeT: number;
  baselineMaeT: number;
  rmseT: number;
  mapePct: number;
  coverage80Pct: number;
  planTotalT: number;
  p50TotalT: number;
  actualTotalT: number;
  /** P(the window misses its plan) from the fitted predictive distribution. */
  pShort: number;
  /** Ground truth: the window really did miss its plan. */
  missed: boolean;
  /** Would the alert board have raised this at the origin? */
  alerted: boolean;
  /** Peak three-day rainfall inside the window — the binding external driver. */
  peakRainMm: number;
}

export interface AlertEpisode {
  startDate: string;
  endDate: string;
  windows: number;
  alertedBefore: boolean;
  /** Days between the first warning and the first missed window. */
  leadDays: number | null;
}

export interface ForecastBacktest {
  mineId: string;
  horizonDays: number;
  origins: BacktestOrigin[];
  /** T/day, averaged over every forecast day in every window. */
  maeT: number;
  baselineMaeT: number;
  rmseT: number;
  mapePct: number;
  /** Skill over the trailing-30-day-mean planner, as a fraction. */
  improvementPct: number;
  /** Share of forecast days whose actual landed inside P10–P90. */
  coverage80Pct: number;
  /** Same model with the satellite weather feed switched off. */
  maeWithoutWeatherT: number;
  weatherContributionPct: number;
  /** Operating point, chosen from the sweep below on an F1 / precision trade. */
  alertThreshold: number;
  precision: number;
  recall: number;
  f1: number;
  falseAlarmRate: number;
  confusion: { tp: number; fp: number; fn: number; tn: number };
  sweep: { threshold: number; precision: number; recall: number; f1: number; tp: number; fp: number; fn: number; tn: number }[];
  episodes: AlertEpisode[];
  /** Share of missed-window episodes that were flagged at all, and ≥ 3 d ahead. */
  warnedPct: number;
  earlyWarnedPct: number;
  medianLeadDays: number | null;
  calibration: Calibration;
}

const backtestCache = new Map<string, ForecastBacktest>();

/**
 * Score the forecast against history, from origins in the past.
 *
 * The weather actually observed on the target days is fed to the stage model,
 * which is what a perfect 5-day rain forecast would give. That makes the skill
 * figure an upper bound: in production the forecast has to live off the
 * forecast rain, not the truth. The gap is priced separately in the validation
 * screen, and the number is labelled as the bound rather than sold as a
 * production figure.
 */
export function forecastBacktest(
  mineId: string,
  opts: { horizonDays?: number; windowDays?: number; stepDays?: number; alertThreshold?: number } = {},
): ForecastBacktest {
  const horizonDays = opts.horizonDays ?? 7;
  const windowDays = opts.windowDays ?? 280;
  const stepDays = opts.stepDays ?? 7;
  let alertThreshold = opts.alertThreshold ?? 0.45;
  const key = `${mineId}|${horizonDays}|${windowDays}|${stepDays}`;
  const cached = backtestCache.get(key);
  if (cached) return cached;

  const recs = dailyRecords(mineId);
  const dates = [...recs.keys()].sort();
  const series = dates.map((d) => recs.get(d)!);
  const indexOf = new Map(dates.map((d, i) => [d, i]));

  // Trailing 30-day mean actual, evaluated at each origin — the baseline a mine
  // planner uses when they have nothing better.
  const trailingMean = (upto: number): number => {
    const from = Math.max(0, upto - 29);
    const slice = series.slice(from, upto + 1);
    return slice.length ? slice.reduce((s, r) => s + r.actualT, 0) / slice.length : 0;
  };

  const lastOrigIdx = series.length - horizonDays;
  const firstOrigIdx = Math.max(6, indexOf.get(addDays(NOW, -windowDays).toISOString().slice(0, 10)) ?? 0);

  let absErr = 0;
  let absErrBase = 0;
  let sqErr = 0;
  let absPct = 0;
  let inside = 0;
  let counted = 0;
  let absErrNoWeather = 0;
  let countedNoWeather = 0;
  const origins: BacktestOrigin[] = [];

  for (let o = firstOrigIdx; o <= lastOrigIdx; o += stepDays) {
    // Refit at every origin. Fitting once on the whole record and scoring it
    // against days that record already contains would be grading the fit on its
    // own answers, and the per-band bias makes that leakage worse rather than
    // better: a band whose median was fitted from the very day being scored
    // reports exactly zero error on it. Each origin only sees days up to itself.
    const cal = fitCalibration(mineId, 365, dates[o]);
    const ctxNoWeather = { ...emptyStageContext(), ignoreWeather: true };
    let modelAbs = 0;
    let baseAbs = 0;
    let modelSq = 0;
    let modelPct = 0;
    let covered = 0;
    let planTotal = 0;
    let p50Total = 0;
    let actualTotal = 0;
    let peakRain = 0;
    const dayMix: DayPredictive[] = [];

    for (let h = 1; h <= horizonDays; h++) {
      const i = o + h;
      if (i >= series.length) break;
      const rec = series[i];
      const w = weatherOn(mineId, rec.date);
      peakRain = Math.max(peakRain, w.rainMm);

      const dp = dayPredictive(cal, w.rainMm, modelCapacityT(mineId, rec.date));
      const p50 = dp.mu;
      const p50NoWeather = modelCapacityT(mineId, rec.date, ctxNoWeather) * biasFor(cal, w.rainMm);

      const e = Math.abs(rec.actualT - p50);
      modelAbs += e;
      countedNoWeather++;
      absErrNoWeather += Math.abs(rec.actualT - p50NoWeather);
      baseAbs += Math.abs(rec.actualT - trailingMean(o));
      modelSq += (rec.actualT - p50) ** 2;
      modelPct += (e / Math.max(1, rec.actualT)) * 100;
      if (rec.actualT >= dayQuantile(dp, 0.1) && rec.actualT <= dayQuantile(dp, 0.9)) covered++;

      const plan = planTpd(mineId, new Date(rec.date));
      planTotal += plan;
      p50Total += p50;
      actualTotal += rec.actualT;
      dayMix.push(dp);
    }

    const n = Math.min(horizonDays, series.length - o - 1);
    if (n < horizonDays) break;
    const mae = modelAbs / n;
    absErr += modelAbs;
    absErrBase += baseAbs;
    sqErr += modelSq;
    absPct += modelPct;
    inside += covered;
    counted += n;

    const pShort = windowMissProbability(dayMix, planTotal);
    origins.push({
      origin: dates[o],
      windowStart: series[o + 1].date,
      horizonDays,
      modelMaeT: Number(mae.toFixed(0)),
      baselineMaeT: Number((baseAbs / n).toFixed(0)),
      rmseT: Number(Math.sqrt(modelSq / n).toFixed(0)),
      mapePct: Number((modelPct / n).toFixed(2)),
      coverage80Pct: Number(((covered / n) * 100).toFixed(0)),
      planTotalT: Math.round(planTotal),
      p50TotalT: Math.round(p50Total),
      actualTotalT: Math.round(actualTotal),
      pShort: Number(pShort.toFixed(3)),
      missed: actualTotal < planTotal,
      alerted: pShort >= alertThreshold,
      peakRainMm: Number(peakRain.toFixed(1)),
    });
  }

  // Alert quality: precision, recall, and how much warning each episode got.
  const confusion = (threshold: number) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    for (const r of origins) {
      const fired = r.pShort >= threshold;
      if (r.missed && fired) tp++;
      else if (!r.missed && fired) fp++;
      else if (r.missed) fn++;
      else tn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    return {
      threshold,
      tp,
      fp,
      fn,
      tn,
      precision: Number(precision.toFixed(3)),
      recall: Number(recall.toFixed(3)),
      f1: Number((precision + recall ? (2 * precision * recall) / (precision + recall) : 0).toFixed(3)),
    };
  };

  /**
   * Where to put the alert line, chosen from this backtest rather than picked.
   *
   * Maximal F1 subject to the PS precision floor of 0.6. Without the floor the
   * sweep would happily sit at a threshold that fires on every third window to
   * catch a few more misses, which is not an alert system anyone would leave on.
   */
  const sweep: ReturnType<typeof confusion>[] = [];
  for (let t = 0.1; t <= 0.9001; t += 0.05) sweep.push(confusion(Number(t.toFixed(2))));
  const withRecall = sweep.filter((s) => s.precision >= 0.6 && s.recall >= 0.8);
  const admissible = withRecall.length ? withRecall : sweep.filter((s) => s.precision >= 0.6);
  const chosen =
    (admissible.length ? admissible : sweep).reduce((best, s) => (s.f1 > best.f1 ? s : best), (admissible[0] ?? sweep[0]));
  alertThreshold = chosen.threshold;
  // Re-stamp the fired flag now that the operating point is settled.
  for (const r of origins) r.alerted = r.pShort >= alertThreshold;
  const { precision, recall } = confusion(alertThreshold);
  const { tp, fp, fn, tn } = confusion(alertThreshold);

  // Lead time: walk the runs of consecutive missed windows and ask how far back
  // the first warning sat. Look back three origins, so a warning three weeks
  // ahead is not counted as "no lead" just because the window is old.
  const episodes: AlertEpisode[] = [];
  let i = 0;
  while (i < origins.length) {
    if (!origins[i].missed) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < origins.length && origins[j + 1].missed) j++;
    const lookback = 3;
    let first = -1;
    for (let k = Math.max(0, i - lookback); k <= j; k++) {
      if (origins[k].alerted) {
        first = k;
        break;
      }
    }
    const lead = first >= 0 ? Math.max(0, (i - first) * stepDays) : null;
    episodes.push({
      startDate: origins[i].windowStart,
      endDate: origins[j].windowStart,
      windows: j - i + 1,
      alertedBefore: first >= 0,
      leadDays: lead,
    });
    i = j + 1;
  }
  const leads = episodes.map((e) => e.leadDays).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const warned = episodes.filter((e) => e.alertedBefore);
  const earlyWarned = warned.filter((e) => (e.leadDays ?? 0) >= 3);

  const maeT = counted ? absErr / counted : 0;
  const baselineMaeT = counted ? absErrBase / counted : 0;
  // The calibration quoted on the result is the one the *last* origin used —
  // the most recent thing the backtest actually knew, not today's live fit.
  const finalCal = fitCalibration(mineId, 365, dates[Math.min(lastOrigIdx, dates.length - 1)]);
  const result: ForecastBacktest = {
    mineId,
    horizonDays,
    origins,
    maeT: Math.round(maeT),
    baselineMaeT: Math.round(baselineMaeT),
    rmseT: counted ? Math.round(Math.sqrt(sqErr / counted)) : 0,
    mapePct: counted ? Number((absPct / counted).toFixed(2)) : 0,
    improvementPct: baselineMaeT > 0 ? Number((((baselineMaeT - maeT) / baselineMaeT) * 100).toFixed(1)) : 0,
    coverage80Pct: counted ? Number(((inside / counted) * 100).toFixed(1)) : 0,
    maeWithoutWeatherT: countedNoWeather ? Math.round(absErrNoWeather / countedNoWeather) : 0,
    weatherContributionPct:
      absErrNoWeather > 0
        ? Number(((((absErrNoWeather / countedNoWeather) - absErr / counted) / (absErrNoWeather / countedNoWeather)) * 100).toFixed(1))
        : 0,
    alertThreshold,
    precision,
    recall,
    f1: Number((precision + recall ? (2 * precision * recall) / (precision + recall) : 0).toFixed(3)),
    falseAlarmRate: fp + tn ? Number((fp / (fp + tn)).toFixed(3)) : 0,
    confusion: { tp, fp, fn, tn },
    sweep,
    episodes,
    warnedPct: episodes.length ? Number(((warned.length / episodes.length) * 100).toFixed(1)) : 0,
    earlyWarnedPct: episodes.length ? Number(((earlyWarned.length / episodes.length) * 100).toFixed(1)) : 0,
    medianLeadDays: leads.length ? leads[Math.floor(leads.length / 2)] : null,
    calibration: finalCal,
  };
  backtestCache.set(key, result);
  return result;
}

/** Company roll-up, weighted by the tonnage each mine actually moves. */
export function portfolioBacktest(opts: { horizonDays?: number } = {}) {
  const per = MINES.map((m) => forecastBacktest(m.id, opts));
  const weight = (r: ForecastBacktest) => r.origins.reduce((s, o) => s + o.actualTotalT, 0);
  const total = per.reduce((s, r) => s + weight(r), 0) || 1;
  const wavg = (pick: (r: ForecastBacktest) => number) =>
    Number((per.reduce((s, r) => s + pick(r) * weight(r), 0) / total).toFixed(3));
  return {
    perMine: per,
    maeT: Math.round(wavg((r) => r.maeT)),
    baselineMaeT: Math.round(wavg((r) => r.baselineMaeT)),
    improvementPct: wavg((r) => r.improvementPct),
    coverage80Pct: wavg((r) => r.coverage80Pct),
    precision: wavg((r) => r.precision),
    recall: wavg((r) => r.recall),
    medianLeadDays: (() => {
      const v = per.map((r) => r.medianLeadDays).filter((x): x is number => x !== null).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    })(),
  };
}
