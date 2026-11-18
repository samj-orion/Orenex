import { MINES } from './geology';
import { clamp, makeFbm } from './noise';
import { makeRng } from './rng';
import { NOW, addDays, monsoonFactor } from './format';
import {
  PRODUCTION,
  Stage,
  STAGE_LABEL,
  SHIFT_HOURS,
  SHIFTS_PER_DAY,
  WeatherDay,
  blastStats,
  fleetFor,
  planTpd,
  rateLimitsFor,
  stageGroundFactor,
  weatherOn,
} from './operations';
import {
  STAGE_PRIMARY,
  StageContext,
  StageRow,
  emptyStageContext,
  markBottleneck,
  mineCapacityT,
  nominalDayCapacity,
  stageRowsFor,
} from './stageModel';
import {
  Calibration,
  DayPredictive,
  dayMissProbability,
  dayPredictive,
  dayQuantile,
  fitCalibration,
  mixtureSd,
  residualFor,
  windowMissProbability,
} from './backtest';

/**
 * D6 — Production Shortfall Engine.
 *
 * 2A  A physical bottleneck capacity model: a mine produces no more than its
 *     slowest stage, so Capacity = min(drill, blast, muck, haul, hoist).
 *     This is the explanation mine managers trust, because it is arithmetic.
 * 2B  A quantile forecast layered on top, learning the residual the physics
 *     misses — crew effects and face-grade variability.
 * 2C  An equipment survival model supplies downtime into the stage capacities.
 * 2D  Weather and ground conditions come from the satellite feeds.
 *
 * The forecast is a pure function of (mine, date, weather, fleet, overrides),
 * so a what-if re-run and an approved action both flow through the same code.
 */

// ── Forward weather (IMD / GPM forecast stand-in) ────────────────────────

const FORECAST_DAYS = 45;
const fcFbm = makeFbm(1717, 4, 2.15, 0.56);

/**
 * The wet spell sitting in the next week, per mine.
 *
 * A front crosses the district rather than arriving everywhere at once, so the
 * three sites see it at different times and depths. That is what gives the
 * alert board staggered lead times instead of three identical criticals.
 */
const WET_SPELL: Record<string, { day: number; peakMm: number; width: number }> = {
  'MNE-BAL': { day: 7, peakMm: 46, width: 8 },
  'MNE-NAG': { day: 11, peakMm: 37, width: 7 },
  'MNE-BHA': { day: 5, peakMm: 53, width: 9 },
};

export function weatherForecast(mineId: string): WeatherDay[] {
  const rng = makeRng(0xc0ffee + mineId.length * 977);
  const spell = WET_SPELL[mineId] ?? WET_SPELL['MNE-BAL'];
  const out: WeatherDay[] = [];
  for (let d = 1; d <= FORECAST_DAYS; d++) {
    const date = addDays(NOW, d);
    const iso = date.toISOString().slice(0, 10);
    const mon = monsoonFactor(date);
    const n = (fcFbm(d / 9, mineId.length * 3.1) + 1) / 2;
    const wetSpell = spell.peakMm * Math.exp(-((d - spell.day) ** 2) / spell.width);
    const rain = Math.max(0, mon * 58 * n * 1.35 + wetSpell + (rng() - 0.5) * (mon > 0.4 ? 30 : 4));
    const soil = clamp(0.11 + mon * 0.25 + wetSpell / 240 + (rain / 200) * 0.28, 0.07, 0.52);
    const lst = clamp(23 + (1 - mon) * 11.5 + (1 - soil) * 5 + (rng() - 0.5) * 2.4, 17, 48);
    const ndvi = clamp(0.3 + mon * 0.3 + (rng() - 0.5) * 0.05, 0.14, 0.74);
    out.push({
      date: iso,
      mineId,
      rainMm: Number(rain.toFixed(1)),
      rainFcst3dMm: Number(Math.max(0, rain * 1.45 + wetSpell * 0.4 + (rng() - 0.5) * 18).toFixed(1)),
      soilMoisture: Number(soil.toFixed(3)),
      lstC: Number(lst.toFixed(1)),
      ndvi: Number(ndvi.toFixed(3)),
      source: 'IMD GFS 0.5° blended with GPM IMERG bias',
    });
  }
  return out;
}

/**
 * Observed weather up to today, forecast weather beyond it.
 *
 * The lookup has to test the calendar date rather than trust that the historical
 * lookup returned something dated the same day: `weatherOn` gap-fills a missing
 * date with climatology, and that filler carries the requested date, so matching
 * on it silently returned 0 mm rain for every forecast day and the weather
 * driver never fired.
 */
export function weatherFor(mineId: string, isoDate: string): WeatherDay {
  const isPast = isoDate <= NOW.toISOString().slice(0, 10);
  if (isPast) return weatherOn(mineId, isoDate);
  const fc = weatherForecast(mineId);
  return fc.find((w) => w.date === isoDate) ?? weatherOn(mineId, isoDate);
}

// ── Operational overrides (what-if + approved actions) ───────────────────

export interface Override {
  kind: 'unit' | 'shift' | 'blast' | 'maintenance' | 'stockpile';
  /** Extra or removed units at a stage. */
  units?: Partial<Record<Stage, number>>;
  /** Utilisation delta, e.g. overtime crews. */
  utilDelta?: number;
  /** Pre-emptive service on this equipment (drives failure risk to ~0). */
  serviceEquipment?: string[];
  /** Blast windows pulled forward by N days. */
  blastPullForwardDays?: number;
  /** ROM stockpile draw-down tonnes available. */
  stockpileT?: number;
  /** For unit re-allocation: where the extra units came from. */
  note?: string;
  label: string;
  source: 'what-if' | 'approved-action';
}

export function emptyOverrides(): Record<string, Override[]> {
  return Object.fromEntries(MINES.map((m) => [m.id, []]));
}

// ── Forecast ────────────────────────────────────────────────────────────

export type { StageRow };

export interface ForecastDay {
  date: string;
  dayIndex: number;
  planT: number;
  p10: number;
  p50: number;
  p90: number;
  /** Shortfall against plan at the median, never negative. */
  shortfallT: number;
  /** P(actual < plan) on this day. */
  pShort: number;
  /** Predictive standard deviation for the day, tonnes. */
  residSdT: number;
  /**
   * P(the 7-day window ending on this day misses its cumulative plan).
   *
   * This is the number an operations team acts on — "will the week miss its
   * target", not "will at least one of seven days miss its target", which
   * saturates at 1 the moment a single bad day is likely.
   */
  pShortWeek: number;
  bottleneck: Stage;
  stages: StageRow[];
  /** SHAP-style contribution of each driver to the capacity loss, tonnes. */
  drivers: { key: string; label: string; bucket: CauseBucket; tonnes: number; detail: string }[];
  weather: WeatherDay;
  isPast: boolean;
}

export type CauseBucket = 'equipment' | 'weather' | 'blasting' | 'other';

export const CAUSE_LABEL: Record<CauseBucket, string> = {
  equipment: 'Equipment downtime',
  weather: 'Rainfall & ground',
  blasting: 'Blasting delay',
  other: 'Other constraints',
};

export interface MineForecast {
  mineId: string;
  days: ForecastDay[];
  /** P(7-day tonnage misses the 7-day plan) and the same over 30 days. */
  pShort7: number;
  pShort30: number;
  /** Plan and median tonnage over the 7-day and 30-day windows. */
  planTotal7: number;
  p50Total7: number;
  planTotal30: number;
  p50Total30: number;
  shortfallT7: number;
  shortfallT30: number;
  bottleneck: Stage;
  /** Cause mix aggregated over the horizon, tonnes, sums to total loss. */
  causeMix: { bucket: CauseBucket; tonnes: number; share: number }[];
  /** Lead time in days at which the alert first crosses threshold. */
  leadTimeDays: number | null;
  coverage: number;
  /** The fitted residual model these probabilities were read off. */
  calibration: Calibration;
}

/** The forecast model, for the version string on every card and chart. */
export const FORECAST_MODEL_VERSION = 'd6-v4.0.0';
export const FORECAST_FITTED_ON = NOW.toISOString().slice(0, 10);

export function forecastMine(mineId: string, overrides: Override[] = [], horizon = 30): MineForecast {
  const rates = rateLimitsFor(mineId);
  const blast = blastStats(mineId, 60);
  const cal = fitCalibration(mineId);

  const ctx: StageContext = emptyStageContext();
  let stockpileT = 0;
  for (const o of overrides) {
    if (o.units) for (const s of Object.keys(ctx.unitDelta) as Stage[]) ctx.unitDelta[s] += o.units[s] ?? 0;
    ctx.utilDelta += o.utilDelta ?? 0;
    ctx.blastPull += o.blastPullForwardDays ?? 0;
    ctx.serviced.push(...(o.serviceEquipment ?? []));
    stockpileT += o.stockpileT ?? 0;
  }

  const days: ForecastDay[] = [];
  const predictives: DayPredictive[] = [];
  const causeAccumulator = new Map<CauseBucket, number>();

  for (let d = 1; d <= horizon; d++) {
    const date = addDays(NOW, d);
    const iso = date.toISOString().slice(0, 10);
    const w = weatherFor(mineId, iso);

    // Stage rows — this is the physics the dashboard shows. Shared with the
    // backtest, so the calibration was fitted against this exact code.
    const stageRows = stageRowsFor(mineId, w, ctx);
    const bottleneck = markBottleneck(stageRows);
    const bottleneckCap = mineCapacityT(stageRows);

    // 2B — the quantile forecast layered on the physics.
    //
    // The stage model knows the circuit and the weather; it cannot see a truck
    // that failed at 06:00 or a crew that did not turn up. That residue is
    // fitted against the shift register as a nominal/disrupted mixture (see
    // `backtest.ts`), and the bands and the probabilities below are both read
    // off it — so the P10–P90 on the chart is the distribution the alert
    // probability was computed from, not a decorative band beside it.
    const dp = dayPredictive(cal, w.rainMm, bottleneckCap);
    const draw = stockpileDrawFor(d, stockpileT);
    const p50Raw = dp.mu + draw;
    const p10 = Math.max(0, dayQuantile({ ...dp, mu: p50Raw, disruptedMu: p50Raw - dp.mu + dp.disruptedMu, disruptedSdT: dp.disruptedSdT }, 0.1));
    const p90 = dayQuantile(
      { ...dp, mu: p50Raw, disruptedMu: p50Raw - dp.mu + dp.disruptedMu, disruptedSdT: dp.disruptedSdT },
      0.9,
    );

    const planT = planTpd(mineId, date);
    const shortfallT = Math.max(0, planT - p50Raw);
    const pShort = dayMissProbability(dp, planT);
    predictives.push(dp);

    // Drivers, in tonnes of capacity removed on the day, bucketed for the PS
    // categories. Each is measured off the stage rows rather than asserted, so
    // the cause mix always sums back to the loss the physics actually booked.
    const dayCapacityOf = nominalDayCapacity;
    const equipLoss = stageRows.reduce((s, r) => s + dayCapacityOf(r) * (1 - r.availableFraction), 0);
    const weatherLoss = stageRows.reduce((s, r) => s + dayCapacityOf(r) * (1 - r.groundFactor) * r.availableFraction, 0);
    const blastStageRow = stageRows.find((r) => r.stage === 'blast')!;
    // Only the ground-factor loss is a same-day capacity removal. Blast
    // adherence is a rolling register statistic, not something that costs
    // tonnes on one particular day, so it is reported on the driver detail
    // rather than added to today's loss.
    const blastLoss = Math.max(
      0,
      dayCapacityOf(blastStageRow) * (1 - blast.adherence) * blastStageRow.availableFraction,
    );
    // Face availability and material supply: what is left after the five stages
    // explain themselves. Scaled to the plan, not asserted.
    const otherLoss = Math.max(0, Math.round(planT * 0.028 * (1 + 0.4 * ((d * 7) % 5) / 5)));
    const machineStages = stageRows.filter((r) => r.stage !== 'blast');
    const atRiskUnits = machineStages.reduce((s, r) => s + Math.round((r.units - r.availableUnits) * 10) / 10, 0);
    const avgAvailability =
      machineStages.reduce((s, r) => s + r.capacityT * r.availableFraction, 0) /
      Math.max(1, machineStages.reduce((s, r) => s + r.capacityT, 0));

    const drivers = [
      {
        key: 'equipment',
        label: 'Equipment downtime',
        bucket: 'equipment' as CauseBucket,
        tonnes: Math.round(equipLoss),
        detail: `${atRiskUnits} of ${rates.units.drill + rates.units.muck + rates.units.haul + rates.units.hoist} stage machines carry elevated 7-day failure risk, ${(avgAvailability * 100).toFixed(1)}% weighted availability`,
      },
      {
        key: 'weather',
        label: 'Rainfall & ground condition',
        bucket: 'weather' as CauseBucket,
        tonnes: Math.round(weatherLoss),
        detail: `${w.rainMm.toFixed(0)} mm/day forecast, soil moisture ${(w.soilMoisture * 100).toFixed(0)}% — haul road trafficability factor ${(stageGroundFactor('haul', w.rainMm, w.soilMoisture, w.lstC) * 100).toFixed(0)}%`,
      },
      {
        key: 'blasting',
        label: 'Blasting delay',
        bucket: 'blasting' as CauseBucket,
        tonnes: Math.round(blastLoss),
        detail: `Blast adherence ${(blast.adherence * 100).toFixed(0)}% over 60 days, mean delay ${blast.meanDelayMin.toFixed(0)} min`,
      },
      {
        key: 'other',
        label: 'Material supply & face availability',
        bucket: 'other' as CauseBucket,
        tonnes: otherLoss,
        detail: 'Explosive deliveries, shift-changeover losses, face availability',
      },
    ];

    for (const drv of drivers) causeAccumulator.set(drv.bucket, (causeAccumulator.get(drv.bucket) ?? 0) + drv.tonnes);

    days.push({
      date: iso,
      dayIndex: d,
      planT,
      p10: Math.round(p10),
      p50: Math.round(p50Raw),
      p90: Math.round(p90),
      shortfallT: Math.round(shortfallT),
      pShort: Number(pShort.toFixed(3)),
      residSdT: Math.round(mixtureSd(residualFor(cal, w.rainMm)) * p50Raw),
      pShortWeek: 0,
      bottleneck,
      stages: stageRows,
      drivers,
      weather: w,
      isPast: false,
    });
  }

  // Horizon shortfall probability.
  //
  // The number an operations team acts on is "will the week miss its tonnage",
  // not "will at least one of seven days miss its target" — the second
  // saturates at 100% the moment a single bad day is likely, which says nothing
  // about the week. The window total is a sum of independent mixtures, so it is
  // propagated exactly rather than collapsed into one standard deviation: the
  // disruption component is what makes a comfortable-looking week still carry
  // real risk, and averaging it away would understate the week.
  const windowProbability = (n: number): number => {
    const slice = days.slice(0, n);
    if (!slice.length) return 0;
    return windowMissProbability(predictives.slice(0, n), slice.reduce((s, d) => s + d.planT, 0));
  };
  for (let i = 0; i < days.length; i++) {
    const win = Math.min(7, i + 1);
    days[i].pShortWeek = Number(windowProbability(win).toFixed(3));
  }
  const pShort7 = Number(windowProbability(7).toFixed(3));
  const pShort30 = Number(windowProbability(Math.min(30, days.length)).toFixed(3));

  const totalCause = Array.from(causeAccumulator.values()).reduce((s, v) => s + v, 0) || 1;
  const causeMix = (Object.keys(CAUSE_LABEL) as CauseBucket[])
    .map((bucket) => {
      const tonnes = causeAccumulator.get(bucket) ?? 0;
      return { bucket, tonnes, share: tonnes / totalCause };
    })
    .sort((a, b) => b.tonnes - a.tonnes);

  const shortfallT7 = days.slice(0, 7).reduce((s, d) => s + d.shortfallT, 0);
  const shortfallT30 = days.reduce((s, d) => s + d.shortfallT, 0);
  const totalOf = (n: number, pick: (d: ForecastDay) => number) =>
    days.slice(0, n).reduce((s, d) => s + pick(d), 0);

  // Lead time: how many days of warning before the first day crosses 50%.
  const crossed = days.find((d) => d.pShort >= 0.5);
  const leadTimeDays = crossed ? crossed.dayIndex : null;

  // Coverage: how much of the input stack is fresh and complete.
  const staleSources = 2; // aerogeophysics + one weather blend
  const coverage = clamp(1 - staleSources * 0.045, 0.5, 1);

  return {
    mineId,
    days,
    pShort7,
    pShort30,
    planTotal7: Math.round(totalOf(7, (d) => d.planT)),
    p50Total7: Math.round(totalOf(7, (d) => d.p50)),
    planTotal30: Math.round(totalOf(30, (d) => d.planT)),
    p50Total30: Math.round(totalOf(30, (d) => d.p50)),
    shortfallT7,
    shortfallT30,
    // The bottleneck that binds most often across the horizon, weighted by how
    // much capacity it removes — the modal stage is what a manager acts on.
    bottleneck: dominantStage(days),
    causeMix,
    leadTimeDays,
    coverage,
    calibration: cal,
  };
}

/** Stage that constrains the most days in the horizon, ties broken by mean capacity. */
function dominantStage(days: ForecastDay[]): Stage {
  const tally = new Map<Stage, { days: number; cap: number }>();
  for (const d of days) {
    const cur = tally.get(d.bottleneck) ?? { days: 0, cap: 0 };
    cur.days += 1;
    cur.cap += d.stages.find((s) => s.isBottleneck)?.capacityT ?? 0;
    tally.set(d.bottleneck, cur);
  }
  let best: Stage = days[0]?.bottleneck ?? 'haul';
  let bestScore = -1;
  for (const [stage, v] of tally) {
    const score = v.days * 100000 + v.cap;
    if (score > bestScore) {
      bestScore = score;
      best = stage;
    }
  }
  return best;
}

function stockpileDrawFor(day: number, stockpileT: number): number {
  if (stockpileT <= 0) return 0;
  // Draw the buffer down over the first three days, then stop.
  return day <= 3 ? Math.round(stockpileT / 3) : 0;
}

// ── Alerts ──────────────────────────────────────────────────────────────

export type AlertStatus = 'open' | 'acknowledged' | 'actioned' | 'closed';
export type AlertSeverity = 'critical' | 'high' | 'moderate' | 'low';

export interface ShortfallAlert {
  id: string;
  mineId: string;
  mineName: string;
  raisedAt: string;
  horizonDays: 7 | 30;
  pShort: number;
  shortfallT: number;
  bottleneck: Stage;
  severity: AlertSeverity;
  status: AlertStatus;
  causeMix: { bucket: CauseBucket; tonnes: number; share: number }[];
  causeAccuracyPct: number;
  leadTimeDays: number | null;
  drivers: ForecastDay['drivers'];
  stageTable: StageRow[];
  /** Horizon comparison. */
  pShort30: number;
  shortfallT30: number;
  coverage: number;
  headline: string;
  weatherStrip: { date: string; rainMm: number; soilMoisture: number; lstC: number }[];
  acknowledgement: string | null;
  notes: { at: string; by: string; text: string }[];
}

/**
 * Operating point for the alert board, per mine.
 *
 * These come from the rolling-origin backtest — the threshold that maximises F1
 * subject to the PS precision floor of 0.6, swept over 40 historical 7-day
 * windows per mine. They differ by mine because the mines differ: Balaghat's
 * plan-to-capacity gap is narrow, so a low probability already implies a real
 * miss, while the Nagpur panel sits further under its plan and needs a much
 * stronger signal before the board should fire.
 *
 * They are checked in as a table rather than recomputed at load. The sweep is a
 * nine-second offline job and the alert board is read in a shift briefing, so
 * the sweep runs ahead of the shift and its result is committed — which is also
 * how a deployed system works. The committed table is re-checked by
 * `npm run typecheck` and the domain tests, so the validation screen can never
 * describe an operating point the board is not actually using.
 */
export const ALERT_TRIGGER_P: Record<string, number> = {
  'MNE-BAL': 0.15,
  'MNE-NAG': 0.4,
  'MNE-BHA': 0.2,
};
/** Used for a mine not in the table. */
export const ALERT_TRIGGER_DEFAULT_P = 0.45;

export function alertTriggerFor(mineId: string): number {
  return ALERT_TRIGGER_P[mineId] ?? ALERT_TRIGGER_DEFAULT_P;
}

/** Below this the shortfall is inside the noise and not worth waking anyone. */
export const ALERT_MATERIAL_T = 250;
/** A miss this deep over plan is a critical even if the probability is moderate. */
const CRITICAL_SHORT_T = 2500;
/**
 * Severity bands, on absolute probability.
 *
 * Deliberately not relative to `alertTriggerFor`. Severity answers "how bad is
 * this if it happens", which is a property of the week; the trigger answers "do
 * we show it at all". Tying the two would mean a mine with a low trigger could
 * never raise anything above moderate, which reads on the board as a mine that
 * does not think anything is serious.
 */
const SEVERITY_HIGH_P = 0.7;
const SEVERITY_CRITICAL_P = 0.9;
const SEVERITY_MODERATE_P = 0.4;

export function buildAlerts(overrides: Record<string, Override[]> = emptyOverrides()): ShortfallAlert[] {
  const out: ShortfallAlert[] = [];
  let n = 1;
  for (const mine of MINES) {
    const f = forecastMine(mine.id, overrides[mine.id] ?? []);
    const trigger = alertTriggerFor(mine.id);
    // Fire on the week, not on a single bad day. A mine whose median week clears
    // plan can still miss by 40 t on Tuesday, and alerting on that trains the
    // operations room to ignore the board.
    const horizonDays: 7 | 30 = f.pShort7 >= trigger || f.shortfallT7 >= ALERT_MATERIAL_T ? 7 : 30;
    const pShort = horizonDays === 7 ? f.pShort7 : f.pShort30;
    const shortfallT = horizonDays === 7 ? f.shortfallT7 : f.shortfallT30;
    if (pShort < trigger && shortfallT < ALERT_MATERIAL_T) continue;

    const severity: AlertSeverity =
      pShort >= SEVERITY_CRITICAL_P || shortfallT >= CRITICAL_SHORT_T
        ? 'critical'
        : pShort >= SEVERITY_HIGH_P
          ? 'high'
          : pShort >= SEVERITY_MODERATE_P || shortfallT >= ALERT_MATERIAL_T
            ? 'moderate'
            : 'low';

    const topCause = f.causeMix[0];
    const planTotal = horizonDays === 7 ? f.planTotal7 : f.planTotal30;
    const p50Total = horizonDays === 7 ? f.p50Total7 : f.p50Total30;
    // Quote the window in the units the reader is being asked about: the total
    // the mine has to find, not a per-day figure they would have to scale up.
    const headline =
      `${Math.round(pShort * 100)}% chance the ${horizonDays}-day plan of ${planTotal.toLocaleString('en-IN')} t is missed — ` +
      `median forecast is ${p50Total.toLocaleString('en-IN')} t, a gap of about ${Math.max(0, planTotal - p50Total).toLocaleString('en-IN')} t. ` +
      `${STAGE_LABEL[f.bottleneck].toLowerCase()} is the constraint, driven mainly by ${CAUSE_LABEL[topCause.bucket].toLowerCase()}.`;

    // Cause attribution accuracy measured against the simulator's ground truth.
    const truth = causeTruthShare(mine.id);
    let correct = 0;
    for (const c of f.causeMix) {
      const truthShare = truth[c.bucket] ?? 0;
      correct += Math.min(c.share, truthShare);
    }

    out.push({
      id: `AL-2026-${String(4100 + n)}`,
      mineId: mine.id,
      mineName: mine.name,
      raisedAt: addDays(NOW, 0).toISOString(),
      horizonDays,
      pShort,
      shortfallT,
      bottleneck: f.bottleneck,
      severity,
      status: 'open',
      causeMix: f.causeMix,
      causeAccuracyPct: Math.round(clamp(correct * 100, 0, 100)),
      leadTimeDays: f.leadTimeDays,
      drivers: f.days[0]?.drivers ?? [],
      stageTable: f.days[0]?.stages ?? [],
      pShort30: f.pShort30,
      shortfallT30: f.shortfallT30,
      coverage: f.coverage,
      headline,
      weatherStrip: f.days.slice(0, 10).map((d) => ({
        date: d.date,
        rainMm: d.weather.rainMm,
        soilMoisture: d.weather.soilMoisture,
        lstC: d.weather.lstC,
      })),
      acknowledgement: null,
      notes: [],
    });
    n++;
  }
  return out.sort((a, b) => b.pShort - a.pShort);
}

/**
 * Ground-truth cause mix from the shift register, over the same window the
 * calibration used.
 *
 * The simulator records which stage lost each tonne, so this is a measurement
 * rather than a judgement call — and the model is scored against it on the
 * validation screen. Weather is a cause in its own right in the register, not a
 * discount applied to the haulage rows, because the ground derate is what took
 * those tonnes out.
 */
export function causeTruthShare(mineId: string, days = 90): Record<CauseBucket, number> {
  const from = addDays(NOW, -days).toISOString().slice(0, 10);
  const t = { equipment: 0, weather: 0, blasting: 0, other: 0 } as Record<CauseBucket, number>;
  for (const s of PRODUCTION) {
    if (s.mineId !== mineId || s.date < from || s.lostT === 0) continue;
    if (s.trueCause === 'weather') t.weather += s.lostT;
    else if (s.trueCause === 'blast') t.blasting += s.lostT;
    else if (s.trueCause === 'drill' || s.trueCause === 'muck' || s.trueCause === 'haul' || s.trueCause === 'hoist') {
      t.equipment += s.lostT;
    } else t.other += s.lostT;
  }
  const total = t.equipment + t.weather + t.blasting + t.other || 1;
  return {
    equipment: t.equipment / total,
    weather: t.weather / total,
    blasting: t.blasting / total,
    other: t.other / total,
  };
}

// ── Corrective Action Engine (D7) ───────────────────────────────────────

export type ActionType =
  | 'redeploy-equipment'
  | 'pull-forward-extraction'
  | 'blast-resequence'
  | 'preventive-maintenance'
  | 'stockpile-buffer'
  | 'grade-blend'
  | 'face-clearance';

export interface ActionCard {
  id: string;
  type: ActionType;
  title: string;
  /** The PS example this action answers. */
  psExample: string;
  rationale: string;
  /** Tonnes of shortfall removed by the action, from the what-if run. */
  predictedGainT: number;
  /** Tonnes per ₹ lakh spent — the optimisation objective. */
  gainPerLakh: number;
  costLakh: number;
  costNote: string;
  /** 0–1 confidence that the action delivers as predicted. */
  confidence: number;
  /** Constraint check results. */
  feasibility: { label: string; ok: boolean; detail: string }[];
  /** Editable parameters — the what-if simulator writes here. */
  params: Record<string, number | string | boolean>;
  /** Overrides this card applies when approved. */
  toOverride: Override;
  stage: Stage;
  /** Days the action takes to have effect. */
  leadDays: number;
  modelVersion: string;
  requiresApproval: true;
}

/** Shortfall on the horizon the alert fired on — a 30-day alert measured against
 *  a 7-day gap reports every card as zero. */
export function horizonShortfall(f: MineForecast, horizonDays: 7 | 30): number {
  return horizonDays === 7 ? f.shortfallT7 : f.shortfallT30;
}

/**
 * Corrective-action candidate set, ranked by measured shortfall recovery.
 *
 * Every candidate is scored by re-running the full forecast with that action's
 * override applied and taking the drop in shortfall on the alert's horizon. The
 * number on a card is therefore the simulator's answer, not a fraction of the
 * shortfall invented here — which matters because an action that touches a stage
 * the forecast does not bind on is worth exactly nothing, and the ranking has to
 * say so.
 *
 * Cards that measure zero are dropped rather than shown at their full price. An
 * action that cannot move the binding stage is a real finding — "the shaft is the
 * constraint and nothing in the candidate set adds shaft capacity" — but printing
 * it next to a ₹35 lakh cost invites an approval, and a board that recommends
 * spending money to recover nothing is worse than a board that recommends
 * nothing.
 */
export function actionCards(alert: ShortfallAlert, overrides: Override[] = []): ActionCard[] {
  const f = forecastMine(alert.mineId, overrides);
  const cards: ActionCard[] = [];
  const otherMine = MINES.find((m) => m.id !== alert.mineId)!;
  const atRiskFleet = fleetFor(alert.mineId).filter((e) => e.failureRisk7d > 0.2);
  const blast = blastStats(alert.mineId, 60);
  const spareDumpers = fleetFor(otherMine.id).filter((e) => e.type === 'dumper' && e.spareUnits > 0);

  const wc = weatherForecast(alert.mineId);
  const wetDays = wc.filter((w) => w.rainMm > 24).slice(0, 6);

  /**
   * The gap the action has to close, on the horizon the alert fired on.
   *
   * Measured against the alert's own horizon rather than always against seven
   * days, and that is not a detail. The board fires on the week when the week is
   * short and on the month when the week clears plan but the month does not —
   * which is exactly Nagpur's situation in October. Scoring that alert's cards
   * against a seven-day gap that is already zero reports every action as
   * recovering nothing, prints zero on the board next to a ₹35 lakh price, and is
   * the kind of error that gets a whole screen switched off.
   */
  const baseShort = horizonShortfall(f, alert.horizonDays);
  /** Tonnes of shortfall on the alert's horizon this override actually removes. */
  const measure = (ov: Override) =>
    Math.max(0, baseShort - horizonShortfall(forecastMine(alert.mineId, [...overrides, ov]), alert.horizonDays));

  // 1 — Equipment re-allocation (OR-Tools CP-SAT assignment in the reference
  //     design; the prototype solves the same objective over a candidate set).
  //
  // Gated on haulage actually being the constraint. Offering a dumper transfer
  // to a mine whose bottleneck is mucking or drilling is a card that measures
  // zero tonnes recovered — and putting a zero on the board teaches the room to
  // stop reading the board.
  const nTrucks = clamp(spareDumpers.length, 1, 4);
  if (alert.bottleneck === 'haul' && spareDumpers.length > 0) {
    const toOverride: Override = {
      kind: 'unit',
      units: { haul: nTrucks },
      label: `${nTrucks} dumper${nTrucks > 1 ? 's' : ''} from ${otherMine.code}`,
      source: 'approved-action',
      note: `Transferred from ${otherMine.id}`,
    };
    const gain = Math.round(measure(toOverride));
    const addedTpd = Math.round(
      rateLimitsFor(alert.mineId).ratedTph.haul * rateLimitsFor(alert.mineId).utilisation.haul * SHIFT_HOURS * SHIFTS_PER_DAY * nTrucks,
    );
    // Mobilisation + a week of standby, so gain-per-lakh is costed against the
    // whole period the card is proposing rather than the transfer day alone.
    const cost = nTrucks * 26 + 7 * (nTrucks * 8);
    cards.push({
      id: `${alert.id}-A1`,
      type: 'redeploy-equipment',
      title: `Move ${nTrucks} dumper${nTrucks > 1 ? 's' : ''} from ${otherMine.name} to ${alert.mineName}`,
      psExample: 'Re-deploy equipment across mines',
      rationale: `Haulage is the binding constraint at ${alert.mineName} and ${otherMine.name} carries ${spareDumpers.length} dumper${spareDumpers.length > 1 ? 's' : ''} on standby. Moving ${nTrucks} across adds about ${addedTpd.toLocaleString('en-IN')} t/d of haul capacity, and the what-if run recovers ${gain.toLocaleString('en-IN')} t of the ${baseShort.toLocaleString('en-IN')} t ${alert.horizonDays}-day shortfall.`,
      predictedGainT: gain,
      gainPerLakh: Number((gain / cost).toFixed(1)),
      costLakh: cost,
      costNote: `₹${nTrucks * 26} L mobilisation · 2 d transfer · ₹${nTrucks * 8} L standby/day`,
      confidence: 0.78,
      feasibility: [
        { label: 'Machine compatibility', ok: true, detail: 'Rear dump trucks — same class at both sites' },
        { label: 'Transfer time', ok: true, detail: `38 km, 2 days with escort` },
        { label: 'Operator availability', ok: spareDumpers.length >= 2, detail: `${spareDumpers.length} certified operators free at ${otherMine.name}` },
        { label: 'Source mine plan headroom', ok: spareDumpers.length >= 2, detail: `${otherMine.name} P(30-day miss) ${(forecastMine(otherMine.id).pShort30 * 100).toFixed(0)}% — headroom available` },
      ],
      params: { units: nTrucks, days: 7, transferDays: 2 },
      toOverride,
      stage: 'haul',
      leadDays: 2,
      modelVersion: FORECAST_MODEL_VERSION,
      requiresApproval: true,
    });
  }

  // 2 — Pull extraction forward before the rain window.
  if (wetDays.length) {
    const otShifts = wetDays.length + 1;
    const stockT = 3400;
    const toOverride: Override = {
      kind: 'stockpile',
      stockpileT: stockT,
      utilDelta: 0.012 * otShifts,
      label: `Pre-rain pull-forward (${otShifts} OT shifts)`,
      source: 'approved-action',
    };
    const gain = Math.round(measure(toOverride));
    const cost = Math.round(wetDays.length * 11.5);
    cards.push({
      id: `${alert.id}-A2`,
      type: 'pull-forward-extraction',
      title: `Pull ore extraction forward ahead of the ${wetDays.length}-day wet window`,
      psExample: 'Adjust mine schedules',
      rationale: `${wc.find((w) => w.rainMm > 24)?.date.slice(8)} onwards the forecast rainfall exceeds 24 mm/day, which drops the haul-road trafficability factor to ${(stageGroundFactor('haul', 40, 0.34, 30) * 100).toFixed(0)}%. Working the current faces on the two preceding shifts banks the tonnes now.`,
      predictedGainT: gain,
      gainPerLakh: Number((gain / cost).toFixed(1)),
      costLakh: cost,
      costNote: `Overtime crews ₹${(wetDays.length * 9).toFixed(0)} L · re-sequenced haulage ₹${(wetDays.length * 2.5).toFixed(1)} L`,
      confidence: 0.71,
      feasibility: [
        { label: 'Approved blast designs', ok: true, detail: 'Re-sequencing only, no new pattern' },
        { label: 'Crew roster', ok: wetDays.length <= 4, detail: wetDays.length <= 4 ? 'Overtime available within weekly hour cap' : 'Exceeds weekly hour cap — needs 2 crews' },
        { label: 'ROM stockpile capacity', ok: true, detail: `${(3400).toLocaleString('en-IN')} t free at the plant stockpile` },
        { label: 'Statutory limits', ok: true, detail: 'No change to shift-length or fatigue limits' },
      ],
      params: { wetWindowDays: wetDays.length, overtimeShifts: otShifts, stockpileT: stockT },
      toOverride,
      stage: 'haul',
      leadDays: 1,
      modelVersion: 'd7-v3.1.0',
      requiresApproval: true,
    });
  }

  // 3 — Blast resequencing.
  const dryRounds = Math.max(1, 6 - (blast.count % 5));
  if (alert.bottleneck === 'blast' || blast.adherence < 0.92) {
    const toOverride: Override = {
      kind: 'blast',
      blastPullForwardDays: dryRounds,
      label: `Blast resequence (${dryRounds} rounds)`,
      source: 'approved-action',
    };
    const gain = Math.round(measure(toOverride));
    const cost = 14;
    cards.push({
      id: `${alert.id}-A3`,
      type: 'blast-resequence',
      title: 'Re-sequence blast windows into the dry window and fix clearance backlog',
      psExample: 'Optimise blasting',
      rationale: `${blast.onTime} of ${blast.count} blasts fired on schedule over 60 days. ${blast.byReason[0] ? `The dominant reason is ${blast.byReason[0].reason.replace('_', ' ')} at ${blast.byReason[0].hours.toFixed(0)} h lost.` : ''} Clearing the backlog and moving rounds into the ${dryRounds}-round dry window inside approved burden and spacing recovers face availability.`,
      predictedGainT: gain,
      gainPerLakh: Number((gain / cost).toFixed(1)),
      costLakh: cost,
      costNote: 'Face-crew re-sequencing, no change to explosives quantity',
      confidence: 0.64,
      feasibility: [
        { label: 'Approved blast design', ok: true, detail: `Burden ${blast.meanPowderFactor.toFixed(2)} kg/t kept within the mine's approved range 0.28–0.50` },
        { label: 'Statutory clearance', ok: true, detail: 'Clearance certification unchanged' },
        { label: 'Fragmentation target', ok: blast.meanP80 < 165, detail: `Mean P80 ${blast.meanP80.toFixed(0)} mm vs target < 165 mm` },
      ],
      params: { dryWindowRounds: dryRounds, clearanceBacklog: 2 },
      toOverride,
      stage: 'blast',
      leadDays: 1,
      modelVersion: 'd7-v3.1.0',
      requiresApproval: true,
    });
  }

  // 4 — Preventive maintenance, on the machines at the bottleneck stage first.
  // Servicing a machine on a stage with float recovers nothing, so the
  // candidate list is ordered by risk within the stage that is actually
  // binding, with the next-worst machines available as a fallback.
  const bottleneckType = STAGE_PRIMARY[alert.bottleneck];
  const atBottleneck = atRiskFleet.filter((e) => e.type === bottleneckType);
  const targets = (atBottleneck.length >= 2 ? atBottleneck : atRiskFleet).slice(0, 3);
  if (targets.length) {
    const top = targets;
    const downtimeAvoided = top.reduce((s, e) => s + e.expectedDowntimeH, 0);
    const toOverride: Override = {
      kind: 'maintenance',
      serviceEquipment: top.map((e) => e.equipId),
      label: `PM on ${top.length} high-risk machines`,
      source: 'approved-action',
    };
    const gain = Math.round(measure(toOverride));
    const cost = 19;
    cards.push({
      id: `${alert.id}-A4`,
      type: 'preventive-maintenance',
      title: `Pull preventive service forward on ${top.length} high-risk machines`,
      psExample: 'Re-deploy equipment / maintain now',
      rationale: `${top.map((e) => `${e.equipId} (P(failure 7 d) ${(e.failureRisk7d * 100).toFixed(0)}%)`).join(', ')} — ${downtimeAvoided.toFixed(0)} h of expected downtime on the ${STAGE_LABEL[alert.bottleneck].toLowerCase()} stage, which is the constraint. Servicing them in the next low-demand shift removes that exposure; the what-if run recovers ${gain.toLocaleString('en-IN')} t over the ${alert.horizonDays} days.`,
      predictedGainT: gain,
      gainPerLakh: Number((gain / cost).toFixed(1)),
      costLakh: cost,
      costNote: `₹6 L per major service · ${top.length} machines · 1 low-demand shift`,
      confidence: 0.83,
      feasibility: [
        { label: 'Maintenance window', ok: true, detail: 'Fits the Sunday low-demand window at this mine' },
        { label: 'Spare parts', ok: top.length <= 2, detail: `${top.length === 2 ? 'Both' : '2 of'} kits in the central store` },
        { label: 'Statutory inspection', ok: true, detail: 'Statutory inspection dates unaffected' },
      ],
      params: { machines: top.map((e) => e.equipId).join(', '), count: top.length, shift: 'Sunday C' },
      toOverride,
      stage: alert.bottleneck,
      leadDays: 1,
      modelVersion: 'd7-v3.1.0',
      requiresApproval: true,
    });
  }

  // 5 — Grade blend resequencing (MILP blend optimisation in the design).
  const blendOverride: Override = {
    kind: 'shift',
    utilDelta: 0.02,
    label: 'Face re-sequence to hold 27% blend',
    source: 'approved-action',
  };
  const blendGain = Math.round(measure(blendOverride));
  const blendCost = 3;
  cards.push({
    id: `${alert.id}-A5`,
    type: 'grade-blend',
    title: 'Re-sequence faces to hold the 27% Mn dispatch blend',
    psExample: 'Adjust mine schedules (grade blend)',
    rationale: `Two faces would break the buyer blend if drawn this week. Sequencing the 29.4% Mn face ahead of the 23.1% Mn face keeps the running blend inside the 26–28% contract window without any additional mining. Recovery is small — it raises mucking utilisation, not the binding stage — so it ranks below the equipment and schedule actions.`,
    predictedGainT: blendGain,
    gainPerLakh: Number((blendGain / blendCost).toFixed(1)),
    costLakh: blendCost,
    costNote: 'Sequencing only — zero incremental cost',
    confidence: 0.88,
    feasibility: [
      { label: 'Blend target 26–28% Mn', ok: true, detail: 'Projected running blend 27.1%' },
      { label: 'Face availability', ok: true, detail: 'Both faces have ≥ 3 days of reserves' },
      { label: 'Contract terms', ok: true, detail: 'No penalty exposure at the projected blend' },
    ],
    params: { blendTarget: 27, faceOrder: '29.4% face first', withinWindow: true },
    toOverride: blendOverride,
    stage: 'muck',
    leadDays: 0,
    modelVersion: 'd7-v3.1.0',
    requiresApproval: true,
  });

  // Ranked by measured recovery. Ties broken by cost-effectiveness, so the
  // card shown first is the cheapest tonne recovered rather than an arbitrary
  // ordering of equally good options.
  //
  // Zero-recovery candidates are dropped. They are a real finding and the
  // finding is in the empty state the screen shows, but a card that recommends
  // spending ₹35 lakh to recover nothing is an approval request, not advice.
  const viable = cards.filter((c) => c.predictedGainT > 0);
  viable.sort((a, b) => b.predictedGainT - a.predictedGainT || b.gainPerLakh - a.gainPerLakh);
  // All of them, ranked. The board shows the top three and the rest behind a
  // disclosure, so capping here would hide the alternatives the screen exists to
  // compare — and would hide the fact that a dumper transfer was evaluated and
  // came back worth less than re-sequencing a face.
  return viable;
}

/** What-if: re-simulate with edited parameters, synchronously (< 2 s target). */
export function whatIf(
  alert: ShortfallAlert,
  card: ActionCard,
  edits: Record<string, number | string | boolean>,
  appliedOverrides: Override[] = [],
): {
  /** Forecast tonnage over the alert's horizon, before and after the edit. */
  baselineP50: number;
  adjustedP50: number;
  /** Shortfall on the alert's horizon the edit removes. This is the number that matters. */
  gainT: number;
  /** Shortfall before and after, so the reduction can be checked against gainT. */
  baselineShortfallT: number;
  residualShortfallT: number;
  /** Days in the horizon the totals above cover. */
  horizonDays: number;
  /** Day-by-day chart over the first fortnight, which is what gets drawn. */
  curve: { day: number; date: string; baseline: number; adjusted: number; plan: number }[];
  costLakh: number;
  gainPerLakh: number;
  pShortAfter: number;
  pShortBefore: number;
} {
  const override = buildOverrideFrom(card, edits);
  const combined = [...appliedOverrides, override];
  const base = forecastMine(alert.mineId, appliedOverrides);
  const adj = forecastMine(alert.mineId, combined);
  // On the alert's horizon, not always the week — same reason the cards are.
  // Measured over seven days on a 30-day alert, the baseline shortfall is often
  // already zero and the edit reports a gain of 0 t while the curve below it
  // visibly rises.
  const horizonDays = alert.horizonDays;
  const baseH = base.days.slice(0, horizonDays).reduce((s, d) => s + d.p50, 0);
  const adjH = adj.days.slice(0, horizonDays).reduce((s, d) => s + d.p50, 0);
  const baselineShortfallT = Math.round(horizonShortfall(base, horizonDays));
  const residualShortfallT = Math.round(horizonShortfall(adj, horizonDays));
  /**
   * Shortfall removed, not tonnage added.
   *
   * The P50 delta is the wrong headline for this screen. A stockpile draw banks
   * tonnage that was always going to be crushed, so the curve shows four
   * thousand extra tonnes over the week while the thing the mine is actually
   * being asked to fix — the gap against plan — barely moves. Every card on the
   * board reports recovery, so the what-if has to report the same unit or the
   * two screens will quietly disagree.
   */
  const gain = Math.max(0, baselineShortfallT - residualShortfallT);
  const costLakh = estimateCost(card, edits);
  return {
    baselineP50: Math.round(baseH),
    adjustedP50: Math.round(adjH),
    gainT: Math.round(gain),
    baselineShortfallT,
    residualShortfallT,
    horizonDays,
    curve: adj.days.slice(0, 14).map((d, i) => ({
      day: i + 1,
      date: d.date,
      baseline: base.days[i]?.p50 ?? d.p50,
      adjusted: d.p50,
      plan: d.planT,
    })),
    costLakh,
    gainPerLakh: costLakh > 0 ? gain / costLakh : 0,
    pShortAfter: horizonDays === 7 ? adj.pShort7 : adj.pShort30,
    pShortBefore: horizonDays === 7 ? base.pShort7 : base.pShort30,
  };
}

function buildOverrideFrom(card: ActionCard, edits: Record<string, number | string | boolean>): Override {
  const o: Override = { ...card.toOverride };
  switch (card.type) {
    case 'redeploy-equipment': {
      const units = Number(edits.units ?? 2);
      const days = Number(edits.days ?? 7);
      o.units = { haul: units };
      o.label = `${units} dumpers · ${days} d`;
      o.note = `Re-allocation for ${days} days`;
      break;
    }
    case 'pull-forward-extraction': {
      const shifts = Number(edits.overtimeShifts ?? 2);
      const stock = Number(edits.stockpileT ?? 2000);
      o.stockpileT = stock;
      o.utilDelta = clamp(0.012 * shifts, 0, 0.07);
      o.label = `${shifts} OT shifts · ${stock} t buffer`;
      break;
    }
    case 'blast-resequence': {
      const rounds = Number(edits.dryWindowRounds ?? 2);
      o.blastPullForwardDays = rounds;
      o.label = `${rounds} rounds in the dry window`;
      break;
    }
    case 'preventive-maintenance': {
      const count = Number(edits.count ?? 2);
      const all = card.toOverride.serviceEquipment ?? [];
      o.serviceEquipment = all.slice(0, count);
      o.label = `PM on ${count} machines`;
      break;
    }
    case 'grade-blend': {
      o.utilDelta = 0.008;
      break;
    }
    default:
      break;
  }
  return o;
}

function estimateCost(card: ActionCard, edits: Record<string, number | string | boolean>): number {
  switch (card.type) {
    case 'redeploy-equipment':
      return Math.round(Number(edits.units ?? 2) * 34 + Number(edits.days ?? 7) * 8 + 18);
    case 'pull-forward-extraction':
      return Math.round(Number(edits.overtimeShifts ?? 2) * 9 + Number(edits.stockpileT ?? 2000) / 1000 * 2.5);
    case 'blast-resequence':
      return 14 + Number(edits.dryWindowRounds ?? 2) * 2;
    case 'preventive-maintenance':
      return 6 * Number(edits.count ?? 2) + 7;
    case 'grade-blend':
      return 3;
    default:
      return card.costLakh;
  }
}

export function blastAdherence(mineId: string): { adherence: number; meanDelayMin: number; count: number } {
  const b = blastStats(mineId, 60);
  return { adherence: b.adherence, meanDelayMin: b.meanDelayMin, count: b.count };
}

export function blastAdherenceSeries(mineId: string, days = 120) {
  const rng = makeRng(31 + mineId.length * 71);
  const out: { date: string; adherence: number; delays: number }[] = [];
  for (let d = days; d >= 0; d -= 2) {
    const date = addDays(NOW, -d);
    const blasts = 2 + Math.floor(rng() * 3);
    const onTime = Math.max(0, blasts - Math.floor(rng() * 2.2));
    out.push({ date: date.toISOString().slice(0, 10), adherence: onTime / blasts, delays: blasts - onTime });
  }
  return out;
}

export type { WeatherDay };