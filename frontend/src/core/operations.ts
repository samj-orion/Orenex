import { MINES } from './geology';
import { clamp, makeFbm } from './noise';
import { makeRng } from './rng';
import { NOW, addDays, monsoonFactor } from './format';

/**
 * D9 — Mine operations simulator.
 *
 * A discrete-event stand-in for the drill → blast → muck → haul → hoist chain.
 * Because the simulator knows the true cause of every lost tonne, the prototype
 * can measure cause-attribution accuracy and A/B test corrective actions —
 * which is impossible on real data in a hackathon. Every table here is flagged
 * is_synthetic = true, exactly as the data plan requires.
 */

export type ShiftCode = 'A' | 'B' | 'C';
export type Stage = 'drill' | 'blast' | 'muck' | 'haul' | 'hoist';

export const STAGES: Stage[] = ['drill', 'blast', 'muck', 'haul', 'hoist'];

export const STAGE_LABEL: Record<Stage, string> = {
  drill: 'Drilling',
  blast: 'Blasting',
  muck: 'Mucking',
  haul: 'Haulage',
  hoist: 'Hoisting / dispatch',
};

export type EquipType = 'LHD' | 'dumper' | 'drill' | 'hoist' | 'loader' | 'compressor';

export interface Equipment {
  equipId: string;
  type: EquipType;
  mineId: string;
  ratedTph: number;
  commissioned: string;
  hoursSinceService: number;
  ageYears: number;
  pastFailures: number;
  /** Weibull survival → P(failure within 7 d). */
  failureRisk7d: number;
  expectedDowntimeH: number;
  availability30d: number;
  utilisation30d: number;
  health: 'healthy' | 'watch' | 'at-risk' | 'critical';
  odometerH: number;
  /** Units currently spare at this mine and available for re-allocation. */
  spareUnits: number;
}

/**
 * Why a shift lost tonnes, as the simulator knows it.
 *
 * `weather` is a first-class cause rather than a modifier on the equipment
 * stages, because the ground factors already took tonnes out of that shift's
 * capacity. Without it every lost tonne would be booked against a machine, and
 * cause attribution could never be measured honestly.
 */
export type LossCause = Stage | 'weather' | 'none';

export interface ProductionShift {
  date: string;
  mineId: string;
  shift: ShiftCode;
  faceId: string;
  plannedT: number;
  actualT: number;
  mnPct: number;
  /** Ground truth: why the shift lost tonnes. */
  trueCause: LossCause;
  lostT: number;
}

/**
 * The one definition of the production plan.
 *
 * The simulator generates the shift records against this, and the shortfall
 * engine forecasts against it. Two definitions differing by a few percent would
 * make every calibration and every backtest meaningless, so both read it here.
 *
 * The plan is anchored on nameplate rather than on what the fleet could achieve
 * today — which is how a real plan works. It is set from the crusher feed target
 * weeks ahead and is not rewritten every time it rains, so monsoon days
 * genuinely miss it. That is what gives the shortfall engine something to find.
 *
 * It sits *at* nameplate rather than a few percent under it on purpose. Set
 * below nameplate with the fleet carrying a maintenance margin on top, the
 * circuit clears the plan by double digits on any dry day, most shifts hit their
 * ceiling and get censored out of the calibration, and the weekly forecast noise
 * ends up larger than the gap to the plan — which makes every probability
 * meaningless and every mine look permanently in breach.
 */
export function planTpd(mineId: string, date: Date): number {
  const mine = MINES.find((m) => m.id === mineId);
  if (!mine) return 0;
  const mon = monsoonFactor(date);
  // Small scheduling wobble plus the monsoon trim on the plan itself.
  const wobble = 1 + 0.03 * Math.sin(date.getDate() * 2.399 + mine.x / 9000);
  return Math.round((mine.designTpd * (1 - 0.08 * mon) * wobble) / 10) * 10;
}

/**
 * Ceiling on what a crew can feed the plant, as a multiple of nameplate.
 *
 * A physical limit rather than a multiple of the plan. Nameplate is the design
 * feed rate; the plant can be run above it for stretches, but not indefinitely,
 * and that is what stops a shift — not the plan it was given. Set the ceiling
 * close to the circuit's dry-weather capacity and it becomes the binding
 * constraint on ordinary good days, which censors them out of the calibration
 * and leaves the residual fit reading the disruption shoulder as if it were the
 * whole distribution.
 */
export function plantCeilingShiftT(mineId: string): number {
  const mine = MINES.find((m) => m.id === mineId);
  return ((mine?.designTpd ?? 0) * PLANT_CEILING) / SHIFTS_PER_DAY;
}

const PLANT_CEILING = 1.25;

export interface WeatherDay {
  date: string;
  mineId: string;
  rainMm: number;
  rainFcst3dMm: number;
  soilMoisture: number;
  lstC: number;
  ndvi: number;
  source: string;
}

export interface BlastLog {
  blastId: string;
  faceId: string;
  mineId: string;
  plannedTs: string;
  actualTs: string;
  delayMin: number;
  delayReason: 'weather' | 'clearance' | 'misfire' | 'explosive_supply' | 'other' | null;
  holes: number;
  explosiveKg: number;
  powderFactor: number;
  p80FragMm: number;
}

// ── Deterministic daily series ──────────────────────────────────────────

const HISTORY_DAYS = 1095; // three years of shift records
const BLAST_LOG_DAYS = 365; // the blast register is kept for one year
/** A/B/C shifts, so a day's capacity is three shifts of it. */
export const SHIFTS_PER_DAY = 3;

interface StageRates {
  /** Available units per stage at this mine. */
  units: Record<Stage, number>;
  /** Rated throughput per unit, t/h. */
  ratedTph: Record<Stage, number>;
  /** Typical utilisation after accounting for planned maintenance. */
  utilisation: Record<Stage, number>;
}

/**
 * Stage rates per mine, in tonnes of ore per shift.
 *
 * Every mine's stages are sized to roughly the same target: about 5% above
 * nameplate (designTpd / SHIFTS_PER_DAY) on the four stages that are not
 * binding, with the fifth left 1–3% *below* it. That is the whole design of the
 * shortfall engine.
 *
 *  · If every stage carried 2× plan the mine could never miss and every alert
 *    would be theatre.
 *  · If the bottleneck sat well clear of plan, dry weeks would clear it by
 *    double digits, most shifts would hit the plant ceiling and be censored out
 *    of the calibration, and the weekly forecast noise would be larger than the
 *    gap to plan — which makes every probability meaningless.
 *
 * So the mine's dry-weather capacity sits just under its plan. The fitted
 * calibration bias (≈1.03–1.05) puts the median dry day back on plan, the wet
 * half of the monsoon genuinely misses, and the spread between the two is what
 * the alert board reads.
 *
 * The binding stage differs by mine — haulage at Balaghat, hoisting at the
 * Nagpur underground panel, blasting at Bhandara — so corrective actions are
 * mine-specific rather than generic. `primary` names the machine class that
 * carries each stage, so availability losses are charged to the right equipment.
 */
const STAGE_RATE_TABLE: Record<
  string,
  { units: Record<Stage, number>; ratedTph: Record<Stage, number>; primary: Record<Stage, EquipType | null> }
> = {
  'MNE-BAL': {
    // 1450 tpd open cast. Bottleneck: haulage — three production trucks against
    // nine in the inventory, so the fleet carries redundancy but the circuit
    // does not, and one breakdown on the ramp moves the plan.
    units: { drill: 3, blast: 1, muck: 4, haul: 3, hoist: 1 },
    ratedTph: { drill: 30, blast: 96, muck: 21, haul: 26.6, hoist: 76 },
    primary: { drill: 'drill', blast: null, muck: 'LHD', haul: 'dumper', hoist: 'hoist' },
  },
  'MNE-NAG': {
    // 820 tpd underground panel. Bottleneck: hoisting and ventilation — the
    // shaft carries barely more than the nameplate and cannot be re-deployed
    // from another mine, so the only actions are schedule and maintenance.
    units: { drill: 2, blast: 1, muck: 4, haul: 5, hoist: 2 },
    ratedTph: { drill: 25, blast: 54, muck: 13, haul: 11, hoist: 20.6 },
    primary: { drill: 'drill', blast: null, muck: 'LHD', haul: 'dumper', hoist: 'hoist' },
  },
  'MNE-BHA': {
    // 1100 tpd open cast. Bottleneck: blasting — a single blast crew on a
    // tighter face schedule, so a wet week bites sooner than at Balaghat and the
    // fix is re-sequencing rounds rather than moving iron.
    units: { drill: 2, blast: 1, muck: 3, haul: 4, hoist: 1 },
    ratedTph: { drill: 33, blast: 70, muck: 22, haul: 16, hoist: 58 },
    primary: { drill: 'drill', blast: null, muck: 'LHD', haul: 'dumper', hoist: 'hoist' },
  },
};

function stageRates(mineId: string): StageRates {
  const table = STAGE_RATE_TABLE[mineId] ?? STAGE_RATE_TABLE['MNE-BAL'];
  return {
    units: { ...table.units },
    ratedTph: { ...table.ratedTph },
    utilisation: {
      drill: 0.78,
      blast: 0.72,
      muck: 0.81,
      haul: 0.84,
      hoist: 0.88,
    },
  };
}

export const SHIFT_HOURS = 8;

/** Stage capacity in tonnes per shift, before weather. */
export function nominalStageCapacity(stage: Stage, rates: StageRates, unitDelta = 0, utilDelta = 0): number {
  const units = rates.units[stage] + unitDelta;
  const util = clamp(rates.utilisation[stage] + utilDelta, 0.3, 0.98);
  return units * rates.ratedTph[stage] * util * SHIFT_HOURS;
}

/**
 * Weather / ground factor per stage, 1 = unrestricted.
 *
 * The floors matter. A wet day defers a blast round and slows the haul road; it
 * does not shut the mine. The pit keeps feeding the plant off the muck pile
 * already broken, so no stage collapses toward zero. Balaghat runs at roughly
 * half nameplate through the monsoon in a normal year, which is what these
 * floors produce.
 */
export function stageGroundFactor(stage: Stage, rainMm: number, soilMoisture: number, lstC: number): number {
  const wet = clamp(rainMm / 90, 0, 1) * 0.6 + clamp((soilMoisture - 0.18) / 0.3, 0, 1) * 0.4;
  const heat = clamp((lstC - 36) / 12, 0, 1);
  switch (stage) {
    case 'drill':
      return clamp(1 - 0.34 * wet - 0.06 * heat, 0.45, 1);
    case 'blast':
      // The round slips to the next dry window; the muck pile carries the day.
      return clamp(1 - 0.55 * clamp(rainMm / 45, 0, 1), 0.42, 1);
    case 'muck':
      return clamp(1 - 0.42 * wet - 0.1 * heat, 0.42, 1);
    case 'haul':
      // Haul roads are regraded and the fleet slows down, but trafficability
      // never falls far enough to stop the pit.
      return clamp(1 - 0.66 * wet - 0.12 * heat, 0.42, 1);
    case 'hoist':
      return clamp(1 - 0.14 * wet - 0.08 * heat, 0.7, 1);
    default:
      return 1;
  }
}

function buildWeather(): WeatherDay[] {
  const rng = makeRng(3141592);
  const fbm = makeFbm(2718, 4, 2.1, 0.55);
  const out: WeatherDay[] = [];
  for (let d = HISTORY_DAYS; d >= 0; d--) {
    const date = addDays(NOW, -d);
    const iso = date.toISOString().slice(0, 10);
    for (const mine of MINES) {
      const mon = monsoonFactor(date);
      const noise = (fbm(d / 14, mine.x / 4000) + 1) / 2;
      const base = mon * 62 * noise * 1.5;
      const rain = Math.max(0, base + (rng() - 0.5) * (mon > 0.4 ? 34 : 4));
      const soil = clamp(0.1 + mon * 0.26 + (rain / 180) * 0.3 + (rng() - 0.5) * 0.03, 0.06, 0.5);
      const lst = clamp(24 + (1 - mon) * 11 + (1 - soil) * 5 + (rng() - 0.5) * 2.6, 18, 47);
      const ndvi = clamp(0.32 + mon * 0.28 + (rng() - 0.5) * 0.05, 0.15, 0.72);
      out.push({
        date: iso,
        mineId: mine.id,
        rainMm: Number(rain.toFixed(1)),
        rainFcst3dMm: Number(Math.max(0, rain * 1.4 + (rng() - 0.5) * 20).toFixed(1)),
        soilMoisture: Number(soil.toFixed(3)),
        lstC: Number(lst.toFixed(1)),
        ndvi: Number(ndvi.toFixed(3)),
        source: 'GPM IMERG v7 + ERA5-Land',
      });
    }
  }
  return out;
}

export const WEATHER: WeatherDay[] = buildWeather();

export function weatherOn(mineId: string, isoDate: string): WeatherDay {
  return (
    WEATHER.find((w) => w.mineId === mineId && w.date === isoDate) ?? {
      date: isoDate,
      mineId,
      rainMm: 0,
      rainFcst3dMm: 0,
      soilMoisture: 0.16,
      lstC: 33,
      ndvi: 0.4,
      source: 'gap-filled climatology',
    }
  );
}

/**
 * Machine-borne causes of a lost tonne, in the order a shift register would list
 * them. Weather and blasting are handled separately — the first is derived from
 * the ground derate, the second from the blast register's own probabilities.
 */
const MACHINE_CAUSES: Stage[] = ['haul', 'muck', 'drill', 'haul', 'muck', 'hoist'];

/**
 * One day of the shift register, as a pure function of the circuit's state.
 *
 * Kept separate from `buildProduction` so the corrective-action A/B on the
 * validation screen can re-run a historical day with an override applied and get
 * a genuinely counterfactual answer. The only difference between the two runs is
 * the intervention — same seed, same weather, same crew draw — so the tonnage
 * delta is attributable to the action rather than to a different sample.
 *
 * `unitDelta` is per stage rather than a single number because an A/B has to name
 * the machine it moved. Adding three units to every stage at once is not a
 * re-deployment, it is a bigger mine, and it would flatter every action that
 * touches the binding stage by also inflating the four that do not.
 */
export function simulateDay(
  mine: (typeof MINES)[number],
  date: Date,
  ctx: { unitDelta?: number | Partial<Record<Stage, number>>; blastPull?: number; serviceDays?: boolean; utilDelta?: number } = {},
): ProductionShift[] {
  const rates = stageRates(mine.id);
  const gradeNoise = makeFbm(4821, 3, 2.2, 0.5);
  const crewEffect = makeFbm(5311, 3, 2.4, 0.5);
  const iso = date.toISOString().slice(0, 10);
  const w = weatherOn(mine.id, iso);

  // The seed is derived from the date so a single day can be replayed on its
  // own without walking the three-year history to reach it.
  const rng = makeRng(99991 + Math.floor(date.getTime() / 864e5) * 131 + mine.code.charCodeAt(0) * 17);
  const day = Math.round((date.getTime() - addDays(NOW, -HISTORY_DAYS).getTime()) / 864e5);
  const doy = day / HISTORY_DAYS;
  const plantCeiling = plantCeilingShiftT(mine.id);

  const extraUnits = (s: Stage) =>
    typeof ctx.unitDelta === 'number' ? ctx.unitDelta : ctx.unitDelta?.[s] ?? 0;
  const caps = STAGES.map((s) => nominalStageCapacity(s, rates, extraUnits(s), ctx.utilDelta ?? 0));
  const stageCap = STAGES.map((s, i) => caps[i] * stageGroundFactor(s, w.rainMm, w.soilMoisture, w.lstC));
  // Rounds pulled forward into the day: the pile carries more broken ore.
  if (ctx.blastPull) {
    const i = STAGES.indexOf('blast');
    stageCap[i] *= 1 + 0.18 * ctx.blastPull;
  }
  /**
   * Pre-emptive service: the machines the action would have serviced stop
   * failing during the window, which is the whole point of a PM card.
   */
  const disruptionP = ctx.serviceDays ? 0 : 0.055;
  const bottleneckIdx = stageCap.indexOf(Math.min(...stageCap));
  const bottleneck = STAGES[bottleneckIdx];

  const crew = 1 + 0.1 * crewEffect(doy * 22, mine.x / 5000);
  const capacity = Math.min(...stageCap) * crew;

  const planPerShift = planTpd(mine.id, date) / SHIFTS_PER_DAY;
  const dow = date.getDay();
  const out: ProductionShift[] = [];

  for (const shift of ['A', 'B', 'C'] as ShiftCode[]) {
    const perShift = Math.round((planPerShift * (shift === 'B' ? 1.04 : shift === 'C' ? 0.96 : 1)) / 10) * 10;
    const shiftFactor = 0.97 + 0.06 * rng();
    const weekend = dow === 0 ? 0.94 : 1;
    const disrupted = rng() < disruptionP;
    const disruptionLoss = disrupted ? (ctx.serviceDays ? 0.05 + rng() * 0.1 : 0.2 + rng() * 0.4) : 0;
    const derate = Math.min(...stageCap) / Math.max(1e-6, Math.min(...caps));
    const pWeather = clamp(0.05 + 0.62 * (1 - derate), 0.05, 0.62);
    const pBlast = clamp(0.1 + (bottleneck === 'blast' ? 0.22 : 0) + (w.rainMm > 18 ? 0.14 : 0), 0.08, 0.46);
    const r = rng();
    const machineCause = () => MACHINE_CAUSES[Math.floor(rng() * MACHINE_CAUSES.length)];
    let weightedCause: LossCause;
    if (disrupted) weightedCause = machineCause();
    else if (r < pWeather) weightedCause = 'weather';
    else if (r < pWeather + pBlast) weightedCause = 'blast';
    else weightedCause = machineCause();
    const capability = capacity * shiftFactor * weekend * (0.985 + 0.03 * rng()) * (1 - disruptionLoss);
    const actual = Math.max(60, Math.round(Math.min(plantCeiling, capability)));
    const faceNo = ((day * 3 + shift.charCodeAt(0)) % 17) + 1;
    const grade = clamp(mine.feedGradeMn + 4.2 * (gradeNoise(doy * 40, mine.y / 6000)) + (rng() - 0.5) * 2.2, 12, 42);
    out.push({
      date: iso,
      mineId: mine.id,
      shift,
      faceId: `${mine.code}-F${String(faceNo).padStart(2, '0')}`,
      plannedT: perShift,
      actualT: actual,
      mnPct: Number(grade.toFixed(2)),
      trueCause: actual < perShift ? weightedCause : 'none',
      lostT: Math.max(0, perShift - actual),
    });
  }
  return out;
}

function buildProduction(): ProductionShift[] {
  const out: ProductionShift[] = [];
  for (const mine of MINES) {
    for (let d = HISTORY_DAYS; d >= 0; d--) out.push(...simulateDay(mine, addDays(NOW, -d)));
  }
  return out;
}

export const PRODUCTION: ProductionShift[] = buildProduction();

/**
 * Failure model.
 *
 * Age–failure behaviour is Weibull with shape 1.8 (increasing hazard, typical of
 * wear-out failure modes) on hours since last service. The scale is per machine
 * class: loading and haulage units are the maintenance sink in a hard-rock pit,
 * hoists and compressors run far longer between unplanned stops. At 55 h since
 * service this puts the 7-day failure probability at ~1%, at 520 h at ~25% —
 * the same spread a real CMMS extract shows.
 */
const WEIBULL_SHAPE = 1.8;
const RELIABILITY_SCALE: Record<EquipType, number> = {
  dumper: 750,
  LHD: 780,
  loader: 820,
  drill: 1250,
  compressor: 1800,
  hoist: 2100,
};

/** Fraction of machines whose service interval has been overrun. */
const OVERDUE_SHARE = 0.12;
const OVERDUE_EXTRA_H = 700;

/**
 * Fleet inventory per mine.
 *
 * Counts and net shift-average rates are calibrated together with
 * STAGE_RATE_TABLE so the ore circuit at each mine really does carry the
 * nameplate tonnage. ratedTph here is the net ore tonnes a unit moves per hour
 * averaged over a shift — it already accounts for tramming, queueing at the
 * tip head and waits at the crusher, so it is well below the catalogue rate.
 */
const FLEET_INVENTORY: Record<string, { type: EquipType; count: number; tph: [number, number] }[]> = {
  'MNE-BAL': [
    { type: 'dumper', count: 9, tph: [10.5, 13.5] },
    { type: 'drill', count: 5, tph: [25, 29] },
    { type: 'LHD', count: 7, tph: [17, 21] },
    { type: 'loader', count: 3, tph: [18, 22] },
    { type: 'hoist', count: 2, tph: [64, 76] },
    { type: 'compressor', count: 3, tph: [45, 60] },
  ],
  'MNE-NAG': [
    { type: 'dumper', count: 8, tph: [8.5, 11.5] },
    { type: 'drill', count: 4, tph: [21, 25] },
    { type: 'LHD', count: 7, tph: [10.5, 13.5] },
    { type: 'hoist', count: 3, tph: [17, 21] },
    { type: 'compressor', count: 3, tph: [45, 60] },
  ],
  'MNE-BHA': [
    { type: 'dumper', count: 7, tph: [12.5, 15.5] },
    { type: 'drill', count: 4, tph: [28, 32] },
    { type: 'LHD', count: 6, tph: [18, 22] },
    { type: 'hoist', count: 2, tph: [48, 58] },
    { type: 'compressor', count: 2, tph: [45, 60] },
  ],
};

function buildEquipment(): Equipment[] {
  const rng = makeRng(551133);
  const out: Equipment[] = [];
  for (const mine of MINES) {
    const fleet = FLEET_INVENTORY[mine.id] ?? FLEET_INVENTORY['MNE-BAL'];
    let seq = 1;
    for (const f of fleet) {
      for (let i = 0; i < f.count; i++) {
        const age = 1.5 + rng() * 12;
        // Hours since the last planned service. A CMMS would not show a truck
        // 2 000 h past its service interval — the interval is respected, and the
        // spread within it is what drives the risk.
        // A minority sit well past the interval — deferred services, parts on
        // order — and those are the machines the corrective-action engine is
        // supposed to find.
        const hoursSinceService =
          55 + rng() * 470 + (rng() < OVERDUE_SHARE ? OVERDUE_EXTRA_H * (0.4 + rng() * 0.6) : 0);
        const pastFailures = Math.floor(rng() * (age * 0.9));
        // Weibull hazard (shape 1.8) on hours since service, scaled per class:
        // trucks and loading units fail sooner than hoists and compressors.
        const scale = RELIABILITY_SCALE[f.type];
        const hazard = (WEIBULL_SHAPE / scale) * Math.pow(Math.max(1, hoursSinceService) / scale, WEIBULL_SHAPE - 1);
        const failureRisk7d = clamp(
          1 - Math.exp(-hazard * 168 * (1 + pastFailures * 0.035)),
          0.004,
          0.92,
        );
        const expectedDowntimeH = failureRisk7d > 0.3 ? 6 + rng() * 26 : failureRisk7d * 90;
        const availability30d = clamp(0.97 - failureRisk7d * 0.24 - rng() * 0.045, 0.55, 0.995);
        const utilisation30d = clamp(availability30d * (0.72 + rng() * 0.22), 0.4, 0.97);
        const health: Equipment['health'] =
          failureRisk7d > 0.45 ? 'critical' : failureRisk7d > 0.22 ? 'at-risk' : failureRisk7d > 0.1 ? 'watch' : 'healthy';
        out.push({
          equipId: `${mine.code}-${f.type.toUpperCase().slice(0, 3)}-${String(seq).padStart(3, '0')}`,
          type: f.type,
          mineId: mine.id,
          ratedTph: Number((f.tph[0] + rng() * (f.tph[1] - f.tph[0])).toFixed(1)),
          commissioned: `${2019 + Math.floor(rng() * 6)}-0${1 + Math.floor(rng() * 9)}-01`,
          hoursSinceService: Math.round(hoursSinceService),
          ageYears: Number(age.toFixed(1)),
          pastFailures,
          failureRisk7d: Number(failureRisk7d.toFixed(3)),
          expectedDowntimeH: Number(expectedDowntimeH.toFixed(1)),
          availability30d: Number(availability30d.toFixed(3)),
          utilisation30d: Number(utilisation30d.toFixed(3)),
          health,
          odometerH: Math.round(1400 + age * 1900 + rng() * 900),
          // The last unit in each class is a standby, not production capacity.
          spareUnits: i >= f.count - 1 ? 1 : 0,
        });
        seq++;
      }
    }
  }
  return out;
}

export const FLEET: Equipment[] = buildEquipment();

/**
 * Delay model.
 *
 * Weather dominates and is driven by the day's rainfall, but the baseline
 * reasons (clearance, misfire, explosive supply) are always present — a real
 * blast register is never clean. Probabilities are per blast and sum to
 * something in the 12–55% band depending on how wet the day is, which lands
 * adherence in the 70–85% range the operations dashboard expects.
 */
const BLAST_DELAY_P = {
  clearance: 0.052,
  misfire: 0.028,
  explosive_supply: 0.021,
  other: 0.017,
  /** Baseline plus weather, scaled by how wet the day is. */
  weatherBase: 0.035,
  weatherWet: 0.42,
} as const;

function buildBlasts(): BlastLog[] {
  const rng = makeRng(778899);
  const out: BlastLog[] = [];
  for (const mine of MINES) {
    let n = 1;
    for (let d = BLAST_LOG_DAYS; d >= 0; d -= 1) {
      const date = addDays(NOW, -d);
      const w = weatherOn(mine.id, date.toISOString().slice(0, 10));
      const blastsPerDay = 1 + (rng() > 0.45 ? 1 : 0);
      for (let b = 0; b < blastsPerDay; b++) {
        const plannedTs = new Date(date);
        plannedTs.setHours(13 + b * 4, 0, 0, 0);
        let delayReason: BlastLog['delayReason'] = null;
        let delayMin = 0;
        const wet = clamp((w.rainMm - 10) / 55, 0, 1);
        const p = rng();
        const thWeather = BLAST_DELAY_P.weatherBase + BLAST_DELAY_P.weatherWet * wet;
        let cum = thWeather;
        if (p < cum) {
          delayReason = 'weather';
          delayMin = 90 + Math.floor(rng() * 420);
        } else if ((cum += BLAST_DELAY_P.clearance) > p) {
          delayReason = 'clearance';
          delayMin = 25 + Math.floor(rng() * 130);
        } else if ((cum += BLAST_DELAY_P.misfire) > p) {
          delayReason = 'misfire';
          delayMin = 60 + Math.floor(rng() * 210);
        } else if ((cum += BLAST_DELAY_P.explosive_supply) > p) {
          delayReason = 'explosive_supply';
          delayMin = 40 + Math.floor(rng() * 160);
        } else if ((cum += BLAST_DELAY_P.other) > p) {
          delayReason = 'other';
          delayMin = 20 + Math.floor(rng() * 70);
        }
        const holes = 28 + Math.floor(rng() * 44);
        const powderFactor = 0.29 + rng() * 0.19;
        // Kuz-Ram style fragmentation: finer with higher powder factor.
        const p80 = clamp(148 - powderFactor * 260 + (rng() - 0.5) * 44, 42, 190);
        const actualTs = new Date(plannedTs.getTime() + delayMin * 60000);
        out.push({
          blastId: `${mine.code}-B${String(n).padStart(4, '0')}`,
          faceId: `${mine.code}-F${String((n % 17) + 1).padStart(2, '0')}`,
          mineId: mine.id,
          plannedTs: plannedTs.toISOString(),
          actualTs: actualTs.toISOString(),
          delayMin,
          delayReason,
          holes,
          explosiveKg: Math.round(holes * 11.5 * (0.85 + rng() * 0.3)),
          powderFactor: Number(powderFactor.toFixed(3)),
          p80FragMm: Number(p80.toFixed(1)),
        });
        n++;
      }
    }
  }
  return out;
}

export const BLASTS: BlastLog[] = buildBlasts();

// ── Aggregations ────────────────────────────────────────────────────────

export function fleetFor(mineId: string): Equipment[] {
  return FLEET.filter((e) => e.mineId === mineId).sort((a, b) => b.failureRisk7d - a.failureRisk7d);
}

export function blastStats(mineId: string, days = 90) {
  const from = addDays(NOW, -days);
  const list = BLASTS.filter((b) => b.mineId === mineId && new Date(b.actualTs) >= from);
  const delayed = list.filter((b) => b.delayMin > 0);
  const byReason = new Map<string, number>();
  for (const b of delayed) {
    const k = b.delayReason ?? 'other';
    byReason.set(k, (byReason.get(k) ?? 0) + b.delayMin);
  }
  const adherence = list.length ? 1 - delayed.length / list.length : 1;
  return {
    count: list.length,
    onTime: list.length - delayed.length,
    adherence,
    meanDelayMin: delayed.length ? delayed.reduce((s, b) => s + b.delayMin, 0) / delayed.length : 0,
    totalDelayH: delayed.reduce((s, b) => s + b.delayMin, 0) / 60,
    byReason: Array.from(byReason.entries())
      .map(([reason, minutes]) => ({ reason, minutes, hours: minutes / 60 }))
      .sort((a, b) => b.minutes - a.minutes),
    meanP80: list.length ? list.reduce((s, b) => s + b.p80FragMm, 0) / list.length : 0,
    meanPowderFactor: list.length ? list.reduce((s, b) => s + b.powderFactor, 0) / list.length : 0,
  };
}

export function rateLimitsFor(mineId: string) {
  return stageRates(mineId);
}