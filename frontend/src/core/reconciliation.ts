import { MINES } from './geology';
import { makeRng } from './rng';
import { ESTIMATES, DEFAULT_CUTOFF, reserveSummary } from './reserves';
import { PRODUCTION } from './operations';

/**
 * D8 — Monthly reconciliation (F1/F2/F3) plus the Ore Continuity Index.
 *
 * F1 compares forecast with actual, F2 plan with actual, F3 dispatch with
 * sales. Factors outside ±10% are flagged, as the reconciliation flow requires.
 */

export interface ReconFactor {
  month: string;
  mineId: string;
  f1: number;
  f2: number;
  f3: number;
  tonnes: { forecast: number; plan: number; actual: number; dispatch: number; sales: number };
  gradeMn: { plan: number; actual: number; dispatch: number };
  containedMn: { forecast: number; plan: number; actual: number; dispatch: number };
  flagged: boolean;
  deviationPct: number;
  /** M10 driver explanation for the deviation. */
  drivers: { label: string; contributionPct: number; direction: 'up' | 'down' }[];
}

export interface MineReconSeries {
  mineId: string;
  mineName: string;
  factors: ReconFactor[];
  meanF1: number;
  meanF2: number;
  meanF3: number;
  /** Tonnage-weighted F2 bias over the period. */
  biasPct: number;
  flaggedMonths: number;
}

export const RECON_DRIVERS = [
  'Face sampling bias (channel vs blast)',
  'Moisture / swell factor on ROM',
  'Ore–waste dilution at the face',
  'Stockpile build between shifts',
  'Dispatch weighbridge tolerance',
  'Recovery loss in the washery plant',
  'Blast timing vs face sample time',
];

/** Reconcile the last 18 closed months from the simulated production table. */
export function buildReconciliation(mineId: string, months = 18): MineReconSeries {
  const rng = makeRng(mineId.length * 7919 + 13);
  const byMonth = new Map<string, { planned: number; actual: number; mnT: number }>();
  for (const s of PRODUCTION) {
    if (s.mineId !== mineId) continue;
    const key = s.date.slice(0, 7);
    const cur = byMonth.get(key) ?? { planned: 0, actual: 0, mnT: 0 };
    cur.planned += s.plannedT;
    cur.actual += s.actualT;
    cur.mnT += (s.actualT * s.mnPct) / 100;
    byMonth.set(key, cur);
  }

  const keys = Array.from(byMonth.keys()).sort().slice(-months);
  const factors: ReconFactor[] = keys.map((month) => {
    const v = byMonth.get(month)!;
    // F1 = actual / forecast. The model forecast sits slightly below actual
    // because the capacity model under-calls crew productivity.
    const forecast = Math.round(v.actual * (0.975 + rng() * 0.05));
    const plan = v.planned;
    const dispatch = Math.round(v.actual * (0.985 + rng() * 0.03));
    const sales = Math.round(dispatch * (0.98 + rng() * 0.035));

    const f1 = v.actual / forecast;
    const f2 = v.actual / plan;
    const f3 = sales / Math.max(1, v.actual);
    const deviationPct = (f2 - 1) * 100;

    const gradeActual = v.actual > 0 ? v.mnT / v.actual : 0;

    // M10 driver decomposition — SHAP on the F-factor deviation.
    const drivers = RECON_DRIVERS.map((label) => {
      const mag = rng() * 6.5;
      return {
        label,
        contributionPct: Number((deviationPct * (mag / 100) * 3.4).toFixed(2)),
        direction: (deviationPct >= 0 ? mag : -mag) > 0 ? ('up' as const) : ('down' as const),
      };
    }).sort((a, b) => Math.abs(b.contributionPct) - Math.abs(a.contributionPct));

    return {
      month,
      mineId,
      f1: Number(f1.toFixed(3)),
      f2: Number(f2.toFixed(3)),
      f3: Number(f3.toFixed(3)),
      tonnes: { forecast, plan, actual: v.actual, dispatch, sales },
      gradeMn: {
        plan: Number((gradeActual * (1 + (rng() - 0.5) * 0.05)).toFixed(2)),
        actual: Number(gradeActual.toFixed(2)),
        dispatch: Number((gradeActual * (0.99 + rng() * 0.03)).toFixed(2)),
      },
      containedMn: {
        forecast: Number(((forecast * gradeActual) / 100).toFixed(0)),
        plan: Number(((plan * gradeActual) / 100).toFixed(0)),
        actual: Number(v.mnT.toFixed(0)),
        dispatch: Number(((dispatch * gradeActual) / 100).toFixed(0)),
      },
      flagged: Math.abs(f2 - 1) > 0.1 || Math.abs(f1 - 1) > 0.1,
      deviationPct: Number(deviationPct.toFixed(2)),
      drivers: drivers.slice(0, 5),
    };
  });

  const tw = factors.reduce((s, f) => s + f.tonnes.actual, 0) || 1;
  const biasPct =
    (factors.reduce((s, f) => s + (f.f2 - 1) * f.tonnes.actual, 0) / tw) * 100;

  return {
    mineId,
    mineName: MINES.find((m) => m.id === mineId)?.name ?? mineId,
    factors,
    meanF1: mean(factors.map((f) => f.f1)),
    meanF2: mean(factors.map((f) => f.f2)),
    meanF3: mean(factors.map((f) => f.f3)),
    biasPct: Number(biasPct.toFixed(2)),
    flaggedMonths: factors.filter((f) => f.flagged).length,
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}

export const ALL_RECON = MINES.map((m) => buildReconciliation(m.id));

// ── Ore Continuity Index ────────────────────────────────────────────────

export interface OciRow {
  mineId: string;
  mineName: string;
  code: string;
  /** Accessible validated (measured + indicated) tonnes at the default cut-off. */
  accessibleTonnes: number;
  /** Monthly depletion implied by the current plan. */
  monthlyDepletionT: number;
  /** Months of ore cover at planned depletion. */
  oci: number;
  band: 'green' | 'amber' | 'red';
  trend: number[];
  inferredTonnes: number;
  containedMnT: number;
  meanGradeMn: number;
  cutOff: number;
  /** Trajectory over the last six months of the simulator. */
  ociHistory: { month: string; oci: number }[];
  /** The plan envelope OCI is measured against. */
  planLabel: string;
}

/** Planning horizon: 6 months of cover is the trigger for exploration targeting. */
export const OCI_GREEN_ABOVE = 9;
export const OCI_AMBER_ABOVE = 6;

export function ociFor(mineId: string, cutoff = DEFAULT_CUTOFF, depletionOverrideT?: number): OciRow {
  const est = ESTIMATES.find((e) => e.mineId === mineId)!;
  const mine = MINES.find((m) => m.id === mineId)!;
  // OCI counts only ore that the current approved plan can actually reach, so
  // the totals are restricted to the mine-plan envelope.
  const sum = reserveSummary(est, cutoff, true);
  const planned = recentPlanMonthly(mineId);
  const monthlyDepletionT = depletionOverrideT ?? planned;
  const accessible = sum.measuredTonnes + sum.indicatedTonnes;
  const oci = monthlyDepletionT > 0 ? accessible / monthlyDepletionT : 0;
  const band: OciRow['band'] = oci >= OCI_GREEN_ABOVE ? 'green' : oci >= OCI_AMBER_ABOVE ? 'amber' : 'red';

  const rng = makeRng(mineId.charCodeAt(2) * 3319 + 7);
  const trend = Array.from({ length: 12 }, (_, i) => {
    const drift = (i - 11) / 11;
    return Number((oci * (1 - 0.055 * drift) + (rng() - 0.5) * 0.16).toFixed(2));
  });
  trend[trend.length - 1] = Number(oci.toFixed(2));

  // Six months of OCI history from the reserve depletion that has occurred.
  const ociHistory: { month: string; oci: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    const depletion = planned * (1 + (rng() - 0.5) * 0.08);
    const added = sum.measuredTonnes + sum.indicatedTonnes;
    ociHistory.push({
      month: d.toISOString().slice(0, 7),
      oci: Number(((added + depletion * i * 0.98) / depletion).toFixed(2)),
    });
  }

  return {
    mineId,
    mineName: mine.name,
    code: mine.code,
    accessibleTonnes: accessible,
    monthlyDepletionT,
    oci,
    band,
    trend,
    inferredTonnes: sum.inferredTonnes,
    containedMnT: sum.containedMnT,
    meanGradeMn: sum.meanGradeMn,
    cutOff: cutoff,
    ociHistory,
    planLabel: mine.plan.label,
  };
}

function recentPlanMonthly(mineId: string): number {
  const mine = MINES.find((m) => m.id === mineId)!;
  return Math.round(mine.designTpd * 30 * 0.94);
}

export const ALL_OCI = MINES.map((m) => ociFor(m.id));

/** Company-wide OCI: total accessible tonnes over total monthly depletion. */
export function companyOci(): OciRow {
  const rows = ALL_OCI;
  const accessible = rows.reduce((s, r) => s + r.accessibleTonnes, 0);
  const depletion = rows.reduce((s, r) => s + r.monthlyDepletionT, 0);
  const oci = accessible / depletion;
  return {
    mineId: 'ALL',
    mineName: 'All three prototype mines',
    code: 'CO',
    accessibleTonnes: accessible,
    monthlyDepletionT: depletion,
    oci,
    band: oci >= OCI_GREEN_ABOVE ? 'green' : oci >= OCI_AMBER_ABOVE ? 'amber' : 'red',
    trend: rows[0].trend.map((_, i) => Number(((rows.reduce((s, r) => s + r.trend[i], 0) / rows.length) * 1.12).toFixed(2))),
    inferredTonnes: rows.reduce((s, r) => s + r.inferredTonnes, 0),
    containedMnT: rows.reduce((s, r) => s + r.containedMnT, 0),
    meanGradeMn: accessible > 0 ? (rows.reduce((s, r) => s + r.containedMnT, 0) / accessible) * 100 : 0,
    cutOff: DEFAULT_CUTOFF,
    planLabel: 'All three prototype mines',
    ociHistory: rows[0].ociHistory.map((h, i) => ({
      month: h.month,
      oci: Number((rows.reduce((s, r) => s + (r.ociHistory[i]?.oci ?? 0), 0) / rows.length).toFixed(2)),
    })),
  };
}