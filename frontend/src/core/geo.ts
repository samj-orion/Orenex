import { clamp } from './noise';

/**
 * Georeferencing for the prototype surface.
 *
 * Everything the map draws lives in EPSG:32644 (WGS 84 / UTM zone 44N) metres —
 * the storage CRS declared in the architecture. The district AOI is the
 * Balaghat–Nagpur manganese belt: ~79.9°E, ~22.1°N.
 */
export const AOI = {
  crs: 'EPSG:32644',
  minE: 703000,
  minN: 7732000,
  maxE: 768000,
  maxN: 7790000,
};

export const AOI_WIDTH_M = AOI.maxE - AOI.minE; // 65 km
export const AOI_HEIGHT_M = AOI.maxN - AOI.minN; // 58 km

export interface Vec2 {
  x: number;
  y: number;
}

/** Grid normalisation: [0,1] across the AOI. */
export function normX(x: number): number {
  return clamp((x - AOI.minE) / AOI_WIDTH_M, 0, 1);
}
export function normY(y: number): number {
  return clamp((y - AOI.minN) / AOI_HEIGHT_M, 0, 1);
}
export function denormX(u: number): number {
  return AOI.minE + u * AOI_WIDTH_M;
}
export function denormY(v: number): number {
  return AOI.minN + v * AOI_HEIGHT_M;
}

/** UTM zone 44N -> WGS84 lon/lat (inverse transverse Mercator). */
export function utm44ToLonLat(easting: number, northing: number): [number, number] {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const lon0 = 81 * (Math.PI / 180);
  const x = easting - 500000;
  const y = northing;
  const M = y / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) +
    (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) +
    (151 * e1 ** 3 / 96) * Math.sin(6 * mu) +
    (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const C1 = ep2 * Math.cos(phi1) ** 2;
  const T1 = Math.tan(phi1) ** 2;
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
  const R1 = (a * (1 - e2)) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5;
  const D = x / (N1 * k0);
  const lat = phi1 - (N1 * Math.tan(phi1) / R1) * (D ** 2 / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(phi1);
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}
