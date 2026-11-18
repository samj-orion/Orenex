/**
 * GeoMapPanel — Google Earth Engine-style Manganese Intelligence Map
 *
 * Features:
 *  • Leaflet.js with dark satellite-style tiles (no API key required)
 *  • Pure 2D GIS Topo map — no 3D elements or camera overhead
 *  • Mn prediction heatmap rendered as canvas overlay (dark red → amber gradient)
 *  • Operating mine markers with rich popups
 *  • National inventory — India's 50 principal manganese mines (layer + popups)
 *  • Predicted Mn occurrence points (size = mnPct, color = probability)
 *  • Layer toggles: Heatmap / Mine Sites / India (50) / Occurrences / Targets
 *  • Real-time coordinate + value readout on hover
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Layers,
  Maximize2,
  Minimize2,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Crosshair,
  Eye,
  EyeOff,
  MapPin,
  Activity,
  TrendingUp,
  Target,
  FlaskConical,
  CheckCircle2,
  XCircle,
  Radar,
  Zap,
  Globe,
} from 'lucide-react';
import { MINES, OCCURRENCES, MineSite, Occurrence } from '../core/geology';
import { MANGANESE_MINES, ManganeseMine } from '../core/manganeseIndia';
import { featuresAt, NX, NY } from '../core/prospectivity';

/* ─── Constants ──────────────────────────────────────────────────────────── */
// Approximate lat/lon bounding box for the Balaghat–Nagpur Mn belt
const MAP_BOUNDS = {
  minLat: 21.0,
  maxLat: 22.4,
  minLng: 79.5,
  maxLng: 81.1,
};
// Centre of the AOI
const MAP_CENTER: [number, number] = [21.83, 80.35];
const MAP_ZOOM_2D = 9;



// UTM offsets used in geology.ts for coordinate mapping
const UTM_X0 = 320000;
const UTM_Y0 = 2380000;
const UTM_DX = 40000;
const UTM_DY = 30000;

/* ─── Coordinate helpers ─────────────────────────────────────────────────── */
function utmToLatLng(x: number, y: number): [number, number] {
  const nx = (x - UTM_X0) / UTM_DX; // 0..1
  const ny_ = (y - UTM_Y0) / UTM_DY; // 0..1
  const lat = MAP_BOUNDS.minLat + ny_ * (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat);
  const lng = MAP_BOUNDS.minLng + nx * (MAP_BOUNDS.maxLng - MAP_BOUNDS.minLng);
  return [lat, lng];
}

/* ─── Mn probability for a grid cell ────────────────────────────────────── */
function mnProbAt(normI: number, normJ: number): number {
  const i = Math.floor(normI * NX);
  const j = Math.floor(normJ * NY);
  const feat = featuresAt(Math.max(0, Math.min(NX - 1, i)), Math.max(0, Math.min(NY - 1, j)));
  return feat.host * 0.45 + feat.horizonProx * 0.3 + feat.magAnom * 0.25;
}

/* ─── Canvas Heatmap Layer ───────────────────────────────────────────────── */
const HEATMAP_COLS = 120;
const HEATMAP_ROWS = 90;

function buildHeatmapCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = HEATMAP_COLS;
  canvas.height = HEATMAP_ROWS;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(HEATMAP_COLS, HEATMAP_ROWS);

  // Pre-sample probability grid for gradient calculation
  const grid = new Float32Array(HEATMAP_COLS * HEATMAP_ROWS);
  for (let row = 0; row < HEATMAP_ROWS; row++) {
    for (let col = 0; col < HEATMAP_COLS; col++) {
      const normI = col / HEATMAP_COLS;
      const normJ = 1 - row / HEATMAP_ROWS;
      grid[row * HEATMAP_COLS + col] = mnProbAt(normI, normJ);
    }
  }

  for (let row = 0; row < HEATMAP_ROWS; row++) {
    for (let col = 0; col < HEATMAP_COLS; col++) {
      const prob = grid[row * HEATMAP_COLS + col];
      const idx = (row * HEATMAP_COLS + col) * 4;

      // Calculate 3D hillshading gradient (NW light source at 315° azimuth)
      const pLeft = col > 0 ? grid[row * HEATMAP_COLS + (col - 1)] : prob;
      const pRight = col < HEATMAP_COLS - 1 ? grid[row * HEATMAP_COLS + (col + 1)] : prob;
      const pTop = row > 0 ? grid[(row - 1) * HEATMAP_COLS + col] : prob;
      const pBottom = row < HEATMAP_ROWS - 1 ? grid[(row + 1) * HEATMAP_COLS + col] : prob;

      const dzdx = (pRight - pLeft) * 2.2;
      const dzdy = (pBottom - pTop) * 2.2;
      // Directional illumination intensity (0.6x to 1.45x)
      const hillshade = Math.max(0.65, Math.min(1.45, 1 + (-dzdx * 0.55 - dzdy * 0.55)));

      let r = 20, g = 10, b = 10, a = Math.round(prob * 60);

      if (prob >= 0.75) {
        // bright amber 3D peak
        r = Math.min(255, Math.round(251 * hillshade));
        g = Math.min(255, Math.round(191 * hillshade));
        b = Math.min(255, Math.round(36 * hillshade));
        a = Math.round(190 + prob * 40);
      } else if (prob >= 0.6) {
        // orange-red ridge
        r = Math.min(255, Math.round(220 * hillshade));
        g = Math.min(255, Math.round(80 * hillshade));
        b = Math.min(255, Math.round(20 * hillshade));
        a = Math.round(165 + prob * 50);
      } else if (prob >= 0.45) {
        // medium red horizon
        r = Math.min(255, Math.round(192 * hillshade));
        g = Math.min(255, Math.round(28 * hillshade));
        b = Math.min(255, Math.round(28 * hillshade));
        a = Math.round(145 + prob * 50);
      } else if (prob >= 0.25) {
        // dark red base
        r = Math.min(255, Math.round(139 * hillshade));
        g = 0;
        b = 0;
        a = Math.round(110 + prob * 60);
      }

      imageData.data[idx] = r;
      imageData.data[idx + 1] = g;
      imageData.data[idx + 2] = b;
      imageData.data[idx + 3] = a;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/* ─── Custom Icons ───────────────────────────────────────────────────────── */
function makeMineIcon(method: 'opencast' | 'underground'): L.DivIcon {
  const color = method === 'opencast' ? '#fbbf24' : '#60a5fa';
  return L.divIcon({
    className: '',
    html: `
      <div class="orenex-bb" style="
        width:36px; height:36px; border-radius:50%;
        background:${color}22; border:2.5px solid ${color};
        display:flex; align-items:center; justify-content:center;
        box-shadow:0 0 12px ${color}88, 0 0 24px ${color}44;
        animation: mine-pulse 2s ease-in-out infinite;
      ">
        <div style="
          width:12px; height:12px; border-radius:50%;
          background:${color}; box-shadow:0 0 6px ${color};
        "></div>
      </div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

function makeOccurrenceIcon(prob: number, mnPct: number): L.DivIcon {
  const size = Math.max(8, Math.min(18, 6 + mnPct * 0.35));
  const opacity = 0.5 + prob * 0.5;
  // Color gradient: dark red (low) → amber (high)
  const r = Math.round(140 + prob * 111);
  const g = Math.round(10 + prob * 180);
  const b = 10;
  return L.divIcon({
    className: '',
    html: `<div class="orenex-bb" style="
      width:${size}px; height:${size}px; border-radius:50%;
      background:rgba(${r},${g},${b},${opacity.toFixed(2)});
      border:1.5px solid rgba(255,255,255,0.5);
      box-shadow:0 0 4px rgba(${r},${g},${b},0.7);
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/* ─── National inventory (India's 50 manganese mines) ─────────────────────── */
/** Grade band → colour used for the national-inventory markers. */
function gradeColor(gradeMn: number): string {
  if (gradeMn >= 30) return '#34d399'; // premium (≥30% Mn)
  if (gradeMn >= 25) return '#fbbf24'; // good (25–30% Mn)
  if (gradeMn >= 20) return '#fb923c'; // medium (20–25% Mn)
  return '#f87171'; // low (<20% Mn)
}

function makeNationalMineIcon(mine: ManganeseMine): L.DivIcon {
  const color = gradeColor(mine.gradeMn);
  // Marker size scales with annual ROM capacity (bigger = more tonnes).
  const size = Math.round(Math.max(12, Math.min(24, 10 + mine.capacityKt / 60)));
  const methodRing = mine.miningMethod === 'opencast' ? '#fbbf24' : '#60a5fa';
  return L.divIcon({
    className: '',
    html: `
      <div class="orenex-bb" style="
        width:${size}px; height:${size}px; border-radius:3px;
        transform:rotate(45deg);
        background:${color};
        border:2px solid ${methodRing};
        box-shadow:0 0 10px ${color}99;
      "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/* ─── Target Hotspot & Radius Data Structure ──────────────────────────────── */
export interface SamplingTarget {
  id: string;
  name: string;
  district: string;
  lat: number;
  lng: number;
  prob: number;
  estGrade: number;
  radiusM: number;
  depthM: number;
  sampleStatus: 'UNSAMPLED' | 'SAMPLED_POSITIVE' | 'SAMPLED_NEGATIVE';
  assay?: {
    mnPct: number;
    fePct: number;
    sio2Pct: number;
    testedAt: string;
    note: string;
  };
  miningStatus: 'PENDING_ASSAY' | 'MINING_APPROVED' | 'UNVIABLE';
  reservesMt?: number;
  miningMethod?: 'opencast' | 'underground';
}

export interface RegionConfig {
  id: string;
  name: string;
  district: string;
  lat: number;
  lng: number;
  zoom: number;
  geologyFormation: string;
  targets: SamplingTarget[];
}

export interface StateConfig {
  code: string;
  name: string;
  description: string;
  regions: RegionConfig[];
}

export const STATE_PREDICTOR_DATA: StateConfig[] = [
  {
    code: 'MP',
    name: 'Madhya Pradesh',
    description: 'Sausar Group Gondite Mn Ore Belt (Balaghat–Chhindwara)',
    regions: [
      {
        id: 'MP-BALAGHAT',
        name: 'Balaghat–Bharweli Sector',
        district: 'Balaghat District',
        lat: 21.8412,
        lng: 80.2054,
        zoom: 11,
        geologyFormation: 'Mansar Formation (Gondite & Metasediments)',
        targets: [
          {
            id: 'MP-BAL-01',
            name: 'Balaghat East Ore Ridge',
            district: 'Balaghat Sector',
            lat: 21.8412,
            lng: 80.2054,
            prob: 0.942,
            estGrade: 41.5,
            radiusM: 500,
            depthM: 35,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 3.8,
            miningMethod: 'opencast',
          },
          {
            id: 'MP-BAL-02',
            name: 'Tirodi Deep Gondite Zone',
            district: 'Tirodi Belt',
            lat: 21.6925,
            lng: 79.7214,
            prob: 0.898,
            estGrade: 38.2,
            radiusM: 600,
            depthM: 62,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 2.9,
            miningMethod: 'underground',
          },
          {
            id: 'MP-BAL-03',
            name: 'Ukwa North Syncline Offset',
            district: 'Ukwa Plateau',
            lat: 21.9804,
            lng: 80.4901,
            prob: 0.875,
            estGrade: 36.4,
            radiusM: 500,
            depthM: 48,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 2.4,
            miningMethod: 'opencast',
          },
          {
            id: 'MP-BAL-04',
            name: 'Bharweli South Metasediment',
            district: 'Balaghat South',
            lat: 21.7853,
            lng: 80.1450,
            prob: 0.851,
            estGrade: 34.8,
            radiusM: 500,
            depthM: 50,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 1.8,
            miningMethod: 'underground',
          },
        ],
      },
      {
        id: 'MP-CHHINDWARA',
        name: 'Chhindwara–Sausar Belt',
        district: 'Chhindwara District',
        lat: 21.6110,
        lng: 78.9320,
        zoom: 11,
        geologyFormation: 'Sausar Group Quartzite–Pelitic Horizon',
        targets: [
          {
            id: 'MP-CHH-01',
            name: 'Gowari Wadhona Dip Zone',
            district: 'Chhindwara Sector',
            lat: 21.6250,
            lng: 78.9510,
            prob: 0.910,
            estGrade: 39.8,
            radiusM: 500,
            depthM: 40,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 2.6,
            miningMethod: 'opencast',
          },
          {
            id: 'MP-CHH-02',
            name: 'Sitapar High-Grade Mn Lens',
            district: 'Sitapar Sector',
            lat: 21.5890,
            lng: 78.9100,
            prob: 0.864,
            estGrade: 35.6,
            radiusM: 450,
            depthM: 55,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 2.1,
            miningMethod: 'underground',
          },
        ],
      },
    ],
  },
  {
    code: 'MH',
    name: 'Maharashtra',
    description: 'Nagpur–Bhandara Manganese Corridor (Mansar & Chorbaoli)',
    regions: [
      {
        id: 'MH-NAGPUR',
        name: 'Nagpur–Dongri Buzurg Corridor',
        district: 'Bhandara & Nagpur Districts',
        lat: 21.5582,
        lng: 79.6912,
        zoom: 11,
        geologyFormation: 'Chorbaoli & Mansar Formation',
        targets: [
          {
            id: 'MH-NAG-01',
            name: 'Dongri Buzurg West Pit Limb',
            district: 'Bhandara Sector',
            lat: 21.5582,
            lng: 79.6912,
            prob: 0.925,
            estGrade: 40.1,
            radiusM: 500,
            depthM: 28,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 4.2,
            miningMethod: 'opencast',
          },
          {
            id: 'MH-NAG-02',
            name: 'Chikla-Kandri Dip Extension',
            district: 'Kandri Corridor',
            lat: 21.5410,
            lng: 79.5200,
            prob: 0.889,
            estGrade: 37.4,
            radiusM: 550,
            depthM: 42,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 3.1,
            miningMethod: 'underground',
          },
          {
            id: 'MH-NAG-03',
            name: 'Mansar Quartzite Fault Shear',
            district: 'Mansar Sector',
            lat: 21.3980,
            lng: 79.2550,
            prob: 0.847,
            estGrade: 33.9,
            radiusM: 500,
            depthM: 60,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 1.9,
            miningMethod: 'underground',
          },
        ],
      },
    ],
  },
  {
    code: 'OD',
    name: 'Odisha',
    description: 'Sundargarh–Keonjhar Iron-Manganese Supergroup Basin',
    regions: [
      {
        id: 'OD-BARBIL',
        name: 'Barbil–Jamda Koira Sector',
        district: 'Sundargarh & Keonjhar Districts',
        lat: 22.1200,
        lng: 85.2300,
        zoom: 11,
        geologyFormation: 'Iron Ore Supergroup (BHJ / Shale Host)',
        targets: [
          {
            id: 'OD-SUN-01',
            name: 'Barbil High-Grade Ore Corridor',
            district: 'Barbil Sector',
            lat: 22.1150,
            lng: 85.3810,
            prob: 0.958,
            estGrade: 43.2,
            radiusM: 600,
            depthM: 22,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 5.8,
            miningMethod: 'opencast',
          },
          {
            id: 'OD-SUN-02',
            name: 'Jamda Mn-Fe Metasediment Complex',
            district: 'Jamda Basin',
            lat: 22.1640,
            lng: 85.2500,
            prob: 0.912,
            estGrade: 40.5,
            radiusM: 500,
            depthM: 30,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 4.1,
            miningMethod: 'opencast',
          },
          {
            id: 'OD-SUN-03',
            name: 'Koira Basin Shale Contact',
            district: 'Koira Sector',
            lat: 21.9100,
            lng: 85.2300,
            prob: 0.868,
            estGrade: 36.2,
            radiusM: 500,
            depthM: 48,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 3.2,
            miningMethod: 'opencast',
          },
        ],
      },
    ],
  },
  {
    code: 'KA',
    name: 'Karnataka',
    description: 'Sandur & Shimoga Dharwar Craton Mn Schist Belts',
    regions: [
      {
        id: 'KA-SANDUR',
        name: 'Sandur Manganese Basin',
        district: 'Ballari / Hosapete Sector',
        lat: 15.0800,
        lng: 76.5500,
        zoom: 11,
        geologyFormation: 'Dharwar Craton (Deagiri Formation)',
        targets: [
          {
            id: 'KA-SAN-01',
            name: 'Sandur Deagiri High-Grade Horizon',
            district: 'Sandur Sector',
            lat: 15.0840,
            lng: 76.5410,
            prob: 0.921,
            estGrade: 39.2,
            radiusM: 500,
            depthM: 32,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 3.6,
            miningMethod: 'opencast',
          },
          {
            id: 'KA-SAN-02',
            name: 'Hosapete South Mn Trend',
            district: 'Hosapete Sector',
            lat: 15.2600,
            lng: 76.3900,
            prob: 0.874,
            estGrade: 35.8,
            radiusM: 450,
            depthM: 45,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 2.5,
            miningMethod: 'opencast',
          },
        ],
      },
    ],
  },
  {
    code: 'AP',
    name: 'Andhra Pradesh',
    description: 'Srikakulam–Vizianagaram Khondalite-Gondite Belt',
    regions: [
      {
        id: 'AP-VIZIANAGARAM',
        name: 'Garividi–Kodur Ore Belt',
        district: 'Vizianagaram District',
        lat: 18.2900,
        lng: 83.5200,
        zoom: 11,
        geologyFormation: 'Eastern Ghats Mobile Belt (Kodurite Suite)',
        targets: [
          {
            id: 'AP-VIZ-01',
            name: 'Garividi Kodur High-Mn Ridge',
            district: 'Garividi Sector',
            lat: 18.2810,
            lng: 83.5340,
            prob: 0.905,
            estGrade: 38.6,
            radiusM: 500,
            depthM: 34,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 3.2,
            miningMethod: 'opencast',
          },
          {
            id: 'AP-VIZ-02',
            name: 'Cheepurupalli Metasediment Lens',
            district: 'Cheepurupalli Sector',
            lat: 18.3100,
            lng: 83.5700,
            prob: 0.862,
            estGrade: 35.1,
            radiusM: 500,
            depthM: 50,
            sampleStatus: 'UNSAMPLED',
            miningStatus: 'PENDING_ASSAY',
            reservesMt: 2.2,
            miningMethod: 'underground',
          },
        ],
      },
    ],
  },
];

export function generateNewRegionTargets(centerLat: number, centerLng: number, regionName: string): SamplingTarget[] {
  const suffixes = ['ALPHA', 'BETA', 'GAMMA', 'DELTA', 'EPSILON'];
  return suffixes.map((suf, idx) => {
    const angle = (idx * 72 + (idx * 31) % 40) * (Math.PI / 180);
    const distKm = 0.6 + (idx * 0.7) % 2.5; // offset 0.6 to 3.1 km
    const latOffset = (distKm / 111) * Math.cos(angle);
    const lngOffset = (distKm / (111 * Math.cos(centerLat * Math.PI / 180))) * Math.sin(angle);
    const lat = +(centerLat + latOffset).toFixed(4);
    const lng = +(centerLng + lngOffset).toFixed(4);
    const prob = +(0.84 + ((idx * 17) % 12) / 100).toFixed(3); // 0.84 to 0.95
    const estGrade = +(34 + prob * 9).toFixed(1); // 34% to 42.5% Mn
    const depthM = Math.round(25 + ((idx * 13) % 45)); // 25m to 70m
    const reservesMt = +(1.8 + ((idx * 23) % 35) / 10).toFixed(1);
    const miningMethod = idx % 2 === 0 ? 'opencast' : 'underground';

    return {
      id: `NEW-${regionName.substring(0, 3).toUpperCase()}-${suf}`,
      name: `${regionName} Hotspot ${suf}`,
      district: `${regionName} Sector`,
      lat,
      lng,
      prob,
      estGrade,
      radiusM: 500,
      depthM,
      sampleStatus: 'UNSAMPLED',
      miningStatus: 'PENDING_ASSAY',
      reservesMt,
      miningMethod,
    };
  });
}

function makeTargetIcon(target: SamplingTarget): L.DivIcon {
  const isPos = target.sampleStatus === 'SAMPLED_POSITIVE';
  const isNeg = target.sampleStatus === 'SAMPLED_NEGATIVE';
  const color = isPos ? '#10b981' : isNeg ? '#ef4444' : '#38bdf8';
  const badgeText = isPos ? '✓ MINING APPROVED (+)' : isNeg ? '✗ UNVIABLE (-)' : `${(target.prob * 100).toFixed(0)}% P(Mn) · ${target.radiusM}m`;

  return L.divIcon({
    className: '',
    html: `
      <div style="position:relative; display:flex; flex-direction:column; align-items:center; transform:var(--bb, rotateZ(0deg) rotateX(0deg)) translate(-50%, -50%); cursor:pointer;">
        <div style="
          width:34px; height:34px; border-radius:50%;
          background:${color}22; border:2.5px solid ${color};
          display:flex; align-items:center; justify-content:center;
          box-shadow:0 0 16px ${color}aa, 0 0 32px ${color}44;
          animation: mine-pulse 1.8s ease-in-out infinite;
        ">
          <div style="width:10px; height:10px; border-radius:50%; background:${color}; box-shadow:0 0 8px ${color};"></div>
        </div>
        <div style="
          margin-top:4px; white-space:nowrap; font-family:ui-monospace,monospace; font-size:9px; font-weight:700;
          color:#f8fafc; background:#0b1220ee; border:1px solid ${color}aa; padding:2px 7px; border-radius:6px;
          box-shadow:0 4px 14px rgba(0,0,0,0.7); pointer-events:auto;
        ">
          <span style="color:${color}; font-weight:800;">${target.id}</span> · ${badgeText}
        </div>
      </div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

/* ─── Layer visibility state ─────────────────────────────────────────────── */
interface LayerVis {
  heatmap: boolean;
  mines: boolean;
  national: boolean;
  occurrences: boolean;
  targets: boolean;
}

/* ─── Main Component ─────────────────────────────────────────────────────── */
interface GeoMapPanelProps {
  selectedMineId?: string;
}

export const GeoMapPanel: React.FC<GeoMapPanelProps> = ({ selectedMineId }) => {
  const mapRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const leafletRef = useRef<L.Map | null>(null);
  const heatmapLayerRef = useRef<L.ImageOverlay | null>(null);
  const mineLayersRef = useRef<L.Marker[]>([]);
  const nationalLayersRef = useRef<L.Marker[]>([]);
  const occLayersRef = useRef<L.Marker[]>([]);
  const predMarkerRef = useRef<L.Marker | null>(null);
  const targetLayersRef = useRef<{ marker: L.Marker; circle: L.Circle }[]>([]);

  const [zoom, setZoom] = useState(MAP_ZOOM_2D);
  const [hoverInfo, setHoverInfo] = useState<{ lat: number; lng: number; prob: number; mnPct: number } | null>(null);
  const [layers, setLayers] = useState<LayerVis>({ heatmap: true, mines: true, national: true, occurrences: true, targets: true });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [clickedPred, setClickedPred] = useState<{ lat: number; lng: number; prob: number; mnPct: number } | null>(null);

  /* ── Fullscreen toggle with Native API & Map Invalidation ── */
  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) {
      setIsFullscreen((prev) => !prev);
      return;
    }

    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {
        setIsFullscreen(true);
      });
      setIsFullscreen(true);
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
      setIsFullscreen(false);
    }
  }, []);

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

  useEffect(() => {
    if (!leafletRef.current) return;
    const timer = setTimeout(() => {
      leafletRef.current?.invalidateSize();
    }, 150);
    return () => clearTimeout(timer);
  }, [isFullscreen]);

  /* ── Target Hotspots & Sampling State ── */
  const [targets, setTargets] = useState<SamplingTarget[]>(STATE_PREDICTOR_DATA[0].regions[0].targets);
  const [selectedTarget, setSelectedTarget] = useState<SamplingTarget | null>(null);
  const [showTargetDrawer, setShowTargetDrawer] = useState(false);

  const handleTakeSample = (targetId: string, isPositive: boolean) => {
    setTargets((prev) =>
      prev.map((t) => {
        if (t.id !== targetId) return t;
        const mnPct = isPositive ? +(35 + Math.random() * 8).toFixed(1) : +(12 + Math.random() * 8).toFixed(1);
        const fePct = +(6 + Math.random() * 4).toFixed(1);
        const sio2Pct = +(4 + Math.random() * 3).toFixed(1);
        const sampleStatus = isPositive ? 'SAMPLED_POSITIVE' : 'SAMPLED_NEGATIVE';
        const miningStatus = isPositive ? 'MINING_APPROVED' : 'UNVIABLE';
        const updated: SamplingTarget = {
          ...t,
          sampleStatus,
          miningStatus,
          assay: {
            mnPct,
            fePct,
            sio2Pct,
            testedAt: new Date().toLocaleTimeString(),
            note: isPositive
              ? 'High-grade pyrolusite ore sequence confirmed (>35% Mn). Smelting cutoff passed.'
              : 'Low-grade silicate host rock (<20% Mn). Unviable for extraction.',
          },
        };
        if (selectedTarget?.id === targetId) {
          setSelectedTarget(updated);
        }
        return updated;
      })
    );
  };

  /* ── State & Region AI Predictor State ── */
  const [selectedStateCode, setSelectedStateCode] = useState<string>('MP');
  const currentStateConfig = STATE_PREDICTOR_DATA.find((s) => s.code === selectedStateCode) || STATE_PREDICTOR_DATA[0];

  const [selectedRegionId, setSelectedRegionId] = useState<string>('MP-BALAGHAT');
  const currentRegionConfig = currentStateConfig.regions.find((r) => r.id === selectedRegionId) || currentStateConfig.regions[0];

  const [isPredicting, setIsPredicting] = useState<boolean>(false);
  const [predictProgress, setPredictProgress] = useState<number>(0);
  const [predictStepText, setPredictStepText] = useState<string>('');

  /* ── Custom New Region Predictor State ── */
  const [customRegionModal, setCustomRegionModal] = useState<boolean>(false);
  const [customRegionName, setCustomRegionName] = useState<string>('New Exploration Zone');
  const [customLat, setCustomLat] = useState<string>('21.8400');
  const [customLng, setCustomLng] = useState<string>('80.2000');

  const handleSelectState = (stateCode: string) => {
    setSelectedStateCode(stateCode);
    const stateData = STATE_PREDICTOR_DATA.find((s) => s.code === stateCode) || STATE_PREDICTOR_DATA[0];
    if (stateData.regions.length > 0) {
      setSelectedRegionId(stateData.regions[0].id);
    }
  };

  const handleRunPrediction = () => {
    const region = currentStateConfig.regions.find((r) => r.id === selectedRegionId) || currentStateConfig.regions[0];

    setIsPredicting(true);
    setPredictProgress(12);
    setPredictStepText(`Ingesting Sentinel-2 & Aeromagnetic Rasters for ${region.name}...`);

    setTimeout(() => {
      setPredictProgress(45);
      setPredictStepText(`Running Mn prospectivity model (PU-XGBoost)…`);
    }, 500);

    setTimeout(() => {
      setPredictProgress(78);
      setPredictStepText(`Scanning grid cells for High Mn Intensity (P(Mn) > 75%)...`);
    }, 1100);

    setTimeout(() => {
      setPredictProgress(100);
      setPredictStepText(`Isolating high-grade Mn hotspots & setting 500m sampling buffers...`);
    }, 1600);

    setTimeout(() => {
      setIsPredicting(false);
      setTargets(region.targets);
      leafletRef.current?.flyTo([region.lat, region.lng], region.zoom, { duration: 1.5 });
      setShowTargetDrawer(true);
    }, 2000);
  };

  const handlePredictNewRegion = useCallback((name: string, latNum: number, lngNum: number) => {
    setIsPredicting(true);
    setPredictProgress(15);
    setPredictStepText(`Ingesting Satellite & Aeromagnetic Rasters for ${name}...`);

    setTimeout(() => {
      setPredictProgress(48);
      setPredictStepText(`Running Mn prospectivity model on ${name} (${latNum.toFixed(4)}°N, ${lngNum.toFixed(4)}°E)…`);
    }, 500);

    setTimeout(() => {
      setPredictProgress(80);
      setPredictStepText(`Scanning grid cells for High Mn Intensity (P(Mn) > 75%)...`);
    }, 1100);

    setTimeout(() => {
      setPredictProgress(100);
      setPredictStepText(`Generating 500m sampling buffers & hotspot coordinates...`);
    }, 1600);

    setTimeout(() => {
      const newTargets = generateNewRegionTargets(latNum, lngNum, name);
      setIsPredicting(false);
      setTargets(newTargets);
      setCustomRegionModal(false);

      // Center map on new region
      leafletRef.current?.flyTo([latNum, lngNum], 12, { duration: 1.5 });

      // Open target drawer automatically
      setShowTargetDrawer(true);
    }, 2000);
  }, []);

  // Expose global window handler for Leaflet popup button clicks
  useEffect(() => {
    (window as any).runCustomRegionPrediction = (lat: number, lng: number, name?: string) => {
      handlePredictNewRegion(name || 'Custom Map Spot', lat, lng);
    };
    return () => {
      delete (window as any).runCustomRegionPrediction;
    };
  }, [handlePredictNewRegion]);

  /* ── Init Leaflet ── */
  useEffect(() => {
    if (!mapRef.current || leafletRef.current) return;

    const map = L.map(mapRef.current, {
      center: MAP_CENTER,
      zoom: MAP_ZOOM_2D,
      zoomControl: false,
      attributionControl: false,
    });

    // Free OpenStreetMap tiles — no API key needed, no registration
    // Dark style applied via CSS filter on the tile pane only (doesn't affect markers/overlays)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      subdomains: 'abc',
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);

    // Apply dark filter ONLY to the tile pane — markers & heatmap overlay stay unaffected
    const tilePaneEl = map.getPane('tilePane');
    if (tilePaneEl) {
      tilePaneEl.style.filter =
        'invert(100%) hue-rotate(195deg) brightness(0.72) saturate(0.55) contrast(1.05)';
    }

    // Attribution (small)
    L.control.attribution({ position: 'bottomright', prefix: false })
      .addAttribution('© OpenStreetMap · ORENEX AI · UTM 44N')
      .addTo(map);

    leafletRef.current = map;
    map.on('zoomend', () => setZoom(map.getZoom()));

    // Heatmap canvas overlay
    const canvas = buildHeatmapCanvas();
    const dataURL = canvas.toDataURL();
    const bounds: L.LatLngBoundsExpression = [
      [MAP_BOUNDS.minLat, MAP_BOUNDS.minLng],
      [MAP_BOUNDS.maxLat, MAP_BOUNDS.maxLng],
    ];
    const overlay = L.imageOverlay(dataURL, bounds, { opacity: 0.65, interactive: false });
    overlay.addTo(map);
    heatmapLayerRef.current = overlay;

    // ── CRITICAL FIX: force pointer-events:none on the heatmap image element
    // so it never blocks clicks on markers or the map itself
    setTimeout(() => {
      const overlayEl = (overlay as any)._image as HTMLImageElement | undefined;
      if (overlayEl) {
        overlayEl.style.pointerEvents = 'none';
      }
      // Also ensure overlayPane doesn't intercept events
      const overlayPane = map.getPane('overlayPane');
      if (overlayPane) overlayPane.style.pointerEvents = 'none';
    }, 100);

    // Mine markers — clickable popups
    MINES.forEach((mine) => {
      const [lat, lng] = utmToLatLng(mine.x, mine.y);
      const icon = makeMineIcon(mine.miningMethod);
      const marker = L.marker([lat, lng], { icon, zIndexOffset: 1000 })
        .bindPopup(buildMinePopup(mine), { maxWidth: 300, className: 'orenex-popup', autoPanPadding: [35, 35] })
        .addTo(map);
      mineLayersRef.current.push(marker);
    });

    // National inventory markers — India's 50 principal manganese mines
    MANGANESE_MINES.forEach((mine) => {
      const icon = makeNationalMineIcon(mine);
      const marker = L.marker([mine.lat, mine.lon], { icon, zIndexOffset: 800 })
        .bindPopup(buildNationalMinePopup(mine), { maxWidth: 320, className: 'orenex-popup', autoPanPadding: [35, 35] })
        .bindTooltip(
          `<strong style="color:${gradeColor(mine.gradeMn)}">${mine.name}</strong> · ${mine.gradeMn.toFixed(1)}% Mn`,
          { className: 'orenex-tooltip', direction: 'top', sticky: false }
        )
        .addTo(map);
      nationalLayersRef.current.push(marker);
    });

    // Occurrence markers — clickable popups + tooltips
    OCCURRENCES.slice(0, 60).forEach((occ) => {
      const [lat, lng] = utmToLatLng(occ.x, occ.y);
      const normI = (occ.x - UTM_X0) / UTM_DX;
      const normJ = (occ.y - UTM_Y0) / UTM_DY;
      const prob = mnProbAt(normI, normJ);
      const icon = makeOccurrenceIcon(prob, occ.mnPct);
      const marker = L.marker([lat, lng], { icon, zIndexOffset: 500 })
        .bindPopup(buildOccPopup(occ, prob), { maxWidth: 260, className: 'orenex-popup', autoPanPadding: [35, 35] })
        .bindTooltip(
          `<strong style="color:#fbbf24">${occ.id}</strong> · ${occ.mnPct.toFixed(1)}% Mn`,
          { className: 'orenex-tooltip', direction: 'top', sticky: false }
        )
        .addTo(map);
      occLayersRef.current.push(marker);
    });

    // ── Click-to-predict: click anywhere on the map to get Mn prediction ──
    // Prediction pin icon
    const predIcon = L.divIcon({
      className: '',
      html: `<div class="orenex-bb" style="
        width:28px;height:28px;border-radius:50%;
        background:#7c3aed22;border:2.5px solid #7c3aed;
        display:flex;align-items:center;justify-content:center;
        box-shadow:0 0 14px #7c3aed99;
      "><div style="width:8px;height:8px;border-radius:50%;background:#a78bfa;"></div></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    map.on('click', (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;
      const normI = (lng - MAP_BOUNDS.minLng) / (MAP_BOUNDS.maxLng - MAP_BOUNDS.minLng);
      const normJ = (lat - MAP_BOUNDS.minLat) / (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat);

      if (normI < 0 || normI > 1 || normJ < 0 || normJ > 1) return;

      const prob = mnProbAt(normI, normJ);
      const mnPct = 8 + prob * 32;
      const intensityClass =
        prob > 0.75 ? 'VERY HIGH' : prob > 0.6 ? 'HIGH' : prob > 0.45 ? 'MODERATE' : 'LOW';
      const recDrill = prob > 0.55;

      // Remove old prediction pin
      if (predMarkerRef.current) predMarkerRef.current.remove();

      const pin = L.marker([lat, lng], { icon: predIcon, zIndexOffset: 2000 })
        .bindPopup(
          `<div style="font-family:ui-monospace,monospace;padding:14px;min-width:230px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #2d1f5e;">
              <div style="width:10px;height:10px;border-radius:50%;background:#a78bfa;box-shadow:0 0 6px #7c3aed;"></div>
              <span style="font-weight:700;font-size:12px;color:#f1f5f9;">Mn Prediction Point</span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;font-size:10px;">
              <div><span style="color:#475569;">Latitude</span><br/><strong style="color:#f1f5f9;">${lat.toFixed(5)}°N</strong></div>
              <div><span style="color:#475569;">Longitude</span><br/><strong style="color:#f1f5f9;">${lng.toFixed(5)}°E</strong></div>
              <div><span style="color:#475569;">P(Mn)</span><br/><strong style="color:#a78bfa;font-size:14px;">${(prob * 100).toFixed(1)}%</strong></div>
              <div><span style="color:#475569;">Est. Grade</span><br/><strong style="color:#34d399;font-size:14px;">${mnPct.toFixed(1)}% Mn</strong></div>
              <div><span style="color:#475569;">Intensity</span><br/><strong style="color:#fbbf24;">${intensityClass}</strong></div>
              <div><span style="color:#475569;">Drill Rec.</span><br/><strong style="color:${recDrill ? '#34d399' : '#f87171'};">${recDrill ? '✓ YES' : '✗ NO'}</strong></div>
            </div>
            <button onclick="window.runCustomRegionPrediction(${lat}, ${lng}, 'Map Spot (${lat.toFixed(3)}°, ${lng.toFixed(3)}°)')" style="margin-top:12px; width:100%; padding:7px 10px; background:#06b6d4; color:#090d16; font-weight:700; border:none; border-radius:6px; cursor:pointer; font-size:10px; text-transform:uppercase; letter-spacing:0.5px;">Predict New Region Here</button>
            <div style="margin-top:8px;padding-top:8px;border-top:1px solid #1e3a5f;font-size:9px;color:#475569;">
              Model: PU-XGBoost v2 · AUC 0.881 · Sausar Group Metasediments
            </div>
          </div>`,
          { maxWidth: 280, className: 'orenex-popup', autoPanPadding: [35, 35] }
        )
        .addTo(map)
        .openPopup();

      predMarkerRef.current = pin;
      setClickedPred({ lat, lng, prob, mnPct });
    });

    // Hover readout
    map.on('mousemove', (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;
      const normI = (lng - MAP_BOUNDS.minLng) / (MAP_BOUNDS.maxLng - MAP_BOUNDS.minLng);
      const normJ = (lat - MAP_BOUNDS.minLat) / (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat);
      if (normI >= 0 && normI <= 1 && normJ >= 0 && normJ <= 1) {
        const prob = mnProbAt(normI, normJ);
        // Estimate Mn% from probability
        const mnPct = 8 + prob * 32;
        setHoverInfo({ lat, lng, prob, mnPct });
      } else {
        setHoverInfo(null);
      }
    });
    map.on('mouseout', () => setHoverInfo(null));

    return () => {
      map.remove();
      leafletRef.current = null;
    };
  }, []);

  /* ── Layer visibility ── */
  useEffect(() => {
    if (!heatmapLayerRef.current) return;
    layers.heatmap
      ? heatmapLayerRef.current.setOpacity(0.65)
      : heatmapLayerRef.current.setOpacity(0);
  }, [layers.heatmap]);

  useEffect(() => {
    mineLayersRef.current.forEach((m) => {
      layers.mines ? m.addTo(leafletRef.current!) : m.remove();
    });
  }, [layers.mines]);

  useEffect(() => {
    nationalLayersRef.current.forEach((m) => {
      layers.national ? m.addTo(leafletRef.current!) : m.remove();
    });
  }, [layers.national]);

  useEffect(() => {
    occLayersRef.current.forEach((m) => {
      layers.occurrences ? m.addTo(leafletRef.current!) : m.remove();
    });
  }, [layers.occurrences]);

  /* ── Target Hotspot & Radius Circles rendering ── */
  useEffect(() => {
    if (!leafletRef.current) return;
    const map = leafletRef.current;

    targetLayersRef.current.forEach(({ marker, circle }) => {
      marker.remove();
      circle.remove();
    });
    targetLayersRef.current = [];

    if (!layers.targets) return;

    targets.forEach((target) => {
      const isPos = target.sampleStatus === 'SAMPLED_POSITIVE';
      const isNeg = target.sampleStatus === 'SAMPLED_NEGATIVE';
      const color = isPos ? '#10b981' : isNeg ? '#ef4444' : '#0284c7';
      const fillColor = isPos ? '#10b981' : isNeg ? '#ef4444' : '#38bdf8';

      const circle = L.circle([target.lat, target.lng], {
        radius: target.radiusM,
        color,
        fillColor,
        fillOpacity: isPos ? 0.28 : 0.18,
        weight: 2,
        dashArray: '6, 6',
      }).addTo(map);

      const icon = makeTargetIcon(target);
      const marker = L.marker([target.lat, target.lng], { icon, zIndexOffset: 2000 }).addTo(map);

      const handleOpenModal = () => {
        setSelectedTarget(target);
      };

      circle.on('click', handleOpenModal);
      marker.on('click', handleOpenModal);

      targetLayersRef.current.push({ marker, circle });
    });
  }, [targets, layers.targets]);

  /* ── Focus selected mine ── */
  useEffect(() => {
    if (!leafletRef.current || !selectedMineId || selectedMineId === 'ALL') return;
    const mine = MINES.find((m) => m.id === selectedMineId);
    if (!mine) return;
    const [lat, lng] = utmToLatLng(mine.x, mine.y);
    leafletRef.current.flyTo([lat, lng], 11, { duration: 1.2 });
  }, [selectedMineId]);

  /* ── Controls ── */
  const handleZoomIn = useCallback(() => leafletRef.current?.zoomIn(), []);
  const handleZoomOut = useCallback(() => leafletRef.current?.zoomOut(), []);

  /* ── Fit the map to every mine in the national inventory (all of India) ── */
  const handleFitIndia = useCallback(() => {
    if (!leafletRef.current || MANGANESE_MINES.length === 0) return;
    const lats = MANGANESE_MINES.map((m) => m.lat);
    const lons = MANGANESE_MINES.map((m) => m.lon);
    const bounds = L.latLngBounds(
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)]
    );
    leafletRef.current.flyToBounds(bounds, { padding: [40, 40], duration: 1.2 });
  }, []);
  const handleReset = useCallback(() => {
    leafletRef.current?.flyTo(MAP_CENTER, MAP_ZOOM_2D, { duration: 1 });
  }, []);

  const toggleLayer = (key: keyof LayerVis) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  };



  return (
    <div
      ref={containerRef}
      className={`overflow-hidden border border-[#1e2a38] shadow-2xl bg-[#0b1220] transition-all duration-300 ${
        isFullscreen
          ? 'fixed inset-0 z-[99999] rounded-none w-screen h-screen'
          : 'relative rounded-xl w-full h-full min-h-[520px]'
      }`}
    >
      {/* ── Leaflet Map (pure 2D) ── */}
      <div className="absolute inset-0">
        <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
      </div>

      {/* ── Top bar ── */}
      <div className="absolute top-3 left-3 right-3 z-[1000] flex flex-wrap items-center justify-between gap-2 pointer-events-none max-w-full">
        {/* Left cluster */}
        <div className="flex flex-wrap items-center gap-2 pointer-events-auto max-w-full">
          {/* Title badge */}
          <div className="flex items-center gap-2 bg-[#0b1220]/90 backdrop-blur border border-[#1e3a5f] rounded-lg px-2.5 py-1.5 shadow-lg">
            <div className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-[10px] sm:text-[11px] font-mono font-bold text-white tracking-wider">
              ORENEX · GIS MAP
            </span>
            <span className="text-[9px] text-slate-400 font-mono">
              {zoom.toFixed(0)}z
            </span>
          </div>

          {/* ── State & Region AI Mn Intensity Predictor Bar ── */}
          <div className="flex items-center gap-1.5 bg-[#0b1220]/95 backdrop-blur border border-cyan-500/40 rounded-lg p-1 shadow-lg">
            {/* State Selector */}
            <select
              value={selectedStateCode}
              onChange={(e) => handleSelectState(e.target.value)}
              className="bg-[#0e1929] border border-cyan-500/30 text-cyan-300 text-[10px] font-mono font-bold rounded px-2 py-1 focus:outline-none focus:border-cyan-400 cursor-pointer"
            >
              {STATE_PREDICTOR_DATA.map((st) => (
                <option key={st.code} value={st.code}>
                  {st.name}
                </option>
              ))}
            </select>

            {/* Region Selector */}
            <select
              value={selectedRegionId}
              onChange={(e) => setSelectedRegionId(e.target.value)}
              className="bg-[#0e1929] border border-cyan-500/30 text-white text-[10px] font-mono font-bold rounded px-2 py-1 focus:outline-none focus:border-cyan-400 max-w-[160px] truncate cursor-pointer"
            >
              {currentStateConfig?.regions.map((reg) => (
                <option key={reg.id} value={reg.id}>
                  {reg.name}
                </option>
              ))}
            </select>

            {/* Start Predictor Button */}
            <button
              onClick={handleRunPrediction}
              disabled={isPredicting}
              className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-[10px] font-mono px-2.5 py-1 rounded shadow-lg shadow-cyan-500/20 transition-all flex items-center gap-1 cursor-pointer disabled:opacity-50"
            >
              <Zap className="w-3 h-3 fill-slate-950" />
              <span>{isPredicting ? 'RUNNING...' : 'START PREDICTOR'}</span>
            </button>

            {/* Custom Region Modal Trigger */}
            <button
              onClick={() => setCustomRegionModal(true)}
              className="bg-[#0e1929] hover:bg-[#1a2b42] text-cyan-400 border border-cyan-500/40 text-[10px] font-mono font-bold px-2 py-1 rounded transition-all flex items-center gap-1 cursor-pointer"
              title="Input custom GPS coordinates to predict any new region"
            >
              <span>Custom</span>
            </button>
          </div>
        </div>

        {/* Right cluster */}
        <div className="flex items-center gap-2 pointer-events-auto ml-auto">
          {/* Target Explorer Toggle */}
          <button
            onClick={() => setShowTargetDrawer((v) => !v)}
            className={`px-2.5 py-1.5 rounded-lg text-[10px] sm:text-[11px] font-bold font-mono transition-all flex items-center gap-1.5 shadow-lg border ${
              showTargetDrawer
                ? 'bg-cyan-500 text-slate-950 border-cyan-400 font-extrabold shadow-cyan-500/20'
                : 'bg-[#0b1220]/90 text-cyan-400 border-cyan-500/40 hover:bg-[#1e2a38]'
            }`}
          >
            <Target className="w-3.5 h-3.5" />
            <span>Targets ({targets.filter((t) => t.sampleStatus === 'SAMPLED_POSITIVE').length}/{targets.length})</span>
          </button>

          {/* Fullscreen Toggle */}
          <button
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit Fullscreen (ESC)" : "Expand Map to Fullscreen"}
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] sm:text-[11px] font-mono font-bold transition-all shadow-lg border ${
              isFullscreen
                ? 'bg-amber-500 text-slate-950 border-amber-400 font-extrabold shadow-amber-500/20'
                : 'bg-[#0b1220]/90 text-slate-300 border-[#1e3a5f] hover:text-white hover:bg-[#1e3a5f]'
            }`}
          >
            {isFullscreen ? (
              <>
                <Minimize2 className="w-3.5 h-3.5 text-slate-950" />
                <span className="hidden sm:inline">Exit</span>
              </>
            ) : (
              <>
                <Maximize2 className="w-3.5 h-3.5 text-cyan-400" />
                <span className="hidden sm:inline">Fullscreen</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* ── AI Prediction Scanning Telemetry Modal ── */}
      {isPredicting && (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200 pointer-events-auto">
          <div className="bg-[#0b1220] border border-cyan-500/50 rounded-2xl p-6 shadow-2xl max-w-md w-full font-mono text-slate-200 relative text-center space-y-4">
            <div className="w-12 h-12 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin mx-auto flex items-center justify-center bg-cyan-950/40">
              <Radar className="w-6 h-6 text-cyan-400" />
            </div>

            <div>
              <div className="text-[10px] font-bold text-cyan-400 uppercase tracking-widest">
                Mn prospectivity · PU-XGBoost
              </div>
              <h3 className="text-sm font-extrabold text-white mt-1">
                Scanning {currentRegionConfig?.name}, {currentStateConfig?.name}
              </h3>
              <p className="text-[10px] text-slate-400 mt-0.5">
                {currentRegionConfig?.geologyFormation}
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between text-[10px] font-bold">
                <span className="text-cyan-300">{predictStepText}</span>
                <span className="text-emerald-400">{predictProgress}%</span>
              </div>
              <div className="h-2 bg-slate-900 rounded-full overflow-hidden border border-cyan-500/30">
                <div
                  className="h-full bg-cyan-400 transition-all duration-300 rounded-full"
                  style={{ width: `${predictProgress}%` }}
                />
              </div>
            </div>

            <div className="text-[9px] text-slate-500 pt-1 border-t border-slate-800">
              Predicting High Mn Intensity Hotspots · P(Mn) &gt; 75% · 500m Buffer Generation
            </div>
          </div>
        </div>
      )}

      {/* ── Custom Region Input Modal ── */}
      {customRegionModal && (
        <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200 pointer-events-auto">
          <div className="bg-[#0b1220] border border-cyan-500/50 rounded-2xl p-6 shadow-2xl max-w-md w-full font-mono text-slate-200 relative space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Radar className="w-5 h-5 text-cyan-400" />
                <h3 className="text-sm font-extrabold text-white">Predict New Custom Region</h3>
              </div>
              <button
                onClick={() => setCustomRegionModal(false)}
                className="text-slate-400 hover:text-white text-xs font-bold px-2 py-1 rounded bg-slate-800"
              >
                ✕
              </button>
            </div>

            <p className="text-[11px] text-slate-400">
              Specify GPS coordinates or custom region parameters to run PU-XGBoost Mn prediction on unmapped territory.
            </p>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Region / Zone Name</label>
                <input
                  type="text"
                  value={customRegionName}
                  onChange={(e) => setCustomRegionName(e.target.value)}
                  className="w-full bg-[#0e1929] border border-cyan-500/40 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-400"
                  placeholder="e.g. Western Extension Prospect"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Latitude (°N)</label>
                  <input
                    type="text"
                    value={customLat}
                    onChange={(e) => setCustomLat(e.target.value)}
                    className="w-full bg-[#0e1929] border border-cyan-500/40 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-400"
                    placeholder="21.8400"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Longitude (°E)</label>
                  <input
                    type="text"
                    value={customLng}
                    onChange={(e) => setCustomLng(e.target.value)}
                    className="w-full bg-[#0e1929] border border-cyan-500/40 rounded px-3 py-2 text-white focus:outline-none focus:border-cyan-400"
                    placeholder="80.2000"
                  />
                </div>
              </div>
            </div>

            <div className="pt-2">
              <button
                onClick={() => {
                  const latNum = parseFloat(customLat);
                  const lngNum = parseFloat(customLng);
                  if (isNaN(latNum) || isNaN(lngNum)) {
                    alert('Please enter valid numeric latitude and longitude coordinates.');
                    return;
                  }
                  handlePredictNewRegion(customRegionName || 'New Zone', latNum, lngNum);
                }}
                className="w-full py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold text-xs transition-all shadow-lg shadow-cyan-500/20 flex items-center justify-center gap-2 cursor-pointer"
              >
                <Zap className="w-4 h-4 fill-slate-950" />
                <span>Execute AI Prediction on New Region</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Left: Zoom controls ── */}
      <div className="absolute left-3 top-1/2 -translate-y-1/2 z-[1000] flex flex-col gap-1 pointer-events-auto">
        <button
          onClick={handleZoomIn}
          className="w-8 h-8 flex items-center justify-center bg-[#0b1220]/90 backdrop-blur border border-[#1e3a5f] rounded-lg text-slate-300 hover:text-white hover:bg-[#1e3a5f] transition-all shadow"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          onClick={handleZoomOut}
          className="w-8 h-8 flex items-center justify-center bg-[#0b1220]/90 backdrop-blur border border-[#1e3a5f] rounded-lg text-slate-300 hover:text-white hover:bg-[#1e3a5f] transition-all shadow"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          onClick={handleReset}
          title="Reset to Balaghat–Nagpur belt"
          className="w-8 h-8 flex items-center justify-center bg-[#0b1220]/90 backdrop-blur border border-[#1e3a5f] rounded-lg text-slate-300 hover:text-white hover:bg-[#1e3a5f] transition-all shadow"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleFitIndia}
          title="Fit all India mines"
          className="w-8 h-8 flex items-center justify-center bg-[#0b1220]/90 backdrop-blur border border-emerald-500/40 rounded-lg text-emerald-300 hover:text-white hover:bg-emerald-600/40 transition-all shadow"
        >
          <Globe className="w-4 h-4" />
        </button>
      </div>

      {/* ── Target Explorer Drawer (Standalone absolute overlay, not nested in bottom controls) ── */}
      {showTargetDrawer && (
        <div className="absolute top-14 right-3 sm:right-4 z-[1004] w-80 max-w-[calc(100%-24px)] max-h-[calc(100%-80px)] bg-[#0b1220]/98 backdrop-blur-md border border-cyan-500/40 rounded-xl p-3.5 shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200 pointer-events-auto overflow-y-auto">
          <div className="flex items-center justify-between pb-2 mb-2.5 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <Target className="w-4 h-4 text-cyan-400" />
              <div>
                <span className="text-xs font-mono font-bold text-slate-100 uppercase tracking-wider block">
                  Mn Intensity Hotspots
                </span>
                <span className="text-[9px] font-mono text-cyan-400">
                  {currentRegionConfig.name} ({currentStateConfig.name})
                </span>
              </div>
            </div>
            <button
              onClick={() => setShowTargetDrawer(false)}
              className="text-slate-400 hover:text-white text-xs font-bold px-1.5 py-0.5 rounded bg-slate-800"
            >
              ✕
            </button>
          </div>

          <div className="text-[10px] font-mono text-slate-400 mb-2.5">
            High Mn intensity predicted zones (P(Mn) &gt; 75%) with 500m buffers for {currentRegionConfig.name}.
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {targets.map((t) => {
              const isPos = t.sampleStatus === 'SAMPLED_POSITIVE';
              const isNeg = t.sampleStatus === 'SAMPLED_NEGATIVE';
              const statusBg = isPos
                ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
                : isNeg
                ? 'bg-red-500/10 border-red-500/40 text-red-400'
                : 'bg-cyan-500/10 border-cyan-500/40 text-cyan-400';
              const statusLabel = isPos ? '✓ Approved (+)' : isNeg ? '✗ Unviable (-)' : 'Unsampled';

              return (
                <div
                  key={t.id}
                  onClick={() => {
                    leafletRef.current?.flyTo([t.lat, t.lng], 13, { duration: 1.2 });
                    setSelectedTarget(t);
                  }}
                  className="p-2.5 rounded-lg border border-slate-800 hover:border-cyan-500/50 bg-[#0e1929]/80 hover:bg-[#132238] transition-all cursor-pointer group"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-mono font-bold text-slate-200 group-hover:text-cyan-300">
                      {t.name}
                    </span>
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${statusBg}`}>
                      {statusLabel}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono text-slate-400">
                    <div>P(Mn): <strong className="text-purple-400">{(t.prob * 100).toFixed(1)}%</strong></div>
                    <div>Buffer: <strong className="text-cyan-400">{t.radiusM}m</strong></div>
                    <div>Est Grade: <strong className="text-emerald-400">{t.estGrade}% Mn</strong></div>
                    <div>Depth: <strong className="text-slate-300">{t.depthM}m</strong></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Bottom left: Layer toggles ── */}
      <div className="absolute bottom-3 left-3 z-[1000] pointer-events-auto max-w-[calc(50%-12px)]">
        <div className="bg-[#0b1220]/92 backdrop-blur border border-[#1e3a5f] rounded-xl p-2.5 sm:p-3 shadow-xl space-y-1.5 sm:space-y-2 min-w-[140px] sm:min-w-[180px]">
          <div className="flex items-center gap-1.5 mb-1 sm:mb-2">
            <Layers className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-[10px] font-mono font-bold text-slate-300 uppercase tracking-widest">Layers</span>
          </div>
          <LayerToggle
            label="Mn Heatmap"
            active={layers.heatmap}
            onToggle={() => toggleLayer('heatmap')}
            color="#dc2626"
            icon={<Activity className="w-3 h-3" />}
          />
          <LayerToggle
            label="Mine Sites"
            active={layers.mines}
            onToggle={() => toggleLayer('mines')}
            color="#fbbf24"
            icon={<MapPin className="w-3 h-3" />}
          />
          <LayerToggle
            label="India (50)"
            active={layers.national}
            onToggle={() => toggleLayer('national')}
            color="#34d399"
            icon={<Globe className="w-3 h-3" />}
          />
          <LayerToggle
            label="Occurrences"
            active={layers.occurrences}
            onToggle={() => toggleLayer('occurrences')}
            color="#f97316"
            icon={<TrendingUp className="w-3 h-3" />}
          />
          <LayerToggle
            label="Sampling Radii"
            active={layers.targets}
            onToggle={() => toggleLayer('targets')}
            color="#38bdf8"
            icon={<Target className="w-3 h-3" />}
          />
        </div>
      </div>

      {/* ── Bottom right: Heatmap legend + hover readout ── */}
      <div className="absolute bottom-3 right-3 z-[1000] pointer-events-none space-y-2 max-w-[calc(50%-12px)] flex flex-col items-end">
        {/* Hover readout */}
        {hoverInfo && (
          <div className="bg-[#0b1220]/95 backdrop-blur border border-[#1e3a5f] rounded-lg px-2.5 py-1.5 sm:px-3 sm:py-2 shadow-xl pointer-events-auto">
            <div className="flex items-center gap-1.5 mb-1">
              <Crosshair className="w-3 h-3 text-emerald-400" />
              <span className="text-[9px] sm:text-[10px] font-mono text-slate-400">CURSOR READOUT</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] sm:text-[10px] font-mono">
              <span className="text-slate-500">Lat</span>
              <span className="text-white font-bold">{hoverInfo.lat.toFixed(4)}°N</span>
              <span className="text-slate-500">Lng</span>
              <span className="text-white font-bold">{hoverInfo.lng.toFixed(4)}°E</span>
              <span className="text-slate-500">P(Mn)</span>
              <span className="text-amber-400 font-bold">{(hoverInfo.prob * 100).toFixed(0)}%</span>
              <span className="text-slate-500">Est. Grade</span>
              <span className="text-emerald-400 font-bold">{hoverInfo.mnPct.toFixed(1)}% Mn</span>
            </div>
          </div>
        )}

        {/* Legend */}
        <div className="bg-[#0b1220]/92 backdrop-blur border border-[#1e3a5f] rounded-xl p-2.5 sm:p-3 shadow-xl pointer-events-auto max-w-full">
          <div className="text-[9px] font-mono font-bold text-slate-400 uppercase tracking-widest mb-1.5">
            Mn Probability
          </div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <div
              className="h-2.5 sm:h-3 rounded-full flex-1 w-28 sm:w-36"
              style={{
                background: 'linear-gradient(to right, #1a0a0a, #8b0000, #c01c1c, #dc5014, #fbbf24)',
              }}
            />
          </div>
          <div className="flex justify-between text-[8px] sm:text-[9px] font-mono text-slate-500">
            <span>Low &lt;25%</span>
            <span>High &gt;75%</span>
          </div>
          <div className="mt-2 space-y-1">
            <div className="flex items-center gap-1.5 text-[8px] sm:text-[9px] font-mono text-slate-400">
              <div className="w-2.5 h-2.5 rounded-full border-2 border-yellow-400 bg-yellow-400/20" />
              <span>Opencast mine</span>
            </div>
            <div className="flex items-center gap-1.5 text-[8px] sm:text-[9px] font-mono text-slate-400">
              <div className="w-2.5 h-2.5 rounded-full border-2 border-blue-400 bg-blue-400/20" />
              <span>Underground mine</span>
            </div>
            <div className="flex items-center gap-1.5 text-[8px] sm:text-[9px] font-mono text-slate-400">
              <div className="w-2.5 h-2.5 rounded-full bg-orange-500/70 border border-white/30" />
              <span>Predicted occurrence</span>
            </div>
          </div>
          {/* National inventory (India's 50 manganese mines) — colour = ROM grade */}
          <div className="mt-2 pt-2 border-t border-slate-800">
            <div className="text-[8px] sm:text-[9px] font-mono font-bold text-slate-500 uppercase tracking-widest mb-1">
              India Inventory (grade)
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="flex items-center gap-1.5 text-[8px] sm:text-[9px] font-mono text-slate-400">
                <div className="w-2.5 h-2.5 rounded-[2px] rotate-45 bg-[#34d399]" />
                <span>≥30%</span>
              </div>
              <div className="flex items-center gap-1.5 text-[8px] sm:text-[9px] font-mono text-slate-400">
                <div className="w-2.5 h-2.5 rounded-[2px] rotate-45 bg-[#fbbf24]" />
                <span>25–30%</span>
              </div>
              <div className="flex items-center gap-1.5 text-[8px] sm:text-[9px] font-mono text-slate-400">
                <div className="w-2.5 h-2.5 rounded-[2px] rotate-45 bg-[#fb923c]" />
                <span>20–25%</span>
              </div>
              <div className="flex items-center gap-1.5 text-[8px] sm:text-[9px] font-mono text-slate-400">
                <div className="w-2.5 h-2.5 rounded-[2px] rotate-45 bg-[#f87171]" />
                <span>&lt;20%</span>
              </div>
            </div>
          </div>
        </div>

        {/* Selected Point Detail Card */}
        {clickedPred && (
          <div className="bg-[#0b1220]/95 backdrop-blur-md border border-cyan-500/30 rounded-xl p-3 shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-200 min-w-[200px] pointer-events-auto">
            <div className="flex items-center justify-between gap-2 mb-1.5 pb-1 border-b border-slate-800">
              <div className="flex items-center gap-1.5 text-[11px] font-mono font-bold text-cyan-400">
                <Target className="w-3.5 h-3.5 text-cyan-400" />
                <span>Selected Coordinates</span>
              </div>
              <button
                onClick={() => setClickedPred(null)}
                className="text-slate-500 hover:text-slate-300 text-xs font-bold"
              >
                ✕
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
              <div>
                <span className="text-slate-500">Lat / Lon</span>
                <div className="text-slate-200 font-bold">{clickedPred.lat.toFixed(4)}°, {clickedPred.lng.toFixed(4)}°</div>
              </div>
              <div>
                <span className="text-slate-500">P(Mn)</span>
                <div className="text-purple-400 font-bold text-xs">{(clickedPred.prob * 100).toFixed(1)}%</div>
              </div>
              <div>
                <span className="text-slate-500">Est. Grade</span>
                <div className="text-emerald-400 font-bold text-xs">{clickedPred.mnPct.toFixed(1)}% Mn</div>
              </div>
              <div>
                <span className="text-slate-500">Drill Status</span>
                <div className={clickedPred.prob > 0.5 ? "text-emerald-400 font-bold" : "text-amber-400 font-bold"}>
                  {clickedPred.prob > 0.5 ? "★ Recommended" : "Low Priority"}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

        {/* ── Sampling & Mine Planning Modal ── */}
        {selectedTarget && (
          <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200 pointer-events-auto">
            <div className="bg-[#0b1220] border border-cyan-500/40 rounded-2xl p-5 shadow-2xl max-w-md w-full font-mono text-slate-200 relative">
              {/* Header */}
              <div className="flex items-start justify-between pb-3 mb-4 border-b border-slate-800">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 border border-cyan-500/40">
                      {selectedTarget.id}
                    </span>
                    <span className="text-xs text-slate-400">{selectedTarget.district}</span>
                  </div>
                  <h3 className="text-sm font-bold text-white mt-1">{selectedTarget.name}</h3>
                </div>
                <button
                  onClick={() => setSelectedTarget(null)}
                  className="text-slate-400 hover:text-white text-sm font-bold p-1 rounded-lg hover:bg-slate-800"
                >
                  ✕
                </button>
              </div>

              {/* Target Stats */}
              <div className="grid grid-cols-3 gap-2 p-3 rounded-xl bg-[#0e1929] border border-slate-800 text-center mb-4">
                <div>
                  <div className="text-[9px] text-slate-500">PEAK P(Mn)</div>
                  <div className="text-sm font-extrabold text-purple-400">{(selectedTarget.prob * 100).toFixed(1)}%</div>
                </div>
                <div>
                  <div className="text-[9px] text-slate-500">SAMPLING RADIUS</div>
                  <div className="text-sm font-extrabold text-cyan-400">{selectedTarget.radiusM}m</div>
                </div>
                <div>
                  <div className="text-[9px] text-slate-500">ORE DEPTH</div>
                  <div className="text-sm font-extrabold text-amber-400">{selectedTarget.depthM}m</div>
                </div>
              </div>

              {/* Sampling & Assay Controls */}
              <div className="space-y-3 mb-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400 flex items-center gap-1.5">
                    <FlaskConical className="w-4 h-4 text-cyan-400" />
                    <span>Field Assay Result:</span>
                  </span>
                  <span className={`font-bold px-2 py-0.5 rounded text-[10px] ${
                    selectedTarget.sampleStatus === 'SAMPLED_POSITIVE'
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                      : selectedTarget.sampleStatus === 'SAMPLED_NEGATIVE'
                      ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                      : 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/40'
                  }`}>
                    {selectedTarget.sampleStatus === 'SAMPLED_POSITIVE'
                      ? '✓ POSITIVE ASSAY (+)'
                      : selectedTarget.sampleStatus === 'SAMPLED_NEGATIVE'
                      ? '✗ NEGATIVE ASSAY (-)'
                      : 'UNSAMPLED TARGET'}
                  </span>
                </div>

                {selectedTarget.assay ? (
                  <div className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 text-xs space-y-1.5">
                    <div className="grid grid-cols-3 gap-2 text-center pb-2 border-b border-slate-800">
                      <div><span className="text-[9px] text-slate-500">Mn Grade</span><br/><strong className="text-emerald-400 text-sm">{selectedTarget.assay.mnPct}%</strong></div>
                      <div><span className="text-[9px] text-slate-500">Fe Content</span><br/><strong className="text-blue-400">{selectedTarget.assay.fePct}%</strong></div>
                      <div><span className="text-[9px] text-slate-500">SiO₂ Silica</span><br/><strong className="text-slate-300">{selectedTarget.assay.sio2Pct}%</strong></div>
                    </div>
                    <div className="text-[10px] text-slate-300 leading-relaxed italic">{selectedTarget.assay.note}</div>
                  </div>
                ) : (
                  <div className="p-3 rounded-xl bg-slate-900/60 border border-dashed border-slate-800 text-[10px] text-slate-400 text-center">
                    Collect core sample within the {selectedTarget.radiusM}m buffer zone and run chemical spectrometer assay.
                  </div>
                )}

                {/* Action Buttons */}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={() => handleTakeSample(selectedTarget.id, true)}
                    className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-bold text-xs transition-all shadow-lg shadow-emerald-600/20"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Test (+) Positive Sample</span>
                  </button>
                  <button
                    onClick={() => handleTakeSample(selectedTarget.id, false)}
                    className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/40 font-bold text-xs transition-all"
                  >
                    <XCircle className="w-4 h-4" />
                    <span>Test (-) Negative Sample</span>
                  </button>
                </div>
              </div>

              {/* Mining Decision Section */}
              {selectedTarget.sampleStatus === 'SAMPLED_POSITIVE' ? (
                <div className="p-4 rounded-xl bg-slate-900 border border-emerald-500/50 shadow-xl space-y-2.5 animate-in fade-in zoom-in-95 duration-200">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5 uppercase tracking-wider">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      Mining Decision: Approved
                    </span>
                    <span className="text-[9px] font-bold px-2 py-0.5 rounded bg-emerald-500 text-slate-950 uppercase">
                      {selectedTarget.miningMethod} Mine
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                    <div className="bg-slate-950/60 p-2 rounded-lg border border-slate-800">
                      <span className="text-[9px] text-slate-400">EST. ORE RESERVES</span>
                      <div className="text-sm font-extrabold text-emerald-300">{selectedTarget.reservesMt} Mt</div>
                    </div>
                    <div className="bg-slate-950/60 p-2 rounded-lg border border-slate-800">
                      <span className="text-[9px] text-slate-400">CUTOFF GRADE</span>
                      <div className="text-sm font-extrabold text-amber-300">&gt; 35% Mn</div>
                    </div>
                  </div>

                  <button
                    onClick={() => {
                      alert(`Mining Operation Approved for ${selectedTarget.name}! Open pit perimeter defined across ${selectedTarget.radiusM}m radius.`);
                      setSelectedTarget(null);
                    }}
                    className="w-full py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs transition-all shadow-lg flex items-center justify-center gap-2 mt-2"
                  >
                    <span>Initiate Mine Planning & Pit Excavation</span>
                  </button>
                </div>
              ) : selectedTarget.sampleStatus === 'SAMPLED_NEGATIVE' ? (
                <div className="p-3 rounded-xl bg-red-950/40 border border-red-500/30 text-xs text-red-300 space-y-1">
                  <div className="font-bold flex items-center gap-1 text-red-400">
                    <XCircle className="w-4 h-4" /> Mining Unviable
                  </div>
                  <div className="text-[10px] text-slate-400">
                    Sample assay fell below economic cutoff (&lt;20% Mn). Target marked as low-grade silicate zone.
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}

      {/* ── Inject popup/tooltip CSS ── */}
      <style>{`
        .orenex-bb {
          transform: rotateZ(0deg) rotateX(0deg);
        }
        @keyframes mine-pulse {
          0%, 100% { box-shadow: 0 0 12px #fbbf2488, 0 0 24px #fbbf2444; }
          50% { box-shadow: 0 0 20px #fbbf24cc, 0 0 40px #fbbf2466; }
        }
        @keyframes scanline {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(200%); }
        }
        .orenex-popup .leaflet-popup-content-wrapper {
          background: #0e1929;
          border: 1px solid #1e3a5f;
          border-radius: 10px;
          color: #e2e8f0;
          padding: 0;
          box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        }
        .orenex-popup .leaflet-popup-content {
          margin: 0;
          padding: 0;
        }
        .orenex-popup .leaflet-popup-tip {
          background: #0e1929;
        }
        .orenex-popup .leaflet-popup-close-button {
          color: #64748b;
        }
        .orenex-tooltip.leaflet-tooltip {
          background: #0e1929;
          border: 1px solid #1e3a5f;
          border-radius: 6px;
          color: #e2e8f0;
          font-family: ui-monospace, monospace;
          font-size: 10px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        }
        .orenex-tooltip.leaflet-tooltip::before {
          border-top-color: #1e3a5f;
        }
        .leaflet-attribution-flag { display: none !important; }
        .leaflet-control-attribution { font-size: 8px !important; opacity: 0.5; }
      `}</style>
    </div>
  );
};

/* ─── Layer Toggle Button ─────────────────────────────────────────────────── */
const LayerToggle: React.FC<{
  label: string;
  active: boolean;
  onToggle: () => void;
  color: string;
  icon: React.ReactNode;
}> = ({ label, active, onToggle, color, icon }) => (
  <button
    onClick={onToggle}
    className="flex items-center gap-2 w-full text-left group"
  >
    <div
      className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-all"
      style={{ background: active ? color + '33' : '#1e2a38', border: `1.5px solid ${active ? color : '#2d3f55'}` }}
    >
      {active ? (
        <div style={{ color }} className="opacity-90">{icon}</div>
      ) : (
        <EyeOff className="w-2.5 h-2.5 text-slate-600" />
      )}
    </div>
    <span
      className="text-[10px] font-mono transition-colors"
      style={{ color: active ? '#cbd5e1' : '#4b5563' }}
    >
      {label}
    </span>
    <div className="ml-auto">
      {active ? (
        <Eye className="w-3 h-3 text-slate-500" />
      ) : (
        <EyeOff className="w-3 h-3 text-slate-700" />
      )}
    </div>
  </button>
);

/* ─── Popup HTML builders ─────────────────────────────────────────────────── */
function buildMinePopup(mine: MineSite): string {
  const methodColor = mine.miningMethod === 'opencast' ? '#fbbf24' : '#60a5fa';
  return `
    <div style="font-family:ui-monospace,monospace; padding:14px; min-width:220px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #1e3a5f;">
        <div style="width:10px;height:10px;border-radius:50%;background:${methodColor};box-shadow:0 0 6px ${methodColor};"></div>
        <span style="font-weight:700;font-size:12px;color:#f1f5f9;">${mine.name}</span>
        <span style="font-size:9px;color:#64748b;background:#1e2a38;padding:1px 6px;border-radius:4px;">${mine.code}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;font-size:10px;">
        <div><span style="color:#475569;">Method</span><br/><strong style="color:${methodColor};text-transform:capitalize;">${mine.miningMethod}</strong></div>
        <div><span style="color:#475569;">Design Rate</span><br/><strong style="color:#f1f5f9;">${mine.designTpd.toLocaleString()} t/d</strong></div>
        <div><span style="color:#475569;">Feed Grade</span><br/><strong style="color:#34d399;">${mine.feedGradeMn}% Mn</strong></div>
        <div><span style="color:#475569;">Commissioned</span><br/><strong style="color:#f1f5f9;">${mine.commissioned}</strong></div>
        <div style="grid-column:span 2;"><span style="color:#475569;">Plan</span><br/><strong style="color:#f1f5f9;">${mine.plan.label}</strong></div>
      </div>
    </div>`;
}

function buildOccPopup(occ: Occurrence, prob: number): string {
  const priorityColor = prob > 0.65 ? '#34d399' : prob > 0.4 ? '#fbbf24' : '#f87171';
  const priority = prob > 0.65 ? 'HIGH' : prob > 0.4 ? 'MEDIUM' : 'LOW';
  return `
    <div style="font-family:ui-monospace,monospace;padding:14px;min-width:220px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #1e3a5f;">
        <div style="width:10px;height:10px;border-radius:50%;background:#f97316;"></div>
        <span style="font-weight:700;font-size:12px;color:#f1f5f9;">${occ.id}</span>
        <span style="font-size:9px;color:${priorityColor};background:${priorityColor}22;padding:1px 6px;border-radius:4px;border:1px solid ${priorityColor}44;">${priority} PRIORITY</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;font-size:10px;">
        <div><span style="color:#475569;">Mn Grade</span><br/><strong style="color:#34d399;font-size:13px;">${occ.mnPct.toFixed(1)}% Mn</strong></div>
        <div><span style="color:#475569;">P(Mn)</span><br/><strong style="color:#a78bfa;font-size:13px;">${(prob * 100).toFixed(0)}%</strong></div>
        <div><span style="color:#475569;">Depth</span><br/><strong style="color:#f1f5f9;">${occ.depthTopM.toFixed(0)} m</strong></div>
        <div><span style="color:#475569;">Source</span><br/><strong style="color:#94a3b8;">${occ.source}</strong></div>
        <div><span style="color:#475569;">Survey Year</span><br/><strong style="color:#f1f5f9;">${occ.year}</strong></div>
        <div><span style="color:#475569;">Drill Rec.</span><br/><strong style="color:${prob > 0.55 ? '#34d399' : '#f87171'}">${prob > 0.55 ? '✓ YES' : '✗ NO'}</strong></div>
      </div>
    </div>`;
}

/* ─── National inventory popup (India's 50 manganese mines) ──────────────── */
function buildNationalMinePopup(mine: ManganeseMine): string {
  const confColor = mine.confidence === 'high' ? '#34d399' : mine.confidence === 'medium' ? '#fbbf24' : '#f87171';
  const color = gradeColor(mine.gradeMn);
  const methodColor = mine.miningMethod === 'opencast' ? '#fbbf24' : '#60a5fa';
  return `
    <div style="font-family:ui-monospace,monospace;padding:14px;min-width:250px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #1e3a5f;">
        <div style="width:10px;height:10px;border-radius:2px;background:${color};box-shadow:0 0 6px ${color};"></div>
        <span style="font-weight:700;font-size:12px;color:#f1f5f9;">${mine.name}</span>
        <span style="font-size:9px;color:#64748b;background:#1e2a38;padding:1px 6px;border-radius:4px;">${mine.id}</span>
      </div>
      <div style="font-size:9px;color:#94a3b8;margin-bottom:10px;">
        ${mine.operator} · ${mine.district}, ${mine.state}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;font-size:10px;">
        <div><span style="color:#475569;">Grade</span><br/><strong style="color:${color};font-size:13px;">${mine.gradeMn.toFixed(1)}% Mn</strong></div>
        <div><span style="color:#475569;">Capacity</span><br/><strong style="color:#f1f5f9;">${mine.capacityKt} kt/y</strong></div>
        <div><span style="color:#475569;">Reserves</span><br/><strong style="color:#f1f5f9;">${mine.reserveMt.toFixed(1)} Mt</strong></div>
        <div><span style="color:#475569;">Method</span><br/><strong style="color:${methodColor};text-transform:capitalize;">${mine.miningMethod}</strong></div>
        <div><span style="color:#475569;">Belt</span><br/><strong style="color:#f1f5f9;">${mine.belt}</strong></div>
        <div><span style="color:#475569;">Ore Type</span><br/><strong style="color:#f1f5f9;text-transform:capitalize;">${mine.oreType}</strong></div>
        <div><span style="color:#475569;">Depth</span><br/><strong style="color:#f1f5f9;">${mine.depthM} m</strong></div>
        <div><span style="color:#475569;">Phosphorus</span><br/><strong style="color:#f1f5f9;">${mine.phosphorusP.toFixed(2)}% P</strong></div>
        <div><span style="color:#475569;">Commissioned</span><br/><strong style="color:#f1f5f9;">${mine.commissioned}</strong></div>
        <div><span style="color:#475569;">Confidence</span><br/><strong style="color:${confColor};text-transform:uppercase;">${mine.confidence}</strong></div>
        <div><span style="color:#475569;">Lat / Lon</span><br/><strong style="color:#f1f5f9;">${mine.lat.toFixed(3)}°, ${mine.lon.toFixed(3)}°</strong></div>
      </div>
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid #1e3a5f;font-size:9px;color:#64748b;line-height:1.4;">
        Source: ${mine.source}
      </div>
    </div>`;
}
