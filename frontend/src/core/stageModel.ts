import { clamp } from './noise';
import {
  Equipment,
  SHIFTS_PER_DAY,
  SHIFT_HOURS,
  STAGES,
  STAGE_LABEL,
  Stage,
  WeatherDay,
  fleetFor,
  nominalStageCapacity,
  rateLimitsFor,
  stageGroundFactor,
} from './operations';

/**
 * Stage capacity model (D6, 2A/2C).
 *
 * A mine produces no more than its slowest stage, so the capacity of the mine on
 * a given day is `min(drill, blast, muck, haul, hoist)`. Every one of those is
 * `units × rated t/h × utilisation × shift hours`, derated by two independent
 * multipliers — the ground condition and the machines available at that stage.
 *
 * This lives in its own module rather than inside `forecast.ts` because the
 * backtest has to evaluate the *same* physics over history. A calibration that
 * was fitted against a different implementation of the model would be a
 * calibration of nothing.
 */

/** Machine class that carries each stage. Blasting has no machine — it is a crew. */
export const STAGE_PRIMARY: Record<Stage, Equipment['type'] | null> = {
  drill: 'drill',
  blast: null,
  muck: 'LHD',
  haul: 'dumper',
  hoist: 'hoist',
};

/** Blast crews lose roughly one shift in twenty to clearance and supply. */
export const BLAST_CREW_UNAVAILABILITY = 0.048;

/** Equipment at a stage, mapped to the machines actually in its cycle. */
export function stageEquipment(mineId: string, stage: Stage): Equipment[] {
  const type = STAGE_PRIMARY[stage];
  if (!type) return [];
  return fleetFor(mineId).filter((e) => e.type === type);
}

/**
 * Fraction of a stage's nominal capacity lost to equipment unavailability.
 *
 * Scaled by the stage's unit count, not summed over the whole mine: a mine with
 * eleven dumpers is not twice as exposed as one with six, it has twice the
 * redundancy. Each machine's 7-day failure probability is converted to the
 * share of the next seven days it is expected to be down, and the stage's loss
 * is the expected number of machines out divided by how many it has. Machines
 * brought in by an override dilute the loss, as real redeployment does.
 */
export function stageAvailabilityLoss(mineId: string, stage: Stage, stageUnits: number, serviced: string[]): number {
  const eq = stageEquipment(mineId, stage);
  if (!eq.length || stageUnits <= 0) return stage === 'blast' ? BLAST_CREW_UNAVAILABILITY : 0;
  let expectedOut = 0;
  for (const e of eq) {
    const risk = serviced.includes(e.equipId) ? 0.004 : e.failureRisk7d;
    // A failure inside the window does not cost the whole window; mean time to
    // failure within it is about half of it.
    expectedOut += risk * 0.5;
  }
  // Losses are shared across the stage's units: with more units than machines
  // on hand, a single failure is absorbed by the float.
  const perUnitLoss = expectedOut / Math.max(1, eq.length);
  const spread = clamp(stageUnits / Math.max(1, eq.length), 0.55, 1);
  return clamp(perUnitLoss * spread * 1.25, 0, 0.45);
}

export interface StageRow {
  stage: Stage;
  label: string;
  /** Today's capacity at this stage, tonnes for the whole day. */
  capacityT: number;
  /** The same figure per shift — the unit the stage rates are quoted in. */
  capacityShiftT: number;
  units: number;
  ratedTph: number;
  utilisation: number;
  /** Weather / ground derate, 1 = dry and unrestricted. */
  groundFactor: number;
  /** Equipment availability applied to this stage, 1 = full fleet. */
  availableFraction: number;
  availableUnits: number;
  isBottleneck: boolean;
  /** Tonnes lost today relative to a dry-day, full-fleet baseline. */
  lossT: number;
}

/** Everything an operator can change about the ore circuit. */
export interface StageContext {
  unitDelta: Record<Stage, number>;
  utilDelta: number;
  /** Equipment pulled forward for service — treated as near-zero risk. */
  serviced: string[];
  /** Blast rounds pulled forward into dry windows. */
  blastPull: number;
  /**
   * Ablation switch: run the circuit as if the ground were always dry.
   * Only the validation screen uses it, to price the satellite weather feed.
   */
  ignoreWeather?: boolean;
}

export function emptyStageContext(): StageContext {
  return {
    unitDelta: { drill: 0, blast: 0, muck: 0, haul: 0, hoist: 0 },
    utilDelta: 0,
    serviced: [],
    blastPull: 0,
  };
}

/**
 * Capacity of each stage on one day, and the derates that produced it.
 *
 * `nominalStageCapacity` is quoted per shift, so the day figure is that times
 * three shifts. Getting this wrong is not a rounding error: it makes every
 * stage look four times bigger than the mine's daily plan, the shortfall
 * collapses to zero and the whole action engine reports no gain for anything.
 */
export function stageRowsFor(mineId: string, w: WeatherDay, ctx: StageContext = emptyStageContext()): StageRow[] {
  const rates = rateLimitsFor(mineId);
  return STAGES.map((stage) => {
    const nominalUnits = rates.units[stage] + ctx.unitDelta[stage];
    const base = nominalStageCapacity(stage, rates, ctx.unitDelta[stage], ctx.utilDelta);
    const ground = ctx.ignoreWeather
      ? 1
      : stageGroundFactor(stage, w.rainMm, w.soilMoisture, w.lstC);

    // Availability is a stage property derived from the machines that carry it.
    // Drilling is limited by rig availability, blasting by the crew, hoisting by
    // shaft capacity — only the first and last are machine-led.
    const availabilityLoss = stageAvailabilityLoss(mineId, stage, nominalUnits, ctx.serviced);
    const availableFraction = clamp(1 - availabilityLoss, 0.45, 1);

    const capacity = base * ground * availableFraction;

    // Blast windows: pulling rounds into a dry day raises that day's capacity.
    const blastDryBoost = stage === 'blast' ? 0.06 * ctx.blastPull * (1 - clamp(w.rainMm / 20, 0, 1)) : 0;
    const adjusted = stage === 'blast' ? capacity * (1 + blastDryBoost) : capacity;

    return {
      stage,
      label: STAGE_LABEL[stage],
      capacityT: Math.max(0, Math.round(adjusted * SHIFTS_PER_DAY)),
      capacityShiftT: Math.max(0, Math.round(adjusted)),
      units: nominalUnits,
      ratedTph: rates.ratedTph[stage],
      utilisation: clamp(rates.utilisation[stage] + ctx.utilDelta, 0.3, 0.98),
      groundFactor: ground,
      availableFraction,
      availableUnits: Math.round(nominalUnits * availableFraction * 10) / 10,
      isBottleneck: false,
      lossT: Math.max(0, Math.round((base - adjusted) * SHIFTS_PER_DAY)),
    };
  });
}

/** Mark the slowest stage. Ties go to the first stage in the chain. */
export function markBottleneck(rows: StageRow[]): Stage {
  let best = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].capacityT < rows[best].capacityT) best = i;
  rows.forEach((r, i) => {
    r.isBottleneck = i === best;
  });
  return rows[best].stage;
}

/** Daily capacity of the mine: its slowest stage, tonnes for the whole day. */
export function mineCapacityT(rows: StageRow[]): number {
  return rows.reduce((m, r) => Math.min(m, r.capacityT), Infinity);
}

/**
 * Unconstrained capacity of a stage in tonnes/day, ignoring both derates.
 *
 * The driver breakdown needs this: tonnes lost to equipment is the capacity the
 * stage would have had with a full fleet, times the fraction that is out.
 */
export function nominalDayCapacity(r: StageRow): number {
  return r.units * r.ratedTph * r.utilisation * SHIFT_HOURS * SHIFTS_PER_DAY;
}
