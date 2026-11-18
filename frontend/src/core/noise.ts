import { makeRng } from './rng';

/**
 * Fractal value/gradient noise used to synthesise terrain, geophysical fields
 * and spatial covariates for the Balaghat–Nagpur belt prototype surface.
 */

const PERM_SIZE = 512;

function buildPermutation(seed: number): Uint8Array {
  const rng = makeRng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(PERM_SIZE);
  for (let i = 0; i < PERM_SIZE; i++) perm[i] = p[i & 255];
  return perm;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function grad2(hash: number, x: number, y: number): number {
  switch (hash & 7) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}

/** Classic 2D Perlin noise in [-1, 1]. */
export function makeNoise2D(seed: number): (x: number, y: number) => number {
  const perm = buildPermutation(seed);
  return (x: number, y: number) => {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[xi] + yi];
    const ab = perm[perm[xi] + yi + 1];
    const ba = perm[perm[xi + 1] + yi];
    const bb = perm[perm[xi + 1] + yi + 1];
    const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
    const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  };
}

/** Fractal Brownian motion — layered octaves for natural-looking terrain. */
export function makeFbm(seed: number, octaves = 5, lacunarity = 2.03, gain = 0.5) {
  const noise = makeNoise2D(seed);
  return (x: number, y: number): number => {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  };
}

/** Ridged multifractal — sharp crests, used for fold ridges / lineaments. */
export function makeRidged(seed: number, octaves = 5) {
  const noise = makeNoise2D(seed);
  return (x: number, y: number): number => {
    let amp = 0.55;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(noise(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= 0.52;
      freq *= 2.07;
    }
    return sum / norm;
  };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Bilinear sample over a Float32Array field with given width/height. */
export function sampleField(field: Float32Array, w: number, h: number, u: number, v: number): number {
  const x = clamp(u, 0, 0.999999) * (w - 1);
  const y = clamp(v, 0, 0.999999) * (h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = field[y0 * w + x0];
  const b = field[y0 * w + x1];
  const c = field[y1 * w + x0];
  const d = field[y1 * w + x1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}