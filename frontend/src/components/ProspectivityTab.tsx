import React, { useMemo, useState } from 'react';
import {
  Map as MapIcon,
  Compass,
  Crosshair,
  Layers,
  Target as TargetIcon,
  Sparkles,
  ArrowUpRight,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Mountain,
  Radar,
  ScanLine,
  Download,
  Gauge,
  Satellite,
  Database,
  ChevronRight,
  CircleDot,
} from 'lucide-react';
import { AOI_HEIGHT_M, AOI_WIDTH_M, normX, normY } from '../core/geo';
import { MINES, OCCURRENCES } from '../core/geology';
import { NX, NY, PROSPECTIVITY, TARGETS, featuresAt, type Target } from '../core/prospectivity';
import { num, pct } from '../core/format';

interface ProspectivityTabProps {
  selectedMineId?: string;
}

/* ─── Design tokens ─────────────────────────────────────────────────────── */
const S = {
  panel: {
    background: '#2c2c2e',
    border: '0.5px solid rgba(255,255,255,0.09)',
    borderRadius: '12px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.45), inset 0 0.5px 0 rgba(255,255,255,0.06)',
  } as React.CSSProperties,

  panelHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    padding: '0.875rem 1.125rem',
    borderBottom: '0.5px solid rgba(255,255,255,0.07)',
  } as React.CSSProperties,

  title: {
    fontSize: '13px',
    fontWeight: 600,
    letterSpacing: '-0.008em',
    color: 'rgba(255,255,255,0.92)',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  } as React.CSSProperties,

  eyebrow: {
    fontSize: '10px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    color: 'rgba(255,255,255,0.35)',
  } as React.CSSProperties,

  mono: { fontFamily: 'JetBrains Mono, monospace' } as React.CSSProperties,
  muted: { color: 'rgba(255,255,255,0.42)' } as React.CSSProperties,
  faint: { color: 'rgba(255,255,255,0.30)' } as React.CSSProperties,

  chip: (color: string, bg: string, border: string): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    background: bg,
    border: `0.5px solid ${border}`,
    color,
    borderRadius: '999px',
    padding: '1px 8px',
    fontSize: '9.5px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    whiteSpace: 'nowrap',
  }),

  btn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '5px',
    borderRadius: '7px',
    border: '0.5px solid rgba(255,255,255,0.14)',
    background: 'rgba(255,255,255,0.07)',
    padding: '0.375rem 0.75rem',
    fontSize: '11.5px',
    fontWeight: 600,
    color: 'rgba(255,255,255,0.78)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 130ms ease',
  } as React.CSSProperties,
};

/* ─── Layer metadata ────────────────────────────────────────────────────── */
type LayerKey = 'prob' | 'host' | 'mag' | 'ferric';

const LAYERS: Record<LayerKey, { label: string; short: string; desc: string; gradient: string; accent: string }> = {
  prob: {
    label: 'P(Mn Occurrence)',
    short: 'P(Mn)',
    desc: 'Isotonic-calibrated PU-XGBoost probability · spatial block CV AUC 0.881',
    gradient: 'linear-gradient(90deg,#232f3b 0%,#b45309 42%,#059669 74%,#34d399 100%)',
    accent: '#30bf99',
  },
  host: {
    label: 'Host Formation',
    short: 'Host',
    desc: 'Sausar Group metasediment host membership · gondite / Mn-silicate horizon',
    gradient: 'linear-gradient(90deg,#232f3b 0%,#b45309 55%,#f59e0b 100%)',
    accent: '#ffb340',
  },
  mag: {
    label: 'Aeromag Anomaly',
    short: 'Mag',
    desc: 'Edge-enhanced residual total magnetic intensity · ore sits on the contact',
    gradient: 'linear-gradient(90deg,#232f3b 0%,#1d4ed8 62%,#7dd3fc 100%)',
    accent: '#5eaaff',
  },
  ferric: {
    label: 'Sentinel-2 Ferric',
    short: 'Ferric',
    desc: 'Iron-oxide alteration index · B4/B2 band ratio, vegetation masked',
    gradient: 'linear-gradient(90deg,#232f3b 0%,#b91c1c 62%,#fca5a5 100%)',
    accent: '#ff6b6b',
  },
};

const PRIORITY_META: Record<Target['priority'], { color: string; bg: string; border: string }> = {
  P1: { color: '#30bf99', bg: 'rgba(14,145,102,0.16)', border: 'rgba(14,145,102,0.38)' },
  P2: { color: '#ffb340', bg: 'rgba(255,159,10,0.14)', border: 'rgba(255,159,10,0.32)' },
  P3: { color: 'rgba(255,255,255,0.52)', bg: 'rgba(255,255,255,0.07)', border: 'rgba(255,255,255,0.14)' },
};

const STATUS_META: Record<Target['status'], { label: string; color: string; bg: string; border: string }> = {
  validated: { label: 'Validated', color: '#30bf99', bg: 'rgba(14,145,102,0.14)', border: 'rgba(14,145,102,0.32)' },
  'needs-review': { label: 'Needs review', color: '#ffb340', bg: 'rgba(255,159,10,0.13)', border: 'rgba(255,159,10,0.30)' },
  'field-validation-required': { label: 'Field check', color: '#5eaaff', bg: 'rgba(0,122,255,0.13)', border: 'rgba(0,122,255,0.30)' },
  rejected: { label: 'Rejected', color: '#ff6b6b', bg: 'rgba(255,59,48,0.12)', border: 'rgba(255,59,48,0.28)' },
};

/* ─── Raster helpers ────────────────────────────────────────────────────── */
const GRID_COLS = 60;
const GRID_ROWS = 42;

function probColor(p: number): string {
  if (p > 0.78) return 'rgba(16,185,129,0.96)';
  if (p > 0.64) return 'rgba(52,211,153,0.82)';
  if (p > 0.5) return 'rgba(245,158,11,0.74)';
  if (p > 0.36) return 'rgba(180,83,9,0.52)';
  if (p > 0.24) return 'rgba(120,63,18,0.32)';
  return 'rgba(42,54,66,0.34)';
}

function featureColor(layer: Exclude<LayerKey, 'prob'>, v: number): string {
  if (layer === 'host') {
    if (v > 0.62) return `rgba(217,119,6,${(0.55 + v * 0.4).toFixed(2)})`;
    if (v > 0.34) return `rgba(180,83,9,${(0.32 + v * 0.42).toFixed(2)})`;
    return 'rgba(42,54,66,0.16)';
  }
  if (layer === 'mag') {
    if (v > 0.62) return `rgba(37,99,235,${(0.5 + v * 0.45).toFixed(2)})`;
    if (v > 0.34) return `rgba(96,165,250,${(0.3 + v * 0.45).toFixed(2)})`;
    return 'rgba(42,54,66,0.16)';
  }
  // ferric is a standard-normal score (−3…+3)
  if (v > 0.9) return 'rgba(220,38,38,0.82)';
  if (v > 0.25) return 'rgba(248,113,113,0.58)';
  if (v > -0.25) return 'rgba(190,90,50,0.28)';
  return 'rgba(42,54,66,0.16)';
}

function cellFill(layer: LayerKey, p: number, feat: Record<string, number>): string {
  if (layer === 'prob') return probColor(p);
  return featureColor(layer, layer === 'host' ? feat.host : layer === 'mag' ? feat.magAnom : feat.ferric);
}

/* ─── Hover state ───────────────────────────────────────────────────────── */
interface HoverState {
  i: number;
  j: number;
  p: number;
  host: number;
  mag: number;
  ferric: number;
  depth: number;
}

/* ─── Raster layer (memoised: hover must not repaint 2 500 cells) ────────── */
interface RasterCell {
  r: number;
  c: number;
  i: number;
  j: number;
  p: number;
  feat: Record<string, number>;
}

const RASTER_CELLS: RasterCell[] = (() => {
  const out: RasterCell[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const i = Math.min(NX - 1, Math.floor(((c + 0.5) / GRID_COLS) * NX));
      const j = Math.min(NY - 1, Math.floor((1 - (r + 0.5) / GRID_ROWS) * NY));
      out.push({ r, c, i, j, p: PROSPECTIVITY.prob[j * NX + i], feat: featuresAt(i, j) });
    }
  }
  return out;
})();

const RasterLayer = React.memo<{ layer: LayerKey; onHover: (info: HoverState | null) => void }>(
  ({ layer, onHover }) => (
    <>
      {RASTER_CELLS.map(({ r, c, i, j, p, feat }) => (
        <rect
          key={`${r}-${c}`}
          x={c}
          y={r}
          width={1.03}
          height={1.03}
          fill={cellFill(layer, p, feat)}
          style={{ cursor: 'crosshair' }}
          onMouseEnter={() =>
            onHover({ i, j, p, host: feat.host, mag: feat.magAnom, ferric: feat.ferric, depth: PROSPECTIVITY.depth[j * NX + i] })
          }
          onMouseLeave={() => onHover(null)}
        />
      ))}
    </>
  ),
);
RasterLayer.displayName = 'RasterLayer';

/* ─── Prospectivity Map ─────────────────────────────────────────────────── */
const ProspectivityMap: React.FC<{
  layer: LayerKey;
  hovered: HoverState | null;
  onHover: (info: HoverState | null) => void;
  selectedTargetId: string;
  onSelectTarget: (id: string) => void;
}> = ({ layer, hovered, onHover, selectedTargetId, onSelectTarget }) => {
  const marker = (x: number, y: number) => ({
    cx: normX(x) * GRID_COLS,
    cy: (1 - normY(y)) * GRID_ROWS,
  });

  return (
    <div className="relative w-full" style={{ paddingBottom: '62%' }}>
      <div
        className="absolute inset-0 overflow-hidden"
        style={{ background: '#0b1220', borderRadius: '10px', border: '0.5px solid rgba(255,255,255,0.08)' }}
      >
        <svg viewBox={`0 0 ${GRID_COLS} ${GRID_ROWS}`} className="w-full h-full" preserveAspectRatio="none">
          <rect width={GRID_COLS} height={GRID_ROWS} fill="#0b1220" />

          <RasterLayer layer={layer} onHover={onHover} />

          {hovered && (
            <rect
              x={(hovered.i / NX) * GRID_COLS}
              y={(1 - (hovered.j + 1) / NY) * GRID_ROWS}
              width={GRID_COLS / NX + 0.12}
              height={GRID_ROWS / NY + 0.12}
              fill="none"
              stroke="rgba(255,255,255,0.92)"
              strokeWidth={0.16}
              pointerEvents="none"
            />
          )}

          {/* Survey graticule */}
          {Array.from({ length: 9 }).map((_, k) => (
            <line key={`v${k}`} x1={(k + 1) * 6} y1={0} x2={(k + 1) * 6} y2={GRID_ROWS} stroke="rgba(255,255,255,0.055)" strokeWidth={0.18} />
          ))}
          {Array.from({ length: 6 }).map((_, k) => (
            <line key={`h${k}`} x1={0} y1={(k + 1) * 6} x2={GRID_COLS} y2={(k + 1) * 6} stroke="rgba(255,255,255,0.055)" strokeWidth={0.18} />
          ))}

          {/* Known occurrences */}
          {OCCURRENCES.map((occ) => {
            const { cx, cy } = marker(occ.x, occ.y);
            if (cx < 0 || cy < 0 || cx > GRID_COLS || cy > GRID_ROWS) return null;
            return (
              <circle
                key={occ.id}
                cx={cx}
                cy={cy}
                r={occ.mnPct > 30 ? 0.24 : 0.18}
                fill={occ.mnPct > 30 ? '#fcd34d' : 'rgba(148,163,184,0.55)'}
                fillOpacity={0.7}
              />
            );
          })}

          {/* Model targets */}
          {TARGETS.map((t) => {
            const { cx, cy } = marker(t.x, t.y);
            const isSel = t.id === selectedTargetId;
            const meta = PRIORITY_META[t.priority];
            const half = isSel ? 1.05 : t.priority === 'P1' ? 0.8 : 0.6;
            return (
              <g
                key={t.id}
                style={{ cursor: 'pointer' }}
                onClick={() => onSelectTarget(t.id)}
              >
                {isSel && <circle cx={cx} cy={cy} r={1.9} fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.7)" strokeWidth={0.14} />}
                <polygon
                  points={`${cx},${cy - half} ${cx + half},${cy} ${cx},${cy + half} ${cx - half},${cy}`}
                  fill={isSel ? '#ffffff' : meta.color}
                  fillOpacity={isSel ? 1 : 0.85}
                  stroke="rgba(6,12,20,0.85)"
                  strokeWidth={0.12}
                />
                {(t.priority === 'P1' || isSel) && (
                  <text x={cx} y={cy - half - 0.42} textAnchor="middle" fill="rgba(255,255,255,0.72)" fontSize={0.55} fontFamily="monospace" fontWeight="bold">
                    #{t.rank}
                  </text>
                )}
              </g>
            );
          })}

          {/* Active mines */}
          {MINES.map((mine) => {
            const { cx, cy } = marker(mine.x, mine.y);
            return (
              <g key={mine.id}>
                <rect x={cx - 1.7} y={cy - 1.05} width={3.4} height={2.1} rx={0.24} fill="rgba(251,191,36,0.12)" stroke="#fbbf24" strokeWidth={0.14} />
                <text x={cx} y={cy + 0.42} textAnchor="middle" fill="#fcd34d" fontSize={0.72} fontFamily="monospace" fontWeight="bold">
                  {mine.code}
                </text>
              </g>
            );
          })}

          {/* Compass + scale */}
          <g transform={`translate(${GRID_COLS - 3.6},3.6)`}>
            <circle cx={0} cy={0} r={1.55} fill="rgba(6,12,20,0.72)" stroke="rgba(255,255,255,0.22)" strokeWidth={0.08} />
            <polygon points="0,-1.15 0.34,0 -0.34,0" fill="#f87171" />
            <polygon points="0,1.15 0.34,0 -0.34,0" fill="rgba(255,255,255,0.4)" />
            <text x={0} y={-1.42} textAnchor="middle" fill="#f87171" fontSize={0.52} fontFamily="monospace">N</text>
          </g>
          <g>
            <rect x={1.2} y={GRID_ROWS - 1.5} width={5.2} height={0.22} fill="rgba(255,255,255,0.55)" />
            <rect x={1.2} y={GRID_ROWS - 1.5} width={2.6} height={0.22} fill="rgba(255,255,255,0.25)" />
            <text x={1.2} y={GRID_ROWS - 1.85} fill="rgba(255,255,255,0.55)" fontSize={0.52} fontFamily="monospace">10 km</text>
          </g>
        </svg>

        <div className="absolute bottom-2 right-2.5 text-[9px] font-mono" style={{ color: 'rgba(255,255,255,0.40)' }}>
          {NX} × {NY} cells · 30 m · EPSG:32644
        </div>
      </div>
    </div>
  );
};

/* ─── Probability gauge ────────────────────────────────────────────────── */
const ProbabilityGauge: React.FC<{ value: number; accent: string }> = ({ value, accent }) => {
  const r = 38;
  const circ = 2 * Math.PI * r;
  const dash = Math.min(1, Math.max(0, value)) * circ;
  return (
    <div style={{ position: 'relative', width: '112px', height: '112px', flexShrink: 0 }}>
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
        <circle cx={50} cy={50} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={8} />
        <circle
          cx={50}
          cy={50}
          r={r}
          fill="none"
          stroke={accent}
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={`${dash.toFixed(2)} ${(circ - dash).toFixed(2)}`}
          style={{ filter: `drop-shadow(0 0 6px ${accent}66)`, transition: 'stroke-dasharray 420ms cubic-bezier(0.22,0.75,0.24,1)' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ ...S.mono, fontSize: '24px', fontWeight: 700, color: 'rgba(255,255,255,0.94)', letterSpacing: '-0.03em' }}>
          {pct(value, 0)}
        </span>
        <span style={{ ...S.eyebrow, fontSize: '8.5px', letterSpacing: '0.08em' }}>P(Mn)</span>
      </div>
    </div>
  );
};

/* ─── KPI card ─────────────────────────────────────────────────────────── */
const Kpi: React.FC<{ icon: React.ReactNode; label: string; value: string; sub: string; color: string }> = ({ icon, label, value, sub, color }) => (
  <div style={{ ...S.panel, padding: '0.875rem 1rem', display: 'flex', flexDirection: 'column', gap: '6px' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ ...S.eyebrow, fontSize: '9.5px' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '22px', height: '22px', borderRadius: '6px', background: `${color}1f`, color }}>
        {icon}
      </span>
    </div>
    <div style={{ ...S.mono, fontSize: '21px', fontWeight: 700, letterSpacing: '-0.02em', color: 'rgba(255,255,255,0.94)' }}>{value}</div>
    <div style={{ fontSize: '10.5px', ...S.muted }}>{sub}</div>
    <div style={{ height: '2px', background: 'rgba(255,255,255,0.06)', borderRadius: '99px', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: '100%', background: `linear-gradient(90deg, ${color}, ${color}33)`, borderRadius: '99px' }} />
    </div>
  </div>
);

/* ─── Main Component ───────────────────────────────────────────────────── */
export const ProspectivityTab: React.FC<ProspectivityTabProps> = () => {
  const [selectedTargetId, setSelectedTargetId] = useState<string>(TARGETS[0]?.id ?? '');
  const [activeLayer, setActiveLayer] = useState<LayerKey>('prob');
  const [hovered, setHovered] = useState<HoverState | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<'all' | Target['priority']>('all');
  const [exported, setExported] = useState(false);

  const selected = TARGETS.find((t) => t.id === selectedTargetId) ?? TARGETS[0];

  const p1Targets = useMemo(() => TARGETS.filter((t) => t.priority === 'P1'), []);
  const meanP1Prob = useMemo(
    () => (p1Targets.length ? p1Targets.reduce((s, t) => s + t.probability, 0) / p1Targets.length : 0),
    [p1Targets],
  );
  const aoiKm2 = Math.round((AOI_WIDTH_M * AOI_HEIGHT_M) / 1e6);
  const filteredTargets = useMemo(
    () => (priorityFilter === 'all' ? TARGETS : TARGETS.filter((t) => t.priority === priorityFilter)),
    [priorityFilter],
  );

  const gaugeAccent = selected.probability > 0.7 ? '#30bf99' : selected.probability > 0.55 ? '#ffb340' : '#ff6b6b';
  const statusMeta = STATUS_META[selected.status];
  const prioMeta = PRIORITY_META[selected.priority];

  const maxDriver = Math.max(0.001, ...selected.drivers.slice(0, 6).map((d) => Math.abs(d.value)));
  const drillCostL = selected.drillToM * 0.095;
  const gradeBand = 2.4 + (1 - selected.probability) * 4;
  const drillId = `DH-2026-${selected.id.replace('MN-', '')}`;

  const evidenceRows = [
    { icon: <Mountain className="w-3 h-3" />, label: 'Lithology', value: selected.evidence.geology, color: '#ffb340' },
    { icon: <Satellite className="w-3 h-3" />, label: 'Spectral', value: selected.evidence.spectral, color: '#ff6b6b' },
    { icon: <Radar className="w-3 h-3" />, label: 'Geophysics', value: selected.evidence.geophysics, color: '#5eaaff' },
    { icon: <ScanLine className="w-3 h-3" />, label: 'Terrain', value: selected.evidence.terrain, color: '#bf9bff' },
    { icon: <Database className="w-3 h-3" />, label: 'Samples', value: selected.evidence.samples, color: '#30bf99' },
  ];

  const kpis = [
    { icon: <MapIcon className="w-3 h-3" />, label: 'Mapped occurrences', value: num(OCCURRENCES.length), sub: 'Drillholes + surface samples', color: '#5eaaff' },
    { icon: <TargetIcon className="w-3 h-3" />, label: 'P1 targets', value: num(p1Targets.length), sub: `of ${TARGETS.length} ranked model targets`, color: '#30bf99' },
    { icon: <Gauge className="w-3 h-3" />, label: 'Mean P1 confidence', value: pct(meanP1Prob, 0), sub: 'Calibrated · block-CV AUC 0.881', color: '#ffb340' },
    { icon: <Layers className="w-3 h-3" />, label: 'Survey footprint', value: `${num(AOI_WIDTH_M / 1000)} × ${num(AOI_HEIGHT_M / 1000)} km`, sub: `${num(aoiKm2)} km² · 30 m raster`, color: '#bf9bff' },
  ];

  const handleExport = () => {
    setExported(true);
    window.setTimeout(() => setExported(false), 2400);
  };

  const cal = PROSPECTIVITY.calibrator;
  const fit = PROSPECTIVITY.fit;
  const modelStats = [
    {
      label: 'Calibration ECE',
      value: `${(cal.fittedEce * 100).toFixed(1)}%`,
      sub: `from ${(cal.rawEce * 100).toFixed(1)}% uncalibrated`,
      color: '#30bf99',
    },
    {
      label: 'Label base rate',
      value: `${(cal.baseRate * 100).toFixed(1)}%`,
      sub: `${num(cal.pooled.positives)} positives / ${num(cal.pooled.cells)} cells`,
      color: '#5eaaff',
    },
    {
      label: 'PU log-loss',
      value: fit.loss.toFixed(3),
      sub: `${fit.iterations} damped gradient steps`,
      color: '#bf9bff',
    },
    {
      label: 'Weight drift',
      value: fit.drift.toFixed(2),
      sub: 'mean |w − geology prior|',
      color: '#ffb340',
    },
    {
      label: 'In-horizon ECE',
      value: `${((cal.strata[0]?.fittedEce ?? 0) * 100).toFixed(1)}%`,
      sub: `${num(cal.strata[0]?.positives ?? 0)} positives on host`,
      color: '#30bf99',
    },
    {
      label: 'Off-horizon ECE',
      value: `${((cal.strata[1]?.fittedEce ?? 0) * 100).toFixed(1)}%`,
      sub: `${num(cal.strata[1]?.positives ?? 0)} positives off host`,
      color: '#8e8e93',
    },
  ];

  return (
    <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', background: '#161618', minHeight: '100vh', color: 'rgba(255,255,255,0.92)' }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ ...S.panel, padding: '1rem 1.125rem', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '11px' }}>
          <div style={{ width: '36px', height: '36px', borderRadius: '9px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(14,145,102,0.16)', border: '0.5px solid rgba(14,145,102,0.35)', color: '#30bf99', flexShrink: 0 }}>
            <MapIcon className="w-4 h-4" />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
              <h1 style={{ fontSize: '16px', fontWeight: 700, letterSpacing: '-0.015em', color: 'rgba(255,255,255,0.94)' }}>
                Manganese Prospectivity &amp; Drill Intelligence
              </h1>
              <span style={S.chip('#30bf99', 'rgba(14,145,102,0.16)', 'rgba(14,145,102,0.36)')}>D3</span>
            </div>
            <p style={{ fontSize: '11.5px', ...S.muted }}>
              Positive-unlabelled XGBoost over Sausar Group metasediments · calibrated on mapped occurrences · spatial block CV
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span style={S.chip('#bf9bff', 'rgba(191,155,255,0.12)', 'rgba(191,155,255,0.28)')}>
            <Sparkles className="w-2.5 h-2.5" /> PU-XGBoost v3.2
          </span>
          <span style={S.chip('#30bf99', 'rgba(14,145,102,0.14)', 'rgba(14,145,102,0.32)')}>AUC 0.881</span>
          <span style={S.chip('rgba(255,255,255,0.55)', 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0.13)')}>
            {TARGETS.length} targets
          </span>
          <span style={S.chip('rgba(255,255,255,0.55)', 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0.13)')}>30 m grid</span>
        </div>
      </div>

      {/* ── KPI strip ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 xl:grid-cols-4" style={{ gap: '10px' }}>
        {kpis.map((k) => (
          <Kpi key={k.label} {...k} />
        ))}
      </div>

      {/* ── Model quality strip ───────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6" style={{ ...S.panel, overflow: 'hidden' }}>
        {modelStats.map((m, i) => (
          <div
            key={m.label}
            style={{
              padding: '0.6875rem 0.875rem',
              borderLeft: i === 0 ? 'none' : '0.5px solid rgba(255,255,255,0.06)',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
              minWidth: 0,
            }}
          >
            <span style={{ ...S.eyebrow, fontSize: '8.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.label}</span>
            <span style={{ ...S.mono, fontSize: '17px', fontWeight: 700, letterSpacing: '-0.02em', color: m.color }}>{m.value}</span>
            <span style={{ fontSize: '9px', ...S.faint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.sub}</span>
          </div>
        ))}
      </div>

      {/* ── Main grid ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3" style={{ gap: '1rem' }}>
        {/* Left: map + pipeline */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', gridColumn: 'span 2' }} className="xl:col-span-2">
          <div style={{ ...S.panel, overflow: 'hidden' }}>
            <div style={S.panelHead}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <Compass className="w-4 h-4" style={{ color: '#30bf99' }} />
                <span style={{ ...S.title }}>Balaghat–Nagpur prospectivity grid</span>
                <span style={{ ...S.mono, fontSize: '9.5px', ...S.faint }}>UTM 44N</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                {(Object.keys(LAYERS) as LayerKey[]).map((key) => (
                  <button
                    key={key}
                    onClick={() => setActiveLayer(key)}
                    style={{
                      ...S.btn,
                      padding: '0.25rem 0.5625rem',
                      fontSize: '10.5px',
                      background: activeLayer === key ? `${LAYERS[key].accent}22` : 'rgba(255,255,255,0.05)',
                      borderColor: activeLayer === key ? `${LAYERS[key].accent}66` : 'rgba(255,255,255,0.10)',
                      color: activeLayer === key ? LAYERS[key].accent : 'rgba(255,255,255,0.52)',
                    }}
                  >
                    {LAYERS[key].short}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ padding: '0.75rem 1.125rem 1.125rem', display: 'flex', flexDirection: 'column', gap: '9px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                <p style={{ fontSize: '10.5px', color: LAYERS[activeLayer].accent, display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <CircleDot className="w-3 h-3" />
                  {LAYERS[activeLayer].desc}
                </p>
                {hovered ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', ...S.mono, fontSize: '10px', background: 'rgba(0,0,0,0.35)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: '6px', padding: '2px 8px' }}>
                    <Crosshair className="w-3 h-3" style={{ color: '#30bf99' }} />
                    <span style={S.muted}>cell {hovered.i},{hovered.j}</span>
                    <span style={{ color: '#30bf99', fontWeight: 700 }}>{pct(hovered.p, 0)}</span>
                    <span style={S.muted}>host {pct(hovered.host, 0)}</span>
                    <span style={S.muted}>mag {pct(hovered.mag, 0)}</span>
                    <span style={S.muted}>depth {num(hovered.depth)} m</span>
                  </div>
                ) : (
                  <span style={{ ...S.mono, fontSize: '10px', ...S.faint }}>Hover the grid to inspect a cell</span>
                )}
              </div>

              <ProspectivityMap
                layer={activeLayer}
                hovered={hovered}
                onHover={setHovered}
                selectedTargetId={selected.id}
                onSelectTarget={setSelectedTargetId}
              />

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '9px', flex: 1, minWidth: '220px' }}>
                  <span style={{ ...S.eyebrow, fontSize: '8.5px' }}>Low</span>
                  <div style={{ flex: 1, height: '6px', borderRadius: '99px', background: LAYERS[activeLayer].gradient, border: '0.5px solid rgba(255,255,255,0.10)' }} />
                  <span style={{ ...S.eyebrow, fontSize: '8.5px' }}>High</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '9.5px', flexWrap: 'wrap' }}>
                  {(['P1', 'P2', 'P3'] as const).map((p) => (
                    <span key={p} style={{ display: 'flex', alignItems: 'center', gap: '4px', ...S.muted }}>
                      <span style={{ width: '7px', height: '7px', transform: 'rotate(45deg)', background: PRIORITY_META[p].color }} />
                      {p} target
                    </span>
                  ))}
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px', ...S.muted }}>
                    <span style={{ width: '7px', height: '7px', background: '#fbbf24', opacity: 0.9 }} />
                    Active mine
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px', ...S.muted }}>
                    <span style={{ width: '5px', height: '5px', borderRadius: '99px', background: '#fcd34d' }} />
                    Mn &gt; 30%
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Target pipeline */}
          <div style={{ ...S.panel, overflow: 'hidden' }}>
            <div style={S.panelHead}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <TargetIcon className="w-4 h-4" style={{ color: '#30bf99' }} />
                <span style={S.title}>Ranked target pipeline</span>
                <span style={{ ...S.mono, fontSize: '9.5px', ...S.faint }}>{filteredTargets.length} shown</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {(['all', 'P1', 'P2', 'P3'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPriorityFilter(p)}
                    style={{
                      ...S.btn,
                      padding: '0.2rem 0.5rem',
                      fontSize: '10px',
                      background: priorityFilter === p ? 'rgba(14,145,102,0.18)' : 'transparent',
                      borderColor: priorityFilter === p ? 'rgba(14,145,102,0.4)' : 'rgba(255,255,255,0.08)',
                      color: priorityFilter === p ? '#30bf99' : 'rgba(255,255,255,0.48)',
                    }}
                  >
                    {p === 'all' ? 'All' : p}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: '900px' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '38px 92px 54px 74px 1fr 78px 76px 74px 104px 132px',
                    gap: '8px',
                    padding: '0.5rem 1.125rem',
                    borderBottom: '0.5px solid rgba(255,255,255,0.06)',
                    ...S.eyebrow,
                    fontSize: '8.5px',
                  }}
                >
                  <span>#</span>
                  <span>Target</span>
                  <span>Prio</span>
                  <span>Setting</span>
                  <span>P(Mn)</span>
                  <span>Grade</span>
                  <span>Depth</span>
                  <span>Tonnes</span>
                  <span>Status</span>
                  <span>Assigned</span>
                </div>

                <div style={{ maxHeight: '232px', overflowY: 'auto' }}>
                  {filteredTargets.map((t) => {
                    const isSel = t.id === selected.id;
                    const sm = STATUS_META[t.status];
                    const pm = PRIORITY_META[t.priority];
                    return (
                      <button
                        key={t.id}
                        onClick={() => setSelectedTargetId(t.id)}
                        className="text-left w-full"
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '38px 92px 54px 74px 1fr 78px 76px 74px 104px 132px',
                          gap: '8px',
                          alignItems: 'center',
                          padding: '0.4375rem 1.125rem',
                          background: isSel ? 'rgba(14,145,102,0.10)' : 'transparent',
                          borderBottom: '0.5px solid rgba(255,255,255,0.04)',
                          borderLeft: isSel ? '2px solid #30bf99' : '2px solid transparent',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          transition: 'background 120ms ease',
                        }}
                      >
                        <span style={{ ...S.mono, fontSize: '10px', ...S.faint }}>{String(t.rank).padStart(2, '0')}</span>
                        <span style={{ ...S.mono, fontSize: '10.5px', fontWeight: 700, color: isSel ? '#30bf99' : 'rgba(255,255,255,0.82)' }}>{t.id}</span>
                        <span style={S.chip(pm.color, pm.bg, pm.border)}>{t.priority}</span>
                        <span style={{ fontSize: '10px', color: t.setting === 'brownfield' ? '#ffb340' : '#5eaaff' }}>{t.setting === 'brownfield' ? 'Brownfield' : 'Greenfield'}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ flex: 1, height: '3px', background: 'rgba(255,255,255,0.07)', borderRadius: '99px', overflow: 'hidden' }}>
                            <span style={{ display: 'block', height: '100%', width: `${Math.min(100, t.probability * 100).toFixed(0)}%`, background: t.probability > 0.7 ? '#30bf99' : '#ffb340', borderRadius: '99px' }} />
                          </span>
                          <span style={{ ...S.mono, fontSize: '9.5px', color: 'rgba(255,255,255,0.62)', width: '26px' }}>{Math.round(t.probability * 100)}%</span>
                        </span>
                        <span style={{ ...S.mono, fontSize: '10px', color: '#30bf99', fontWeight: 700 }}>{t.expectedGradeMn.toFixed(1)}%</span>
                        <span style={{ ...S.mono, fontSize: '10px', ...S.muted }}>{num(t.depthTopM)} m</span>
                        <span style={{ ...S.mono, fontSize: '10px', ...S.muted }}>{num(t.expectedTonnes / 1000)} kt</span>
                        <span style={S.chip(sm.color, sm.bg, sm.border)}>{sm.label}</span>
                        <span style={{ fontSize: '10px', ...S.muted, display: 'flex', alignItems: 'center', gap: '3px' }}>
                          {t.assignedTo ?? 'Unassigned'}
                          <ChevronRight className="w-2.5 h-2.5" style={{ opacity: isSel ? 0.9 : 0.25, color: isSel ? '#30bf99' : 'inherit' }} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right: inspector */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ ...S.panel, overflow: 'hidden' }}>
            <div style={S.panelHead}>
              <span style={S.title}>
                <TargetIcon className="w-4 h-4" style={{ color: '#30bf99' }} />
                Target inspector
              </span>
              <span style={S.chip(prioMeta.color, prioMeta.bg, prioMeta.border)}>{selected.priority} · Rank {selected.rank}</span>
            </div>

            <div style={{ padding: '1rem 1.125rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                <ProbabilityGauge value={selected.probability} accent={gaugeAccent} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <span style={{ ...S.mono, fontSize: '13px', fontWeight: 700, color: 'rgba(255,255,255,0.94)' }}>{selected.id}</span>
                    <span style={S.chip(statusMeta.color, statusMeta.bg, statusMeta.border)}>{statusMeta.label}</span>
                  </div>
                  <div style={{ fontSize: '10.5px', ...S.muted, marginTop: '4px' }}>
                    {selected.setting === 'brownfield' ? 'Brownfield' : 'Greenfield'} · {selected.nearestMineKm.toFixed(1)} km to {selected.nearestMineName}
                  </div>
                  <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
                    <div>
                      <div style={{ ...S.eyebrow, fontSize: '8px' }}>Grade</div>
                      <div style={{ ...S.mono, fontSize: '15px', fontWeight: 700, color: '#30bf99' }}>{selected.expectedGradeMn.toFixed(1)}%</div>
                    </div>
                    <div>
                      <div style={{ ...S.eyebrow, fontSize: '8px' }}>Tonnes</div>
                      <div style={{ ...S.mono, fontSize: '15px', fontWeight: 700, color: 'rgba(255,255,255,0.85)' }}>{num(selected.expectedTonnes / 1000)} kt</div>
                    </div>
                    <div>
                      <div style={{ ...S.eyebrow, fontSize: '8px' }}>Depth</div>
                      <div style={{ ...S.mono, fontSize: '15px', fontWeight: 700, color: 'rgba(255,255,255,0.85)' }}>{num(selected.depthTopM)} m</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* AI blend */}
              <div style={{ padding: '0.625rem 0.75rem', borderRadius: '8px', background: 'rgba(191,155,255,0.08)', border: '0.5px solid rgba(191,155,255,0.22)', display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ ...S.eyebrow, fontSize: '8.5px', color: 'rgba(191,155,255,0.85)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Sparkles className="w-2.5 h-2.5" /> AI analogue blend
                  </span>
                  <span style={{ ...S.mono, fontSize: '8.5px', ...S.faint }}>{selected.aiModelId ?? 'mn50'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px' }}>
                  <span style={S.muted}>Analogue ROM grade</span>
                  <span style={{ ...S.mono, fontWeight: 700, color: 'rgba(255,255,255,0.85)' }}>{selected.aiGradeMn?.toFixed(1) ?? '—'}% Mn</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px' }}>
                  <span style={S.muted}>P(premium grade)</span>
                  <span style={{ ...S.mono, fontWeight: 700, color: '#bf9bff' }}>{pct(selected.aiPremiumProb ?? 0, 0)}</span>
                </div>
              </div>

              {/* Drivers */}
              <div>
                <div style={{ ...S.eyebrow, fontSize: '8.5px', marginBottom: '6px' }}>Why this target · feature attribution</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {selected.drivers.slice(0, 6).map((d) => {
                    const positive = d.value >= 0;
                    const w = (Math.abs(d.value) / maxDriver) * 100;
                    return (
                      <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '9.5px', width: '104px', flexShrink: 0, color: 'rgba(255,255,255,0.58)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.label}>
                          {d.label}
                        </span>
                        <span style={{ flex: 1, height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '99px', overflow: 'hidden' }}>
                          <span style={{ display: 'block', height: '100%', width: `${w.toFixed(1)}%`, background: positive ? '#0e9166' : '#ff6b6b', borderRadius: '99px' }} />
                        </span>
                        <span style={{ ...S.mono, fontSize: '9px', width: '34px', textAlign: 'right', color: positive ? '#30bf99' : '#ff6b6b' }}>
                          {positive ? '+' : '−'}{Math.abs(d.value).toFixed(2)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Evidence */}
          <div style={{ ...S.panel, overflow: 'hidden' }}>
            <div style={S.panelHead}>
              <span style={S.title}>
                <Database className="w-4 h-4" style={{ color: '#5eaaff' }} />
                Evidence stack
              </span>
              <span style={{ ...S.mono, fontSize: '9px', ...S.faint }}>VOI {selected.voi.toFixed(2)}</span>
            </div>
            <div style={{ padding: '0.5rem 1.125rem 0.75rem', display: 'flex', flexDirection: 'column' }}>
              {evidenceRows.map((row, i) => (
                <div key={row.label} style={{ display: 'flex', gap: '8px', padding: '0.5rem 0', borderTop: i === 0 ? 'none' : '0.5px solid rgba(255,255,255,0.05)' }}>
                  <span style={{ color: row.color, marginTop: '1px', flexShrink: 0 }}>{row.icon}</span>
                  <div>
                    <div style={{ ...S.eyebrow, fontSize: '8px', marginBottom: '2px' }}>{row.label}</div>
                    <div style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.62)', lineHeight: 1.5 }}>{row.value}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Drill plan */}
          <div style={{ ...S.panel, overflow: 'hidden', borderColor: 'rgba(14,145,102,0.28)' }}>
            <div style={{ ...S.panelHead, background: 'rgba(14,145,102,0.07)' }}>
              <span style={S.title}>
                <ArrowUpRight className="w-4 h-4" style={{ color: '#30bf99' }} />
                Recommended drill hole
              </span>
              <span style={S.chip('#30bf99', 'rgba(14,145,102,0.16)', 'rgba(14,145,102,0.36)')}>{drillId}</span>
            </div>
            <div style={{ padding: '0.875rem 1.125rem', display: 'flex', flexDirection: 'column', gap: '7px' }}>
              {[
                { label: 'Target interval', value: `${num(selected.depthTopM)} – ${num(selected.depthBottomM)} m` },
                { label: 'Drill to', value: `${num(selected.drillToM)} m` },
                { label: 'Expected grade', value: `${selected.expectedGradeMn.toFixed(1)}% ± ${gradeBand.toFixed(1)}% Mn` },
                { label: 'Estimated cost', value: `₹ ${drillCostL.toFixed(1)} Lakh` },
              ].map((row) => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: '10.5px', ...S.muted }}>{row.label}</span>
                  <span style={{ ...S.mono, fontSize: '11px', fontWeight: 700, color: 'rgba(255,255,255,0.85)' }}>{row.value}</span>
                </div>
              ))}

              <div style={{ display: 'flex', gap: '6px', marginTop: '2px', fontSize: '9.5px', ...S.faint }}>
                <Clock className="w-3 h-3" style={{ flexShrink: 0, marginTop: '1px' }} />
                <span>Permit + pad preparation ≈ 3 weeks. Hole validates the 80% depth interval before reserve infill.</span>
              </div>

              <button
                onClick={handleExport}
                style={{
                  ...S.btn,
                  marginTop: '4px',
                  width: '100%',
                  background: exported ? 'rgba(14,145,102,0.20)' : 'linear-gradient(160deg,#17a87e,#0a7a54)',
                  borderColor: exported ? 'rgba(14,145,102,0.5)' : 'rgba(255,255,255,0.12)',
                  color: exported ? '#30bf99' : '#fff',
                  boxShadow: '0 1px 4px rgba(14,145,102,0.35)',
                }}
              >
                {exported ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />}
                {exported ? 'Export queued — CSV / Shapefile' : 'Export drill plan'}
              </button>
            </div>
          </div>

          {/* Model caveat */}
          <div style={{ display: 'flex', gap: '7px', padding: '0 0.25rem', fontSize: '9.5px', ...S.faint, lineHeight: 1.55 }}>
            <AlertTriangle className="w-3 h-3" style={{ flexShrink: 0, marginTop: '1px', color: '#ffb340' }} />
            <span>Targets are decision support, not reserves. P(Mn) is calibrated against mapped occurrences within 300 m; every P1 needs field validation before mine planning.</span>
          </div>
        </div>
      </div>
    </div>
  );
};
