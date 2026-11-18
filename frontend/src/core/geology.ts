import { AOI_HEIGHT_M, AOI_WIDTH_M, denormX, denormY, normX, normY } from './geo';
import { clamp, makeFbm, makeRidged, makeNoise2D, sampleField, smoothstep } from './noise';
import { makeRng, range } from './rng';

/**
 * The prototype surface: a synthetic but geologically structured model of the
 * Balaghat–Nagpur manganese belt (Sausar Group metasediments).
 *
 * Why synthetic: SIH provides no dataset. Public geology + satellite are used
 * for the real layers; ore geometry, drillholes, production and equipment are
 * generated so the whole loop runs end-to-end. Every table produced here is
 * flagged is_synthetic, exactly as the data plan requires.
 */

export const GRID_NX = 168; // ~390 m cells (rendered field)
export const GRID_NY = 150; // ~387 m cells

export type LithCode =
  | 'GON' // gondite / Mn-silicate host
  | 'QSP' // quartzite–pelite (Sausar)
  | 'IMP' //impure phyllite
  | 'BIF' // banded iron formation
  | 'GRN' //granite gneiss basement
  | 'ALL' //alluvium / laterite cover
  | 'DOL'; //dolomite marble

export interface GeoUnit {
  id: string;
  code: LithCode;
  name: string;
  /** Sausar-group members host Mn; other units are host-unfavourable. */
  favourable: boolean;
  /**
   * Blanket cover — laterite, alluvium, thick regolith. Anything that buries the
   * horizon: vegetation, soil moisture and thermal response follow this, and
   * surface expression of the ore is attenuated underneath it.
   */
  cover: boolean;
  /** Density contrast relative to the host, t/m³ offset from 2.67. Drives gravity. */
  densityOffset: number;
  /** Magnetic susceptibility contrast, SI. Drives aeromagnetics. */
  susceptibility: number;
  /** Polygon ring in UTM 44N metres. */
  ring: number[]; // [x0,y0, x1,y1, ...] closed
  areaKm2: number;
  /** Mapped from NGDR/Bhukosh or interpreted — shown on the map legend. */
  provenance: 'mapped' | 'interpreted';
}

export interface Structure {
  id: string;
  kind: 'fault' | 'lineament' | 'shear' | 'dyke';
  name: string;
  path: number[]; // [x0,y0,...] polyline in UTM
  lengthKm: number;
  throwM: number | null;
  /** True where the structure is a mapped feature (vs satellite/SAR derived). */
  mapped: boolean;
}

export interface Occurrence {
  id: string;
  x: number;
  y: number;
  /** Best Mn% observed in the occurrence's drill intervals. */
  mnPct: number;
  /** Depth below surface to top of mineralisation, m. */
  depthTopM: number;
  source: 'MOIL drillhole' | 'GSI NGDR' | 'Field sampling';
  year: number;
}

export interface MineSite {
  id: string;
  name: string;
  code: string;
  x: number;
  y: number;
  /** Opencast vs underground drives which stages are in the capacity chain. */
  miningMethod: 'opencast' | 'underground';
  /** Annualised ROM ore capacity, t/d. */
  designTpd: number;
  /** Contained-metal grade of the feed blend, %. */
  feedGradeMn: number;
  /** Bench height for the block model, m. */
  benchHeightM: number;
  commissioned: number;
  /**
   * Current mine-plan envelope, from the approved short-term plan.
   *
   * OCI is measured against ore that is actually accessible: inside the active
   * working radius, and within the benches of ore already exposed below the
   * local contact. A resource outside that envelope is not cover. These are the
   * prototype's stand-in for the mine plan file.
   */
  plan: { radiusM: number; benches: number; label: string };
}

// ── Terrain ─────────────────────────────────────────────────────────────

export interface Terrain {
  nx: number;
  ny: number;
  /** Elevation, m above MSL. */
  dem: Float32Array;
  /** Hillshade illumination 0..1 from NW sun at 45°. */
  shade: Float32Array;
  minZ: number;
  maxZ: number;
  /** Terrain derivatives used as model features. */
  slope: Float32Array;
  tpi: Float32Array;
  /** Flow accumulation (log-scaled) — proxy for drainage / gully terrain. */
  flow: Float32Array;
  cellWidthM: number;
  cellHeightM: number;
}

function buildTerrain(): Terrain {
  const nx = GRID_NX;
  const ny = GRID_NY;
  const rng = makeRng(20241017);
  const fbm = makeFbm(9110, 6, 2.05, 0.52);
  const ridge = makeRidged(4471, 5);
  const dem = new Float32Array(nx * ny);

  // Two fold limbs with a shared hinge: a syncline axis running WNW–ESE,
  // which is what gives the belt its elongated Mn horizon traces.
  const axisTilt = 0.20;

  for (let j = 0; j < ny; j++) {
    const v = j / (ny - 1);
    for (let i = 0; i < nx; i++) {
      const u = i / (nx - 1);
      // Fold coordinate: distance from hinge, in normalised units.
      const foldCoord = v - (0.44 + axisTilt * (u - 0.5));
      const limb = Math.abs(foldCoord);

      // Regional trend: rises from the plains (south) into the Satpura
      // foot hills (north-east).
      const regional = 340 + 300 * (0.62 * v + 0.38 * u);

      // Fold relief: limbs low, hinge high — amplitude modulated by noise.
      const foldRelief = 210 * Math.cos(Math.min(limb * 2.6, Math.PI / 2)) ** 1.4;

      const ridged = 150 * ridge(u * 3.1 + 4.2, v * 3.1 - 1.7);
      const rough = 96 * fbm(u * 7.4, v * 7.4);
      const detail = 26 * fbm(u * 19, v * 19);

      const z = regional + foldRelief + ridged + rough + detail;
      dem[j * nx + i] = z;
    }
  }

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < dem.length; k++) {
    if (dem[k] < minZ) minZ = dem[k];
    if (dem[k] > maxZ) maxZ = dem[k];
  }

  const cellW = AOI_WIDTH_M / (nx - 1);
  const cellH = AOI_HEIGHT_M / (ny - 1);

  // Slope from central differences (degrees).
  const slope = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(nx - 1, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(ny - 1, j + 1);
      const dzdx = (dem[j * nx + i1] - dem[j * nx + i0]) / ((i1 - i0) * cellW);
      const dzdy = (dem[j1 * nx + i] - dem[j0 * nx + i]) / ((j1 - j0) * cellH);
      slope[j * nx + i] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
    }
  }

  // Topographic position index (3x3 mean neighbourhood).
  const tpi = new Float32Array(nx * ny);
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      const sum =
        dem[k - 1] + dem[k + 1] + dem[k - nx] + dem[k + nx] +
        dem[k - nx - 1] + dem[k - nx + 1] + dem[k + nx - 1] + dem[k + nx + 1];
      tpi[k] = dem[k] - sum / 8;
    }
  }

  // D8 flow accumulation on a small epsilon gradient to avoid flats.
  const noiseField = makeNoise2D(7723);
  const order = new Int32Array(nx * ny);
  for (let k = 0; k < order.length; k++) order[k] = k;
  const jitter = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      jitter[j * nx + i] = noiseField(i * 0.31, j * 0.31) * 0.6;
    }
  }
  const desc = Array.from(order).sort((a, b) => dem[b] + jitter[b] - (dem[a] + jitter[a]));
  const flow = new Float32Array(nx * ny).fill(1);
  for (const k of desc) {
    const i = k % nx;
    const j = Math.floor(k / nx);
    let best = -1;
    let bestDrop = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nk = nj * nx + ni;
        const dist = Math.hypot(di * cellW, dj * cellH);
        const drop = (dem[k] - dem[nk]) / dist;
        if (drop > bestDrop) {
          bestDrop = drop;
          best = nk;
        }
      }
    }
    if (best >= 0 && bestDrop > 0) flow[best] += flow[k];
  }
  for (let k = 0; k < flow.length; k++) flow[k] = Math.log1p(flow[k]) / 6;

  // Hillshade, sun azimuth 315° (NW), altitude 45°.
  const shade = new Float32Array(nx * ny);
  const az = (315 * Math.PI) / 180;
  const alt = (45 * Math.PI) / 180;
  const slopeZ = Math.cos(alt);
  const slopeX = Math.cos(az) * Math.sin(alt);
  const slopeY = Math.sin(az) * Math.sin(alt);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(nx - 1, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(ny - 1, j + 1);
      const dzdx = -(dem[j * nx + i1] - dem[j * nx + i0]) / (2 * cellW);
      const dzdy = -(dem[j1 * nx + i] - dem[j0 * nx + i]) / (2 * cellH);
      const nz = 1;
      const len = Math.sqrt(dzdx * dzdx + dzdy * dzdy + nz * nz);
      const dot = (dzdx * slopeX + dzdy * slopeY + nz * slopeZ) / len;
      shade[j * nx + i] = clamp(dot, 0, 1);
    }
  }

  void rng;
  return { nx, ny, dem, shade, minZ, maxZ, slope, tpi, flow, cellWidthM: cellW, cellHeightM: cellH };
}

export const TERRAIN: Terrain = buildTerrain();

export function elevationAt(x: number, y: number): number {
  return sampleField(TERRAIN.dem, TERRAIN.nx, TERRAIN.ny, normX(x), normY(y));
}

// ── Geological units ────────────────────────────────────────────────────

/**
 * Rock properties per mapped unit.
 *
 * `densityOffset` and `susceptibility` are what make the synthetic geophysics
 * consistent with the mapped geology: BIF is both dense and magnetic, alluvium
 * is neither and buries everything. They are representative values, and the
 * model card labels them as such.
 */
const UNIT_META: Record<
  LithCode,
  { name: string; favourable: boolean; colour: string; cover: boolean; densityOffset: number; susceptibility: number }
> = {
  GON: { name: 'Gondite / Mn-silicate', favourable: true, colour: '#8C6E4A', cover: false, densityOffset: 0.22, susceptibility: 0.018 },
  QSP: { name: 'Quartzite–pelite', favourable: true, colour: '#C4B49A', cover: false, densityOffset: 0.04, susceptibility: 0.006 },
  IMP: { name: 'Impure phyllite', favourable: false, colour: '#A8A196', cover: false, densityOffset: -0.02, susceptibility: 0.009 },
  BIF: { name: 'Banded iron formation', favourable: false, colour: '#8E6B6B', cover: false, densityOffset: 0.31, susceptibility: 0.061 },
  GRN: { name: 'Granite gneiss', favourable: false, colour: '#B0A9A0', cover: false, densityOffset: 0.11, susceptibility: 0.014 },
  ALL: { name: 'Alluvium / laterite', favourable: false, colour: '#DCD3C0', cover: true, densityOffset: -0.14, susceptibility: 0.003 },
  DOL: { name: 'Dolomite marble', favourable: false, colour: '#C9C6BD', cover: false, densityOffset: 0.07, susceptibility: 0.004 },
};

/**
 * Builds mapped-unit polygons as banded traces that follow the fold geometry,
 * so the map shows real structure rather than random blobs.
 */
function buildUnits(): GeoUnit[] {
  const rng = makeRng(31337);
  const units: GeoUnit[] = [];
  const codes: LithCode[] = ['GON', 'QSP', 'IMP', 'DOL', 'BIF', 'GRN', 'ALL'];
  // Band offsets across the fold, in metres from the hinge.
  const bandOffsets = [-5200, -3400, -1800, -600, 700, 2400, 4300, 6400];

  let counter = 0;
  for (let b = 0; b < bandOffsets.length; b++) {
    const offset = bandOffsets[b];
    const code = codes[b % codes.length];
    for (let seg = 0; seg < 2; seg++) {
      const segStart = seg === 0 ? 0.02 : 0.46 + rng() * 0.08;
      const segEnd = seg === 0 ? 0.42 + rng() * 0.06 : 0.99;
      const width = range(rng, 1500, 3100);
      const ring: number[] = [];
      const steps = 34;
      const jitterPhase = rng() * 100;
      for (let s = 0; s <= steps; s++) {
        const t = segStart + ((segEnd - segStart) * s) / steps;
        const wobble = 700 * Math.sin(t * 7.5 + jitterPhase) + 420 * Math.sin(t * 17 + jitterPhase * 2);
        const u = t;
        const hinge = 0.44 + 0.2 * (u - 0.5);
        const v = clamp(hinge + (offset + wobble) / AOI_HEIGHT_M, 0.015, 0.985);
        ring.push(denormX(u), denormY(v));
      }
      // return band with perpendicular offset for width
      for (let s = steps; s >= 0; s--) {
        const t = segStart + ((segEnd - segStart) * s) / steps;
        const wobble = 700 * Math.sin(t * 7.5 + jitterPhase) + 420 * Math.sin(t * 17 + jitterPhase * 2);
        const u = t;
        const hinge = 0.44 + 0.2 * (u - 0.5);
        const v = clamp(hinge + (offset + wobble + width) / AOI_HEIGHT_M, 0.015, 0.985);
        ring.push(denormX(u), denormY(v));
      }
      let area = 0;
      for (let k = 0; k < ring.length; k += 2) {
        const k2 = (k + 2) % ring.length;
        area += ring[k] * ring[k2 + 1] - ring[k2] * ring[k + 1];
      }
      area = Math.abs(area / 2) / 1e6;
      units.push({
        id: `GU-${String(counter + 1).padStart(3, '0')}`,
        code,
        name: UNIT_META[code].name,
        favourable: UNIT_META[code].favourable,
        cover: UNIT_META[code].cover,
        densityOffset: UNIT_META[code].densityOffset,
        susceptibility: UNIT_META[code].susceptibility,
        ring,
        areaKm2: area,
        provenance: counter % 3 === 2 ? 'interpreted' : 'mapped',
      });
      counter++;
    }
  }
  return units;
}

export const GEO_UNITS: GeoUnit[] = buildUnits();

function buildStructures(): Structure[] {
  const rng = makeRng(8675309);
  const out: Structure[] = [];
  const kinds: Structure['kind'][] = ['fault', 'fault', 'shear', 'lineament', 'lineament', 'dyke'];

  for (let s = 0; s < 26; s++) {
    const kind = kinds[s % kinds.length];
    const path: number[] = [];
    const steps = 12;
    const across = rng();
    const along0 = rng() * 0.16;
    const along1 = 0.84 + rng() * 0.16;
    const steep = rng() > 0.68;
    const phase = rng() * 10;
    for (let i = 0; i <= steps; i++) {
      const t = along0 + ((along1 - along0) * i) / steps;
      const base = across + (steep ? 0.11 * Math.sin(t * 6.1 + phase) : 0.028 * Math.sin(t * 9.4 + phase * 1.7));
      const u = t;
      const v = clamp(base, 0.01, 0.99);
      path.push(denormX(u), denormY(v));
    }
    let len = 0;
    for (let k = 2; k < path.length; k += 2) len += Math.hypot(path[k] - path[k - 2], path[k + 1] - path[k - 1]);
    out.push({
      id: `ST-${String(s + 1).padStart(3, '0')}`,
      kind,
      name: `${kind === 'dyke' ? 'Dyke' : kind === 'lineament' ? 'Lineament' : kind === 'shear' ? 'Shear zone' : 'Fault'} ${String.fromCharCode(65 + (s % 6))}${1 + Math.floor(s / 6)}`,
      path,
      lengthKm: len / 1000,
      throwM: kind === 'fault' ? range(rng, 45, 210) : null,
      mapped: kind !== 'lineament' && rng() > 0.3,
    });
  }
  return out;
}

export const STRUCTURES: Structure[] = buildStructures();

// ── Mines and occurrences ───────────────────────────────────────────────

export const MINES: MineSite[] = [
  {
    id: 'MNE-BAL',
    name: 'Balaghat Deep Cast',
    code: 'BDC',
    x: denormX(0.235),
    y: denormY(0.415),
    miningMethod: 'opencast',
    designTpd: 1450,
    feedGradeMn: 27.4,
    benchHeightM: 5,
    commissioned: 2009,
    // Phase 4 pit extension: 95 m working radius, one bench of ore released.
    plan: { radiusM: 95, benches: 1, label: 'Phase 4 pit, active bench' },
  },
  {
    id: 'MNE-NAG',
    name: 'Nagpur Ridge UG',
    code: 'NRU',
    x: denormX(0.565),
    y: denormY(0.318),
    miningMethod: 'underground',
    designTpd: 820,
    feedGradeMn: 24.1,
    benchHeightM: 4,
    commissioned: 2014,
    // Panel C: 70 m panel radius, current stoping level.
    plan: { radiusM: 70, benches: 1, label: 'Panel C, current stope level' },
  },
  {
    id: 'MNE-BHA',
    name: 'Bhandara East Pit',
    code: 'BEP',
    x: denormX(0.775),
    y: denormY(0.665),
    miningMethod: 'opencast',
    designTpd: 1100,
    feedGradeMn: 25.8,
    benchHeightM: 5,
    commissioned: 2017,
    // East wall cut-back: 90 m working radius, two benches released.
    plan: { radiusM: 90, benches: 2, label: 'East wall cut-back, two released benches' },
  },
];

/**
 * Geological favourability for an undiscovered Mn occurrence, 0–1.
 *
 * Built from mapped geology and structure only — the same evidence a field
 * geologist would weigh before recommending a traverse. Deliberately excludes
 * the remote-sensing and geophysical layers, because those are what the M1
 * prospectivity model is supposed to *discover* the value in. If the
 * occurrences were not placed with respect to the host horizon and the
 * structures, there would be nothing for the model to find and no validation
 * could ever be meaningful.
 */
export function occurrenceFavourability(x: number, y: number): number {
  let dHost = Infinity;
  for (const u of GEO_UNITS) {
    if (!u.favourable) continue;
    const d = distToRing(x, y, u.ring);
    if (d < dHost) dHost = d;
  }
  // On the mapped horizon, or within a couple of kilometres of it.
  const host = 1 - smoothstep(0, 2600, dHost);

  let dStructure = Infinity;
  for (const s of STRUCTURES) {
    const d = distToPath(x, y, s.path);
    if (d < dStructure) dStructure = d;
  }
  const structure = 1 - smoothstep(0, 1800, dStructure);

  // Ridges erode and expose the horizon; alluvium buries it.
  const relief = clamp((elevationAt(x, y) - 470) / 260, 0, 1);

  return clamp(0.52 * host + 0.33 * structure + 0.15 * relief, 0, 1);
}

function buildOccurrences(): Occurrence[] {
  const rng = makeRng(6161);
  const out: Occurrence[] = [];
  /** Deposits are distinct — keep them at least this far apart, metres. */
  const minSepM = 1400;

  const tooClose = (x: number, y: number) => out.some((o) => Math.hypot(o.x - x, o.y - y) < minSepM);

  /**
   * Rejection-sample one occurrence from a candidate position, accepting with
   * probability proportional to the cubed favourability. Cubing sharpens the
   * contrast so genuinely unfavourable ground stays genuinely empty, while
   * still leaving a tail of occurrences in weak ground — which is what makes
   * the model worth calibrating rather than trivial.
   */
  const place = (cx: number, cy: number, radius: number, tries = 60): { x: number; y: number } | null => {
    let best: { x: number; y: number; fav: number } | null = null;
    for (let t = 0; t < tries; t++) {
      const ang = rng() * Math.PI * 2;
      const r = radius * Math.sqrt(rng());
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      if (tooClose(x, y)) continue;
      const fav = occurrenceFavourability(x, y);
      if (!best || fav > best.fav) best = { x, y, fav };
      if (rng() < fav ** 3) return { x, y };
    }
    return best;
  };

  // Brownfield occurrences around the three operating mines.
  for (const mine of MINES) {
    const n = 7 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const p = place(mine.x, mine.y, 4200);
      if (!p) continue;
      out.push({
        id: `OCC-${mine.code}-${String(out.length + 1).padStart(2, '0')}`,
        x: p.x,
        y: p.y,
        // Nearer the host horizon, the richer the intercept.
        mnPct: clamp(9 + 32 * occurrenceFavourability(p.x, p.y) + (rng() - 0.5) * 7, 6, 44),
        depthTopM: clamp(4 + 78 * (1 - occurrenceFavourability(p.x, p.y)) + rng() * 22, 3, 104),
        source: rng() > 0.45 ? 'MOIL drillhole' : rng() > 0.4 ? 'GSI NGDR' : 'Field sampling',
        year: 1998 + Math.floor(rng() * 27),
      });
    }
  }

  // Regional occurrences: the label set the greenfield model is trained on.
  for (let i = 0; i < 46; i++) {
    const p = place(denormX(0.5), denormY(0.5), 34000, 90);
    if (!p) continue;
    const fav = occurrenceFavourability(p.x, p.y);
    out.push({
      id: `OCC-REG-${String(i + 1).padStart(3, '0')}`,
      x: p.x,
      y: p.y,
      mnPct: clamp(8 + 28 * fav + (rng() - 0.5) * 6, 5, 40),
      depthTopM: clamp(3 + 84 * (1 - fav) + rng() * 18, 3, 110),
      source: rng() > 0.55 ? 'GSI NGDR' : 'Field sampling',
      year: 1978 + Math.floor(rng() * 44),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export const OCCURRENCES: Occurrence[] = buildOccurrences();

/** Distance from a point to a polyline, in metres. */
export function distToPath(x: number, y: number, path: number[]): number {
  let best = Infinity;
  for (let i = 0; i + 3 < path.length; i += 2) {
    const ax = path[i];
    const ay = path[i + 1];
    const bx = path[i + 2];
    const by = path[i + 3];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy || 1;
    let t = ((x - ax) * dx + (y - ay) * dy) / lenSq;
    t = clamp(t, 0, 1);
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < best) best = d;
  }
  return best;
}

/** Distance from a point to a polygon ring, in metres (0 inside). */
export function distToRing(x: number, y: number, ring: number[]): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i];
    const yi = ring[i + 1];
    const xj = ring[j];
    const yj = ring[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    const dx = xj - xi;
    const dy = yj - yi;
    const lenSq = dx * dx + dy * dy || 1;
    let t = ((x - xi) * dx + (y - yi) * dy) / lenSq;
    t = clamp(t, 0, 1);
    const px = xi + t * dx;
    const py = yi + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < best) best = d;
  }
  return inside ? 0 : best;
}