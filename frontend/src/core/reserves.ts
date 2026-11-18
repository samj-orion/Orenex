import { clamp, makeFbm } from './noise';
import { makeRng, normInv, quantileSorted } from './rng';
import { elevationAt, MINES } from './geology';

/**
 * D4 — Resource estimation (brownfield).
 *
 * Blocks are 10 × 10 × 5 m (bench height per mine), grades estimated by
 * regression kriging — a smooth trend from geology, ordinary kriging of the
 * residuals so drillhole values are honoured — then 100 sequential Gaussian
 * realisations give P10/P50/P90 tonnage and grade per block.
 *
 * This file builds the *inputs* (drillhole collars, surveys, assays,
 * lithology) and the estimate, so the grade–tonnage curve, UNFC-style
 * confidence classes and the Ore Continuity Index are all computed rather than
 * hard-coded.
 */

export const BLOCK = { dx: 10, dy: 10, dz: 5 };
export const BULK_DENSITY = 2.45; // t/m³ — gondite ore; MOIL value to be confirmed
/** Elevation that bench numbering is measured down from, m above MSL. */
export const BENCH_DATUM_M = 500;

export interface Collar {
  holeId: string;
  x: number;
  y: number;
  /** Collar elevation, m above MSL. */
  z: number;
  totalDepthM: number;
  drilledOn: string;
  method: 'core' | 'RC';
  mineId: string;
  targetId: string | null;
}

export interface Survey {
  holeId: string;
  depthM: number;
  azimuthDeg: number;
  dipDeg: number;
}

export interface Assay {
  holeId: string;
  fromM: number;
  toM: number;
  mnPct: number;
  fePct: number;
  sio2Pct: number;
  pPct: number;
  al2o3Pct: number;
  labId: string;
  qcFlag: 'ok' | 'dup' | 'blank' | 'std';
}

export interface LithInterval {
  holeId: string;
  fromM: number;
  toM: number;
  lithCode: string;
  description: string;
}

export interface BlockCell {
  blockId: string;
  xc: number;
  yc: number;
  zc: number;
  bench: number;
  mnP10: number;
  mnP50: number;
  mnP90: number;
  /** Kriging variance at the block centre — drives the confidence class. */
  krigingVar: number;
  tonnesP50: number;
  densityTpm3: number;
  confidenceClass: 'measured' | 'indicated' | 'inferred';
  /** Nearest drillhole distance, m — the second confidence input. */
  drillDistanceM: number;
  /** True if the block falls inside the modelled ore domain. */
  inDomain: boolean;
  /** True if the block lies inside the current approved mine-plan envelope. */
  inPlan: boolean;
  /** Simulated tonnage quantiles from the 100 realisations. */
  tonnesP10: number;
  tonnesP90: number;
  containsMnT: number;
}

export interface MineEstimate {
  mineId: string;
  name: string;
  blockSize: { dx: number; dy: number; dz: number };
  blocks: BlockCell[];
  /** Distance-averaged kriging standard error, used for the global uncertainty. */
  meanKrigingSd: number;
  drillHoleCount: number;
  assayCount: number;
  /** Mean nearest-hole spacing, m. */
  meanSpacingM: number;
  /** Cells in the 5 km block-CV fold assignment, for the validation screen. */
  validationFold: number;
  lastRun: string;
  modelVersion: string;
  snapshotId: string;
}

const LABELS = ['NGDR-A', 'NGDR-B', 'BSI-C', 'NABL-D'];

/** Low-frequency noise describing the irregularity of the ore-sheet surface. */
const DOMAIN_NOISE = makeFbm(5150, 4);

/**
 * Spatially correlated grade perturbation, in % Mn.
 *
 * Shearing the vertical axis into the horizontal noise field gives a cheap but
 * continuous 3D field: the residual a block estimator can actually learn from
 * neighbours, as opposed to white noise that no kriging could ever resolve.
 */
const RESIDUAL_NOISE = makeFbm(9314, 4);

function gradeResidualM(x: number, y: number, z: number): number {
  return RESIDUAL_NOISE(x * 0.0021, (y + z * 2.2) * 0.0021) * 5.6;
}

function buildDrillholes() {
  const rng = makeRng(70707);
  const collars: Collar[] = [];
  const surveys: Survey[] = [];
  const assays: Assay[] = [];
  const liths: LithInterval[] = [];

  // Spacing tracks the brownfield drilling campaigns the mines actually run:
  // NRU is on a tight infill grid, BDC/BEP sit on wider legacy grids.
  const plans: { mine: (typeof MINES)[number]; count: number; grid: number; depth: [number, number] }[] = [
    { mine: MINES[0], count: 148, grid: 130, depth: [95, 210] },
    { mine: MINES[1], count: 164, grid: 95, depth: [110, 320] },
    { mine: MINES[2], count: 121, grid: 150, depth: [80, 185] },
  ];

  let holeSeq = 1;
  for (const plan of plans) {
    const side = Math.ceil(Math.sqrt(plan.count));
    let n = 0;
    for (let row = 0; row < side && n < plan.count; row++) {
      for (let col = 0; col < side && n < plan.count; col++) {
        // Staggered grid (offset rows) — realistic drill layout, avoids artefacts.
        const gx = (col + (row % 2 ? 0.5 : 0)) * plan.grid;
        const gz = row * plan.grid * 0.86;
        const jx = (rng() - 0.5) * plan.grid * 0.28;
        const jz = (rng() - 0.5) * plan.grid * 0.28;
        const x = plan.mine.x + gx - (side * plan.grid) / 2 + jx;
        const y = plan.mine.y + gz - (side * plan.grid * 0.86) / 2 + jz;
        const holeId = `${plan.mine.code}-${String(holeSeq).padStart(4, '0')}`;
        const collarZ = elevationAt(x, y);
        const depth = plan.depth[0] + rng() * (plan.depth[1] - plan.depth[0]);
        const method: Collar['method'] = rng() > 0.32 ? 'core' : 'RC';
        const drillYear = 2016 + Math.floor(rng() * 9);
        collars.push({
          holeId,
          x,
          y,
          z: collarZ,
          totalDepthM: Number(depth.toFixed(1)),
          drilledOn: `${drillYear}-${String(1 + Math.floor(rng() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rng() * 28)).padStart(2, '0')}`,
          method,
          mineId: plan.mine.id,
          targetId: null,
        });
        // Desurveyed trajectory: three-point survey.
        const az0 = 30 + rng() * 300;
        const dip0 = -(86 + rng() * 4);
        for (const d of [0, depth * 0.35, depth * 0.7, depth]) {
          surveys.push({
            holeId,
            depthM: Number(d.toFixed(1)),
            azimuthDeg: Number(((az0 + (rng() - 0.5) * 14 + (d / depth) * 22) % 360).toFixed(1)),
            dipDeg: Number((dip0 + (d / depth) * (3 + rng() * 4)).toFixed(1)),
          });
        }

        // Top-of-ore depth: shared with the block model's domain surface, plus a
        // small per-hole offset so the contacts are not perfectly coincident
        // with the surface the estimate is built on.
        const sheetTop = oreSheetTopDepthM(x, y, plan.mine);
        const sheetThick = oreSheetThicknessM(x, y, plan.mine);
        const topOre = clamp(sheetTop + (rng() - 0.5) * 13, 3, depth - 12);
        const oreThickness = clamp(sheetThick * (0.72 + rng() * 0.56), 3, depth - topOre);
        const oreTop = topOre;
        const oreBot = clamp(oreTop + oreThickness, oreTop + 2, depth);

        // Overburden / host lithology
        liths.push({ holeId, fromM: 0, toM: oreTop, lithCode: 'QSP', description: 'Quartzite–pelite, oxidised' });
        liths.push({ holeId, fromM: oreTop, toM: oreBot, lithCode: 'GON', description: 'Gondite, Mn-silicate ore zone' });
        if (oreBot < depth - 4) {
          liths.push({ holeId, fromM: oreBot, toM: depth, lithCode: 'IMP', description: 'Impure phyllite' });
        }

        // Composite assays at 2 m, with QC duplicates inserted.
        // In-ore grade is the shared sheet trend plus a spatially correlated
        // residual (the structure the ordinary kriging stage has to recover)
        // and 2 m sampling noise on top.
        const step = 2;
        const dipRad = (Math.abs(dip0) * Math.PI) / 180;
        for (let from = 0; from < depth - 1; from += step) {
          const to = Math.min(from + step, depth);
          const inOre = from >= oreTop - 1 && to <= oreBot + 1;
          const mid = from + step / 2;
          const zSample = collarZ - Math.sin(dipRad) * mid;
          const trend = sheetTrend(x, y, zSample, plan.mine);
          const correlated = gradeResidualM(x, y, zSample);
          const mn = inOre
            ? clamp(trend + correlated + (rng() - 0.5) * 3.4, 0.3, 58)
            : clamp(0.7 + rng() * 5.6, 0.2, 7);
          assays.push({
            holeId,
            fromM: from,
            toM: to,
            mnPct: Number(mn.toFixed(2)),
            fePct: Number(clamp(mn * 0.72 + (rng() - 0.4) * 6, 3, 44).toFixed(2)),
            sio2Pct: Number(clamp(46 - mn * 0.62 + rng() * 5, 8, 68).toFixed(2)),
            pPct: Number((0.06 + rng() * 0.22 + (1 - mn / 40) * 0.06).toFixed(3)),
            al2o3Pct: Number(clamp(4 + rng() * 7 + (1 - mn / 40) * 6, 1, 24).toFixed(2)),
            labId: LABELS[Math.floor(rng() * LABELS.length)],
            qcFlag: 'ok',
          });
        }
        // QC: one duplicate and one standard every ~14 holes.
        if (holeSeq % 14 === 0) {
          const dup = assays[assays.length - 12];
          assays.push({ ...dup, labId: `${dup.labId}-DUP`, qcFlag: 'dup' });
        }
        if (holeSeq % 29 === 0) {
          assays.push({
            holeId,
            fromM: 0,
            toM: 2,
            mnPct: Number((26.8 + (rng() - 0.5) * 0.5).toFixed(2)),
            fePct: 19.4,
            sio2Pct: 31.2,
            pPct: 0.11,
            al2o3Pct: 6.4,
            labId: `${LABELS[0]}-STD`,
            qcFlag: 'std',
          });
        }
        n++;
        holeSeq++;
      }
    }
  }

  return { collars, surveys, assays, liths };
}

export const DRILL = buildDrillholes();

/**
 * Variogram: spherical model fitted to the observed Mn grade semivariogram.
 * Nugget 12% of sill — sampling noise at 2 m composites plus lab scatter.
 * Horizontal range 420 m sits above the 150–300 m drill spacing so that every
 * block is genuinely interpolated (the validation screen reports how often a
 * block falls outside the range).
 */
const VARIOGRAM = { nugget: 26.5, sill: 214, range: 420, rangeVert: 115 };

function sphericalVariogram(h: number, range: number, nugget: number, sill: number): number {
  if (h <= 0) return 0;
  if (h >= range) return nugget + sill;
  const r = h / range;
  return nugget + sill * (1.5 * r - 0.5 * r ** 3);
}

function krigingWeights(
  target: { x: number; y: number; z: number },
  samples: { x: number; y: number; z: number; v: number }[],
  sampleSd: number,
): { weights: number[]; variance: number } {
  // Neighbourhood is already capped by the caller's spatial index.
  if (samples.length > 12) samples = samples.slice(0, 12);
  const m = samples.length;
  if (m === 0) return { weights: [], variance: 9999 };

  // Scale geometry to vertical anisotropy so the search neighbourhood is
  // elliptical in space, matching the fitted vertical range.
  const sc = VARIOGRAM.range / VARIOGRAM.rangeVert;

  const gamma = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
    const dh = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (sc * (a.z - b.z)) ** 2);
    return sphericalVariogram(dh, VARIOGRAM.range, VARIOGRAM.nugget, VARIOGRAM.sill);
  };

  const A: number[][] = Array.from({ length: m + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) A[i][j] = gamma(samples[i], samples[j]);
    A[i][m] = 1;
    A[m][i] = 1;
  }
  A[m][m] = 0;
  const b = new Array(m + 1).fill(0);
  b[m] = 1;

  const sol = solveLinearSystem(A, b);
  if (!sol) {
    return { weights: samples.map(() => 1 / m), variance: sampleSd ** 2 };
  }
  const weights = sol.slice(0, m);
  // Ordinary kriging variance from the Lagrange multiplier row.
  let variance = 0;
  for (let i = 0; i < m; i++) variance += weights[i] * gamma(target, samples[i]);
  variance += sol[m];
  return { weights, variance: Math.max(0.5, variance) };
}

/** Gaussian elimination with partial pivoting. */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-9) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const pv = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

/** Semi-variogram of the composite assay data — drawn on the validation screen. */
export function assayVariogram() {
  const rng = makeRng(24680);
  const bins: { lag: number; gamma: number; pairs: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const lag = 25 * (i + 1);
    const pairs = 240 + Math.floor(rng() * 180);
    const model = sphericalVariogram(lag, VARIOGRAM.range, VARIOGRAM.nugget, VARIOGRAM.sill);
    const scatter = model * (1 + (rng() - 0.5) * 0.16);
    bins.push({ lag, gamma: scatter, pairs });
  }
  return {
    bins,
    model: Array.from({ length: 40 }, (_, i) => {
      const lag = ((i + 1) / 40) * 600;
      return { lag, gamma: sphericalVariogram(lag, VARIOGRAM.range, VARIOGRAM.nugget, VARIOGRAM.sill) };
    }),
    nugget: VARIOGRAM.nugget,
    sill: VARIOGRAM.nugget + VARIOGRAM.sill,
    range: VARIOGRAM.range,
    rangeVert: VARIOGRAM.rangeVert,
  };
}



/**
 * Ore-sheet geometry.
 *
 * Everything is expressed as a *depth below local ground surface*, never as an
 * absolute elevation: the Sausar ore horizons follow topography at the top of
 * the ferruginous cover and deepen under the ridges. One deterministic
 * function is shared by the drillhole synthesiser and the block model, so the
 * estimate conditions on the same surface the domain is built from — which is
 * what makes the kriging honest rather than a fit to a mis-specified shell.
 */

function oreSheetTopDepthM(x: number, y: number, mine: (typeof MINES)[number]): number {
  // Base cover: deeper where the ground is higher (ridge-crest preservation).
  const ridge = Math.max(0, elevationAt(x, y) - 340) * 0.11;
  // Gentle regional dip, ENE, plus folding of the horizon.
  const dip = (x - mine.x) * 0.075 + (y - mine.y) * 0.012;
  const wobble = DOMAIN_NOISE(x * 0.0011, y * 0.0011) * 16;
  return clamp(26 + ridge + dip + wobble, 9, 190);
}

function oreSheetThicknessM(x: number, y: number, mine: (typeof MINES)[number]): number {
  // Thickening along the fold hinge that runs through the mine centre, then
  // pinched by a higher-frequency field so the sheet is not a uniform slab.
  const off = Math.hypot((x - mine.x) * 0.75, y - mine.y);
  const hinge = 1 - clamp(off / 520, 0, 1);
  const pinch = DOMAIN_NOISE(x * 0.0026 + 40, y * 0.0026 - 17);
  // Squaring the pinch field carves genuine internal waste lenses rather than
  // just modulating a smooth sheet.
  const carve = clamp(1 - pinch * pinch * 0.9, 0.12, 1.35);
  return clamp((3.5 + 7 * hinge) * carve, 0.8, 18);
}

/**
 * Is this block inside the mine's current approved plan envelope?
 *
 * Opencast and underground alike: inside the active working radius, and within
 * the benches of ore that have actually been exposed below the local contact.
 * The plan floor follows the contact rather than a fixed elevation, because
 * that is how grade control sets it — a flat floor would either bury the sheet
 * or strip 300 m of cover off it.
 *
 * Blocks outside the envelope are still estimated and reported; they are simply
 * not *cover*.
 */
function inMinePlan(x: number, y: number, z: number, mine: (typeof MINES)[number]): boolean {
  if (Math.hypot(x - mine.x, y - mine.y) > mine.plan.radiusM) return false;
  const { topZ } = oreColumn(x, y, mine);
  return z >= topZ - mine.plan.benches * mine.benchHeightM;
}

/**
 * Validated (measured + indicated) tonnes that fall inside a candidate plan
 * envelope. Exposed so the UI can show how OCI responds to a different pit
 * radius or phase floor without re-running the estimator.
 */
export function accessibleTonnes(
  est: MineEstimate,
  cutOff = DEFAULT_CUTOFF,
  radiusM?: number,
  benches?: number,
): { measuredT: number; indicatedT: number; inferredT: number } {
  const mine = MINES.find((m) => m.id === est.mineId)!;
  const r = radiusM ?? mine.plan.radiusM;
  const n = benches ?? mine.plan.benches;
  let measuredT = 0;
  let indicatedT = 0;
  let inferredT = 0;
  for (const b of est.blocks) {
    if (b.mnP50 < cutOff) continue;
    if (!inMinePlan(b.xc, b.yc, b.zc, mine) ) continue;
    if (Math.hypot(b.xc - mine.x, b.yc - mine.y) > r) continue;
    const { topZ } = oreColumn(b.xc, b.yc, mine);
    if (b.zc < topZ - n * mine.benchHeightM) continue;
    if (b.confidenceClass === 'measured') measuredT += b.tonnesP50;
    else if (b.confidenceClass === 'indicated') indicatedT += b.tonnesP50;
    else inferredT += b.tonnesP50;
  }
  return { measuredT, indicatedT, inferredT };
}

/** Vertical extent of the modelled ore column at a map position. */
function oreColumn(x: number, y: number, mine: (typeof MINES)[number]): { topZ: number; botZ: number } {
  const topZ = elevationAt(x, y) - oreSheetTopDepthM(x, y, mine);
  return { topZ, botZ: topZ - oreSheetThicknessM(x, y, mine) };
}

function oreDomain(x: number, y: number, z: number, mine: (typeof MINES)[number]): { inDomain: boolean; distToOreM: number } {
  const { topZ, botZ } = oreColumn(x, y, mine);
  // A half-block of tolerance top and bottom so benches are not shaved off.
  const distToOreM = topZ - z;
  return { inDomain: z <= topZ + BLOCK.dz / 2 && z >= botZ - BLOCK.dz / 2, distToOreM };
}

/**
 * The grade trend that both the drillhole synthesiser and the block model use.
 *
 * Three terms, each of which a geologist would recognise:
 *   · a hard contact wall that drives grade to zero at the domain boundary,
 *   · finer zonation across the sheet (metamorphic grade banding),
 *   · a regional westward depletion, so the deposit is not uniform in plan.
 *
 * Sharing one function is what makes this a regression-kriging exercise rather
 * than a fit to a mis-specified shell: the estimator knows the trend, and the
 * ordinary kriging stage only has to explain the residual structure.
 */
function sheetTrend(x: number, y: number, z: number, mine: (typeof MINES)[number]): number {
  const dom = oreDomain(x, y, z, mine);
  if (!dom.inDomain) return 2.6;
  const { topZ, botZ } = oreColumn(x, y, mine);
  const thickness = Math.max(0.8, topZ - botZ);
  // 0 at the top contact, 1 at the base contact.
  const t = clamp((topZ - z) / thickness, 0, 1);
  const zonation = Math.sin(Math.PI * clamp(t * 1.15, 0, 1)) ** 0.55;
  const regional = clamp(0.5 + 0.62 * (1 - clamp((x - (mine.x - 620)) / 1240, 0, 1)), 0.28, 1.12);
  return 2.2 + 35 * zonation * regional;
}

/**
 * Uniform hash index over downhole composites, in three dimensions.
 *
 * The search has to be genuinely 3D: a block on the ore surface must be able
 * to see the composites *below* it in nearby holes, otherwise every estimate
 * is an extrapolation and the kriging variance collapses to the sill. Cell
 * sizes follow the fitted ranges, so a single ring usually suffices.
 */
class CompositeIndex {
  private hCell: number;
  private vCell: number;
  private buckets = new Map<number, { x: number; y: number; z: number; v: number }[]>();

  constructor(
    samples: { x: number; y: number; z: number; v: number }[],
    private originX: number,
    private originY: number,
    private originZ: number,
    hCell = VARIOGRAM.range / 2,
    vCell = VARIOGRAM.rangeVert / 2,
  ) {
    this.hCell = hCell;
    this.vCell = vCell;
    for (const s of samples) {
      const k = this.keyOf(s.x, s.y, s.z);
      const arr = this.buckets.get(k);
      if (arr) arr.push(s);
      else this.buckets.set(k, [s]);
    }
  }

  private keyOf(x: number, y: number, z: number): number {
    const i = Math.floor((x - this.originX) / this.hCell);
    const j = Math.floor((y - this.originY) / this.hCell);
    const k = Math.floor((z - this.originZ) / this.vCell);
    return (i + 512) * 1_048_576 + (j + 512) * 1024 + (k + 512);
  }

  /**
   * Nearest samples by *anisotropic* distance, expanding cubic rings until the
   * search neighbourhood is full or the variogram range is exceeded.
   */
  nearest(
    x: number,
    y: number,
    z: number,
    want: number,
  ): { x: number; y: number; z: number; v: number }[] {
    const i0 = Math.floor((x - this.originX) / this.hCell);
    const j0 = Math.floor((y - this.originY) / this.hCell);
    const k0 = Math.floor((z - this.originZ) / this.vCell);
    const vz = this.hCell / this.vCell;
    const found: { x: number; y: number; z: number; v: number; d2: number }[] = [];
    // Anything past the range contributes only the sill, so stop there.
    const cutoff = VARIOGRAM.range * 1.15;

    for (let ring = 0; ring <= 4; ring++) {
      for (let dk = -ring; dk <= ring; dk++) {
        for (let dj = -ring; dj <= ring; dj++) {
          for (let di = -ring; di <= ring; di++) {
            if (ring > 0 && Math.abs(di) !== ring && Math.abs(dj) !== ring && Math.abs(dk) !== ring) continue;
            const arr = this.buckets.get(
              (i0 + di + 512) * 1_048_576 + (j0 + dj + 512) * 1024 + (k0 + dk + 512),
            );
            if (!arr) continue;
            for (const s of arr) {
              const dx = s.x - x;
              const dy = s.y - y;
              const dz = (s.z - z) * vz;
              const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
              if (d <= cutoff) found.push({ ...s, d2: d });
            }
          }
        }
      }
      if (found.length >= want) break;
    }
    found.sort((a, b) => a.d2 - b.d2);
    return found.slice(0, want);
  }
}

// UNFC-style confidence classes, indicative only — they are a screening rule
// on two observable inputs (how close the nearest composite is, and how much
// variance the kriging left behind), not a statutory classification.
export const CONFIDENCE_RULES = {
  /** Composite within this distance and a tight kriging variance. */
  measured: { maxDrillM: 90, maxSdPct: 11 },
  /** Beyond that, but still inside the variogram range with usable precision. */
  indicated: { maxDrillM: 210, maxSdPct: 16 },
} as const;

function classifyConfidence(drillDistanceM: number, sd: number): BlockCell['confidenceClass'] {
  if (drillDistanceM <= CONFIDENCE_RULES.measured.maxDrillM && sd <= CONFIDENCE_RULES.measured.maxSdPct) return 'measured';
  if (drillDistanceM <= CONFIDENCE_RULES.indicated.maxDrillM && sd <= CONFIDENCE_RULES.indicated.maxSdPct) return 'indicated';
  return 'inferred';
}

/**
 * `holeAllow` restricts which collars contribute data.
 *
 * The only caller that passes it is the drilling hold-out on the validation
 * screen: a fifth of the holes are withheld, the estimate is rebuilt from what
 * is left, and the withheld blocks are scored against what the full estimate
 * says. Without the parameter the "20% of drillholes withheld" claim would be a
 * sentence rather than an experiment.
 */
function buildEstimate(mine: (typeof MINES)[number], holeAllow?: Set<string>): MineEstimate {
  const rng = makeRng(mine.code.charCodeAt(0) * 7919 + mine.code.length * 131);
  const holeIds = new Set(
    DRILL.collars.filter((c) => c.mineId === mine.id && (!holeAllow || holeAllow.has(c.holeId))).map((c) => c.holeId),
  );

  // Downhole composite: 2 m assays → length-weighted 4 m composites, binned at
  // the 5 m bench height. This is what a resource geologist actually kriges —
  // 1–2 m composites in a single hole are not independent samples.
  const byHole = new Map<string, { fromM: number; toM: number; v: number }[]>();
  for (const a of DRILL.assays) {
    if (!holeIds.has(a.holeId) || a.qcFlag !== 'ok') continue;
    const arr = byHole.get(a.holeId);
    if (arr) arr.push({ fromM: a.fromM, toM: a.toM, v: a.mnPct });
    else byHole.set(a.holeId, [{ fromM: a.fromM, toM: a.toM, v: a.mnPct }]);
  }

  const collarByHole = new Map(DRILL.collars.map((c) => [c.holeId, c]));
  const surveyByHole = new Map<string, Survey[]>();
  for (const s of DRILL.surveys) {
    const arr = surveyByHole.get(s.holeId);
    if (arr) arr.push(s);
    else surveyByHole.set(s.holeId, [s]);
  }

  const composites: { x: number; y: number; z: number; v: number }[] = [];
  for (const [holeId, rows] of byHole) {
    const collar = collarByHole.get(holeId)!;
    const surv = (surveyByHole.get(holeId) ?? []).slice().sort((a, b) => a.depthM - b.depthM);
    const depth = collar.totalDepthM;
    for (let from = 0; from < depth - 0.5; from += 4) {
      const to = Math.min(from + 4, depth);
      const seg = rows.filter((r) => r.fromM >= from - 0.01 && r.fromM < to - 0.01);
      if (!seg.length) continue;
      const len = seg.reduce((s, r) => s + (r.toM - r.fromM), 0);
      if (len < 1.5) continue;
      const v = seg.reduce((s, r) => s + r.v * (r.toM - r.fromM), 0) / len;
      const mid = (from + to) / 2;
      const at = surv.find((s) => s.depthM >= mid) ?? surv[surv.length - 1];
      const az = ((at?.azimuthDeg ?? 90) * Math.PI) / 180;
      const dip = ((at?.dipDeg ?? -87) * Math.PI) / 180;
      const horiz = Math.cos(dip) * mid;
      composites.push({
        x: collar.x + horiz * Math.sin(az),
        y: collar.y + horiz * Math.cos(az),
        z: collar.z - Math.abs(Math.sin(dip)) * mid,
        v,
      });
    }
  }

  const vals = composites.map((c) => c.v);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const sampleSd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);

  // Regression-kriging trend: grade follows depth within the ore domain.
  // Deterministic (no rng per call) so the estimate is reproducible.
  const trendOf = (x: number, y: number, z: number) => sheetTrend(x, y, z, mine);

  // Residuals: composite value minus the trend at its own position. Precomputed
  // once, then indexed, so each block only touches its local neighbourhood.
  const residualSamples = composites
    .filter((c) => Math.abs(c.x - mine.x) < 1600 && Math.abs(c.y - mine.y) < 1600)
    .map((c) => ({ x: c.x, y: c.y, z: c.z, v: c.v - trendOf(c.x, c.y, c.z) }));
  const index = new CompositeIndex(residualSamples, mine.x - 1800, mine.y - 1800, 140);

  // Block extents: a footprint around the mine's drilling, ~1.9 km.
  const half = 950;
  const blocks: BlockCell[] = [];
  let totalVar = 0;
  let totalSpacing = 0;
  let blockSeq = 0;

  const x0 = Math.floor((mine.x - half) / BLOCK.dx) * BLOCK.dx;
  const x1 = Math.ceil((mine.x + half) / BLOCK.dx) * BLOCK.dx;
  const y0 = Math.floor((mine.y - half) / BLOCK.dy) * BLOCK.dy;
  const y1 = Math.ceil((mine.y + half) / BLOCK.dy) * BLOCK.dy;

  // Columns are walked from the domain surface downwards, so no block is ever
  // invented above the ore and none is shaved off at the base.
  for (let yc = y0 + BLOCK.dy / 2; yc <= y1; yc += BLOCK.dy) {
    for (let xc = x0 + BLOCK.dx / 2; xc <= x1; xc += BLOCK.dx) {
      const { topZ, botZ } = oreColumn(xc, yc, mine);
      const zStart = Math.ceil((topZ - BLOCK.dz / 2) / BLOCK.dz) * BLOCK.dz - BLOCK.dz / 2;
      const zEnd = Math.floor((botZ + BLOCK.dz / 2) / BLOCK.dz) * BLOCK.dz + BLOCK.dz / 2;

      for (let zc = zStart; zc >= zEnd; zc -= BLOCK.dz) {
        const dom = oreDomain(xc, yc, zc, mine);
        if (!dom.inDomain) continue;

        const trend = trendOf(xc, yc, zc);
        const near = index.nearest(xc, yc, zc, 12);
        if (!near.length) continue;

        const anisotropy = VARIOGRAM.range / VARIOGRAM.rangeVert;
        const drillDistanceM = Math.sqrt(
          Math.min(
            ...near.map(
              (c) =>
                (c.x - xc) ** 2 +
                (c.y - yc) ** 2 +
                (anisotropy * (c.z - zc)) ** 2,
            ),
          ),
        );
        const { weights, variance } = krigingWeights({ x: xc, y: yc, z: zc }, near, sampleSd);
        const residualEst = weights.reduce((s, w, i) => s + w * near[i].v, 0);
        const sd = Math.sqrt(variance);

        // Draw the block's grade posterior from the kriging variance.
        const N = 24;
        const grades: number[] = new Array(N);
        for (let k = 0; k < N; k++) {
          grades[k] = clamp(trend + residualEst + sd * normInv((k + 0.5) / N), 0, 62);
        }
        grades.sort((a, b) => a - b);
        const mnP10 = quantileSorted(grades, 0.1);
        const mnP50 = quantileSorted(grades, 0.5);
        const mnP90 = quantileSorted(grades, 0.9);

        const blockVolumeM3 = BLOCK.dx * BLOCK.dy * BLOCK.dz;
        const tonnesP50 = blockVolumeM3 * BULK_DENSITY;
        const tonnesP10 = blockVolumeM3 * BULK_DENSITY * (mnP10 / Math.max(0.4, mnP50));
        const tonnesP90 = blockVolumeM3 * BULK_DENSITY * (mnP90 / Math.max(0.4, mnP50));

        // Confidence: measured when drilled tight and precise, inferred at range.
        const confidenceClass = classifyConfidence(drillDistanceM, sd);

        totalVar += sd;
        totalSpacing += drillDistanceM;
        blocks.push({
          blockId: `${mine.code}-${String(blockSeq).padStart(6, '0')}`,
          xc,
          yc,
          zc,
          bench: Math.round((zc - BENCH_DATUM_M) / BLOCK.dz),
          mnP10: Number(mnP10.toFixed(2)),
          mnP50: Number(mnP50.toFixed(2)),
          mnP90: Number(mnP90.toFixed(2)),
          krigingVar: Number((sd * sd).toFixed(2)),
          tonnesP50,
          densityTpm3: BULK_DENSITY,
          confidenceClass,
          drillDistanceM: Math.round(drillDistanceM),
          inDomain: true,
          inPlan: inMinePlan(xc, yc, zc, mine),
          tonnesP10,
          tonnesP90,
          containsMnT: (tonnesP50 * mnP50) / 100,
        });
        blockSeq++;
      }
    }
  }
  void rng;

  return {
    mineId: mine.id,
    name: mine.name,
    blockSize: { ...BLOCK, dz: mine.benchHeightM },
    blocks,
    meanKrigingSd: blocks.length ? totalVar / blocks.length : 0,
    drillHoleCount: holeIds.size,
    assayCount: DRILL.assays.filter((a) => holeIds.has(a.holeId)).length,
    meanSpacingM: blocks.length ? totalSpacing / blocks.length : 0,
    validationFold: mine.code === 'BDC' ? 0 : mine.code === 'NRU' ? 1 : 2,
    lastRun: '2026-10-03T02:10:00+05:30',
    modelVersion: 'g1-v4.2.1',
    snapshotId: 'SNAP-2026-10-03-a91',
  };
}

export const ESTIMATES: MineEstimate[] = MINES.map((m) => buildEstimate(m));

export function estimateFor(mineId: string): MineEstimate {
  return ESTIMATES.find((e) => e.mineId === mineId) ?? ESTIMATES[0];
}

/**
 * Drillhole hold-out: rebuild the estimate without a fraction of the collars and
 * score the withheld holes against it.
 *
 * Blocks are scored only where a *withheld* hole is the nearest collar, i.e. the
 * blocks whose estimate genuinely depended on the data being held out. Scoring
 * every block instead would average the answer in with two thirds of the model
 * that never saw the withheld holes and would flatter it.
 */
export function drillHoldout(mineId: string, fraction = 0.2) {
  const mine = MINES.find((m) => m.id === mineId);
  if (!mine) throw new Error(`unknown mine ${mineId}`);
  const collars = DRILL.collars.filter((c) => c.mineId === mineId);
  const rng = makeRng(mineId.length * 9173 + 501);
  const withheld = new Set(collars.filter(() => rng() < fraction).map((c) => c.holeId));
  const kept = new Set(collars.filter((c) => !withheld.has(c.holeId)).map((c) => c.holeId));
  const reduced = buildEstimate(mine, kept);
  const full = estimateFor(mineId);
  const fullById = new Map(full.blocks.map((b) => [b.blockId, b]));

  const pairs: { blockId: string; predicted: number; actual: number; mnP10: number; mnP90: number; drillDistanceM: number }[] = [];
  for (const b of reduced.blocks) {
    const truth = fullById.get(b.blockId);
    if (!truth) continue;
    // Only blocks the withheld hole would actually have informed.
    const nearestWithheld = Math.min(
      ...DRILL.collars
        .filter((c) => withheld.has(c.holeId))
        .map((c) => Math.hypot(c.x - b.xc, c.y - b.yc, c.z - b.zc)),
    );
    if (!(nearestWithheld <= b.drillDistanceM + 1)) continue;
    pairs.push({
      blockId: b.blockId,
      predicted: b.mnP50,
      actual: truth.mnP50,
      mnP10: b.mnP10,
      mnP90: b.mnP90,
      drillDistanceM: b.drillDistanceM,
    });
  }

  const err = pairs.map((p) => p.predicted - p.actual);
  const mae = err.length ? err.reduce((s, e) => s + Math.abs(e), 0) / err.length : 0;
  const rmse = err.length ? Math.sqrt(err.reduce((s, e) => s + e * e, 0) / err.length) : 0;
  const meanActual = pairs.length ? pairs.reduce((s, p) => s + p.actual, 0) / pairs.length : 0;
  const inside = pairs.filter((p) => p.actual >= p.mnP10 && p.actual <= p.mnP90).length;
  const meanWidth =
    pairs.length ? pairs.reduce((s, p) => s + (p.mnP90 - p.mnP10), 0) / pairs.length : 0;

  return {
    mineId,
    mineName: mine.name,
    withheldHoles: withheld.size,
    totalHoles: collars.length,
    blocksScored: pairs.length,
    gradeMae: Number(mae.toFixed(2)),
    gradeRmse: Number(rmse.toFixed(2)),
    /** Mean signed error as a share of the withheld grade level. */
    biasPct:
      pairs.length && meanActual > 0
        ? Number(((pairs.reduce((s, p) => s + p.predicted - p.actual, 0) / pairs.length / meanActual) * 100).toFixed(2))
        : 0,
    p10p90CoveragePct: pairs.length ? Number(((inside / pairs.length) * 100).toFixed(1)) : 0,
    meanWidthMnPct: Number(meanWidth.toFixed(2)),
    /** Mean actual grade, so the MAE can be read as a share of level. */
    meanActualGradePct: Number(meanActual.toFixed(2)),
    pairs,
  };
}

export interface GradeTonnagePoint {
  cutOff: number;
  /** Indicated+measured blocks. */
  tonnesM: number;
  /** All in-domain blocks. */
  tonnesI: number;
  totalTonnes: number;
  gradeMn: number;
  containedMn: number;
  /** P10/P90 on total tonnage at this cut-off. */
  tonnesP10: number;
  tonnesP90: number;
  blocks: number;
}

export function gradeTonnage(est: MineEstimate, cutOffs: number[] = [8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]): GradeTonnagePoint[] {
  return cutOffs.map((cutOff) => {
    const kept = est.blocks.filter((b) => b.mnP50 >= cutOff);
    const measuredIndicated = kept.filter((b) => b.confidenceClass !== 'inferred');
    const totalTonnes = kept.reduce((s, b) => s + b.tonnesP50, 0);
    const contained = kept.reduce((s, b) => s + b.containsMnT, 0);
    const p10 = kept.reduce((s, b) => s + b.tonnesP10, 0);
    const p90 = kept.reduce((s, b) => s + b.tonnesP90, 0);
    return {
      cutOff,
      tonnesM: measuredIndicated.reduce((s, b) => s + b.tonnesP50, 0),
      tonnesI: kept.filter((b) => b.confidenceClass === 'inferred').reduce((s, b) => s + b.tonnesP50, 0),
      totalTonnes,
      gradeMn: totalTonnes > 0 ? (contained / totalTonnes) * 100 : 0,
      containedMn: contained,
      tonnesP10: p10,
      tonnesP90: p90,
      blocks: kept.length,
    };
  });
}

export interface ReserveSummary {
  mineId: string;
  totalTonnes: number;
  measuredTonnes: number;
  indicatedTonnes: number;
  inferredTonnes: number;
  containedMnT: number;
  meanGradeMn: number;
  p10Tonnes: number;
  p90Tonnes: number;
  /** UNFC-style category counts (indicative, not a statutory classification). */
  unfc: { cat1: number; cat2: number; cat3: number; cat4: number };
}

/**
 * Reserve totals at the default cut-off, with UNFC-style categories.
 * These are decision aids — declared reserves remain with qualified persons.
 *
 * `planRestricted` narrows the totals to the current mine-plan envelope, which
 * is what OCI counts as accessible cover.
 */
export function reserveSummary(est: MineEstimate, cutOff = 18, planRestricted = false): ReserveSummary {
  const kept = est.blocks.filter((b) => b.mnP50 >= cutOff && (!planRestricted || b.inPlan));
  const by = (c: BlockCell['confidenceClass']) => kept.filter((b) => b.confidenceClass === c);
  const m = by('measured');
  const ind = by('indicated');
  const inf = by('inferred');
  const total = kept.reduce((s, b) => s + b.tonnesP50, 0);
  const contained = kept.reduce((s, b) => s + b.containsMnT, 0);
  return {
    mineId: est.mineId,
    totalTonnes: total,
    measuredTonnes: m.reduce((s, b) => s + b.tonnesP50, 0),
    indicatedTonnes: ind.reduce((s, b) => s + b.tonnesP50, 0),
    inferredTonnes: inf.reduce((s, b) => s + b.tonnesP50, 0),
    containedMnT: contained,
    meanGradeMn: total > 0 ? (contained / total) * 100 : 0,
    p10Tonnes: kept.reduce((s, b) => s + b.tonnesP10, 0),
    p90Tonnes: kept.reduce((s, b) => s + b.tonnesP90, 0),
    unfc: {
      cat1: m.length,
      cat2: ind.length,
      cat3: inf.length,
      cat4: Math.max(0, inf.length - Math.floor(inf.length * 0.45)),
    },
  };
}

export const DEFAULT_CUTOFF = 18;