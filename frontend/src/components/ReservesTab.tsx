import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Layers,
  Sliders,
  BarChart3,
  Box,
  TrendingDown,
  Info,
  Database,
  Ruler,
  FlaskConical,
  ShieldCheck,
  Activity,
  Grid3x3,
} from 'lucide-react';
import {
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
  Cell,
  Line,
  ComposedChart,
} from 'recharts';
import { MINES } from '../core/geology';
import { estimateFor, gradeTonnage, reserveSummary } from '../core/reserves';
import { num } from '../core/format';

interface ReservesTabProps {
  selectedMineId: string;
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
    fontSize: '9.5px',
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

/* ─── 3-D Interactive Isometric Block Model Canvas ──────────────────────── */
const ISO_COLS = 14;
const ISO_ROWS = 10;
const ISO_LEVELS = 5; // depth levels (L1 surface → L5 deep core)
/** Coarse display cells aggregate many 10 × 10 × 5 m kriged blocks. */
interface CellModel {
  /** Tonnes-weighted Mn% for the cell, or null where the domain has no blocks. */
  grade: number | null;
  tonnes: number;
  /** Tonnes-weighted reduced level (elevation) of the cell, m RL. */
  rlM: number;
}

interface BlockModel {
  cells: CellModel[][][];
  /** Blocks the coarse grid was built from. */
  sourceBlocks: number;
}

function buildBlockModel(mineId: string): BlockModel {
  const blocks = estimateFor(mineId).blocks;
  if (!blocks.length) {
    return { cells: [], sourceBlocks: 0 };
  }

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const b of blocks) {
    if (b.xc < x0) x0 = b.xc;
    if (b.xc > x1) x1 = b.xc;
    if (b.yc < y0) y0 = b.yc;
    if (b.yc > y1) y1 = b.yc;
    if (b.zc < z0) z0 = b.zc;
    if (b.zc > z1) z1 = b.zc;
  }
  const spanX = Math.max(1, x1 - x0);
  const spanY = Math.max(1, y1 - y0);
  const spanZ = Math.max(1, z1 - z0);

  const cell = () =>
    Array.from({ length: ISO_LEVELS }, () =>
      Array.from({ length: ISO_ROWS }, () => Array.from({ length: ISO_COLS }, () => ({ g: 0, t: 0, z: 0 }))),
    );
  const acc = cell();

  for (const b of blocks) {
    const c = Math.min(ISO_COLS - 1, Math.max(0, Math.floor(((b.xc - x0) / spanX) * ISO_COLS)));
    // North-up display: increasing northing draws toward the top of the view.
    const r = Math.min(ISO_ROWS - 1, Math.max(0, Math.floor(((b.yc - y0) / spanY) * ISO_ROWS)));
    const lv = Math.min(ISO_LEVELS - 1, Math.max(0, Math.floor(((z1 - b.zc) / spanZ) * ISO_LEVELS)));
    const a = acc[lv][r][c];
    a.g += b.mnP50 * b.tonnesP50;
    a.t += b.tonnesP50;
    a.z += b.zc * b.tonnesP50;
  }

  const cells: CellModel[][][] = acc.map((lvl) =>
    lvl.map((row) =>
      row.map((a) => ({
        grade: a.t > 0 ? a.g / a.t : null,
        tonnes: a.t,
        rlM: a.t > 0 ? a.z / a.t : 0,
      })),
    ),
  );

  return { cells, sourceBlocks: blocks.length };
}

function getBlockColor(grade: number, cutoff: number, isOreOnly: boolean): { top: string; right: string; left: string; stroke: string; isWaste: boolean } {
  const isWaste = grade < cutoff;
  if (isWaste) {
    if (isOreOnly) return { top: 'transparent', right: 'transparent', left: 'transparent', stroke: 'transparent', isWaste: true };
    return {
      top: 'rgba(30,41,59,0.22)',
      right: 'rgba(20,30,45,0.18)',
      left: 'rgba(15,23,42,0.15)',
      stroke: 'rgba(51,65,85,0.2)',
      isWaste: true,
    };
  }

  // Normalized grade above cutoff (0 .. 1)
  const t = Math.min(1, (grade - cutoff) / (50 - cutoff));

  let r = 16, g = 185, b = 129; // emerald default
  if (grade >= 38) {
    r = 251; g = 191; b = 36; // high-grade amber/gold peak
  } else if (grade >= 30) {
    r = 16; g = 185; b = 129; // medium-high emerald
  } else if (grade >= 22) {
    r = 6; g = 182; b = 212; // medium cyan/teal
  } else {
    r = 59; g = 130; b = 246; // low grade blue
  }

  const alpha = 0.65 + t * 0.32;
  const top = `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
  const right = `rgba(${Math.round(r * 0.75)},${Math.round(g * 0.75)},${Math.round(b * 0.75)},${alpha.toFixed(2)})`;
  const left = `rgba(${Math.round(r * 0.55)},${Math.round(g * 0.55)},${Math.round(b * 0.55)},${alpha.toFixed(2)})`;
  const stroke = `rgba(${Math.min(255, r + 40)},${Math.min(255, g + 40)},${Math.min(255, b + 40)},0.4)`;

  return { top, right, left, stroke, isWaste: false };
}

interface HoveredBlockInfo {
  col: number;
  row: number;
  level: number;
  grade: number;
  rlM: number;
  tonnes: number;
}

interface PickEntry {
  col: number;
  row: number;
  level: number;
  x: number;
  y: number;
}

const BlockModelCanvas: React.FC<{ cutoffMn: number; mineId: string }> = ({ cutoffMn, mineId }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pickRef = useRef<PickEntry[]>([]);
  const blockSizeRef = useRef<number>(10);
  const [, setResizeTick] = useState<number>(0);

  // Interaction State
  const [yaw, setYaw] = useState<number>(0.785); // 45 deg initial
  const [pitch, setPitch] = useState<number>(0.55); // ~31.5 deg initial
  const [selectedLevel, setSelectedLevel] = useState<number | 'ALL'>('ALL');
  const [oreOnly, setOreOnly] = useState<boolean>(false);
  const [hoveredBlock, setHoveredBlock] = useState<HoveredBlockInfo | null>(null);

  const isDraggingRef = useRef<boolean>(false);
  const lastMousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Coarse display grid aggregated from the mine's kriged block estimate.
  const model = useMemo(() => buildBlockModel(mineId), [mineId]);
  const blockGrades = model.cells;

  // A stale pick from the previous mine would point at a different cell.
  useEffect(() => {
    setHoveredBlock(null);
    setSelectedLevel('ALL');
  }, [mineId]);

  // Ore / waste summary for the visible slice
  const blockStats = useMemo(() => {
    let oreT = 0;
    let wasteT = 0;
    let gradeWeighted = 0;
    for (let lv = 0; lv < ISO_LEVELS; lv++) {
      if (selectedLevel !== 'ALL' && selectedLevel !== lv) continue;
      for (let r = 0; r < ISO_ROWS; r++) {
        for (let c = 0; c < ISO_COLS; c++) {
          const cell = blockGrades[lv]?.[r]?.[c];
          if (!cell || cell.grade === null) continue;
          if (cell.grade >= cutoffMn) {
            oreT += cell.tonnes;
            gradeWeighted += cell.grade * cell.tonnes;
          } else {
            wasteT += cell.tonnes;
          }
        }
      }
    }
    return { oreT, wasteT, totalT: oreT + wasteT, avgGrade: oreT ? gradeWeighted / oreT : 0 };
  }, [blockGrades, cutoffMn, selectedLevel]);

  // Redraw on viewport resize so the canvas raster stays sharp
  useEffect(() => {
    const onResize = () => setResizeTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Render 3D isometric block model
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle High DPI displays cleanly
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;
    ctx.clearRect(0, 0, W, H);

    // 3D Scene setup
    const cx = W / 2;
    const cy = H / 2 + 10;
    const blockSize = Math.min(W, H) / 22;
    blockSizeRef.current = blockSize;
    pickRef.current = [];

    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);

    // Coordinate transformation helper
    const project = (col: number, row: number, lv: number) => {
      const gx = col - (ISO_COLS - 1) / 2;
      const gy = row - (ISO_ROWS - 1) / 2;
      const gz = (ISO_LEVELS - 1) / 2 - lv; // top level at top

      const rx = gx * cosY - gy * sinY;
      const ry = gx * sinY + gy * cosY;

      const rz = gz * cosP - ry * sinP;
      const ryFinal = gz * sinP + ry * cosP;

      return {
        x: cx + rx * blockSize * 1.8,
        y: cy + rz * blockSize * 1.4 - ryFinal * blockSize * 0.5,
        depth: ryFinal,
      };
    };

    interface DrawBlock {
      col: number;
      row: number;
      level: number;
      grade: number;
      depth: number;
      pTop: { x: number; y: number }[];
      pRight: { x: number; y: number }[];
      pLeft: { x: number; y: number }[];
      colors: ReturnType<typeof getBlockColor>;
    }

    const blocksToDraw: DrawBlock[] = [];

    for (let lv = 0; lv < ISO_LEVELS; lv++) {
      if (selectedLevel !== 'ALL' && selectedLevel !== lv) continue;

      for (let r = 0; r < ISO_ROWS; r++) {
        for (let c = 0; c < ISO_COLS; c++) {
          const cell = blockGrades[lv]?.[r]?.[c];
          if (!cell || cell.grade === null) continue;
          const grade = cell.grade;
          const colors = getBlockColor(grade, cutoffMn, oreOnly);
          if (colors.top === 'transparent') continue;

          const p = (dc: number, dr: number, dlv: number) => project(c + dc, r + dr, lv + dlv);

          const p000 = p(0, 0, 0);
          const p100 = p(1, 0, 0);
          const p110 = p(1, 1, 0);
          const p010 = p(0, 1, 0);

          const p101 = p(1, 0, 0.75);
          const p111 = p(1, 1, 0.75);
          const p011 = p(0, 1, 0.75);

          const depth = (p000.depth + p111.depth) / 2;

          blocksToDraw.push({
            col: c,
            row: r,
            level: lv,
            grade,
            depth,
            pTop: [p000, p100, p110, p010],
            pRight: [p100, p110, p111, p101],
            pLeft: [p010, p110, p111, p011],
            colors,
          });
        }
      }
    }

    // Sort back-to-front (Painter's algorithm)
    blocksToDraw.sort((a, b) => a.depth - b.depth);

    // Grid floor baseline
    ctx.strokeStyle = 'rgba(30, 58, 95, 0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (let c = 0; c <= ISO_COLS; c += 2) {
      const pStart = project(c, 0, ISO_LEVELS);
      const pEnd = project(c, ISO_ROWS, ISO_LEVELS);
      ctx.beginPath();
      ctx.moveTo(pStart.x, pStart.y);
      ctx.lineTo(pEnd.x, pEnd.y);
      ctx.stroke();
    }
    for (let r = 0; r <= ISO_ROWS; r += 2) {
      const pStart = project(0, r, ISO_LEVELS);
      const pEnd = project(ISO_COLS, r, ISO_LEVELS);
      ctx.beginPath();
      ctx.moveTo(pStart.x, pStart.y);
      ctx.lineTo(pEnd.x, pEnd.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Draw blocks
    blocksToDraw.forEach((b) => {
      const isHovered = hoveredBlock?.col === b.col && hoveredBlock?.row === b.row && hoveredBlock?.level === b.level;

      ctx.beginPath();
      ctx.moveTo(b.pTop[0].x, b.pTop[0].y);
      ctx.lineTo(b.pTop[1].x, b.pTop[1].y);
      ctx.lineTo(b.pTop[2].x, b.pTop[2].y);
      ctx.lineTo(b.pTop[3].x, b.pTop[3].y);
      ctx.closePath();
      ctx.fillStyle = isHovered ? '#e2f7ff' : b.colors.top;
      ctx.fill();
      ctx.strokeStyle = isHovered ? '#38bdf8' : b.colors.stroke;
      ctx.lineWidth = isHovered ? 2 : 0.6;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(b.pRight[0].x, b.pRight[0].y);
      ctx.lineTo(b.pRight[1].x, b.pRight[1].y);
      ctx.lineTo(b.pRight[2].x, b.pRight[2].y);
      ctx.lineTo(b.pRight[3].x, b.pRight[3].y);
      ctx.closePath();
      ctx.fillStyle = isHovered ? '#38bdf8' : b.colors.right;
      ctx.fill();
      ctx.strokeStyle = isHovered ? '#38bdf8' : b.colors.stroke;
      ctx.lineWidth = isHovered ? 2 : 0.6;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(b.pLeft[0].x, b.pLeft[0].y);
      ctx.lineTo(b.pLeft[1].x, b.pLeft[1].y);
      ctx.lineTo(b.pLeft[2].x, b.pLeft[2].y);
      ctx.lineTo(b.pLeft[3].x, b.pLeft[3].y);
      ctx.closePath();
      ctx.fillStyle = isHovered ? '#0284c7' : b.colors.left;
      ctx.fill();
      ctx.strokeStyle = isHovered ? '#38bdf8' : b.colors.stroke;
      ctx.lineWidth = isHovered ? 2 : 0.6;
      ctx.stroke();

      // Record the projected block centre for hover picking
      const centre = project(b.col + 0.5, b.row + 0.5, b.level + 0.375);
      pickRef.current.push({ col: b.col, row: b.row, level: b.level, x: centre.x, y: centre.y });
    });

    // Gradient legend
    const legX = 16, legY = H - 110;
    ctx.fillStyle = 'rgba(11, 18, 32, 0.88)';
    ctx.strokeStyle = 'rgba(30, 58, 95, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(legX - 6, legY - 10, 148, 105, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 9px ui-monospace, monospace';
    ctx.fillText('MODEL CELL Mn%', legX, legY);

    const legendItems = [
      { label: '> 38% High grade', color: '#fbbf24' },
      { label: '30–38% Medium grade', color: '#10b981' },
      { label: '22–30% Low ore', color: '#06b6d4' },
      { label: '< cut-off Waste', color: '#334155' },
    ];

    legendItems.forEach((item, i) => {
      ctx.fillStyle = item.color;
      ctx.fillRect(legX, legY + 12 + i * 18, 12, 12);
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.strokeRect(legX, legY + 12 + i * 18, 12, 12);

      ctx.fillStyle = item.color === '#334155' ? '#64748b' : '#f1f5f9';
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(item.label, legX + 18, legY + 21 + i * 18);
    });

    // Compass orientation tag
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.fillText('N ⇑', W - 40, 74);
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('E ⇒', W - 40, 88);
  }, [yaw, pitch, cutoffMn, selectedLevel, oreOnly, hoveredBlock, blockGrades]);

  // Mouse interaction handlers for 3D rotation & hover
  const handleMouseDown = (e: React.MouseEvent) => {
    isDraggingRef.current = true;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDraggingRef.current) {
      const dx = e.clientX - lastMousePosRef.current.x;
      const dy = e.clientY - lastMousePosRef.current.y;
      setYaw((prev) => prev + dx * 0.008);
      setPitch((prev) => Math.max(0.1, Math.min(1.4, prev + dy * 0.008)));
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };
      return;
    }
    if (!canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Pick the nearest projected block centre to the cursor
    let best: PickEntry | null = null;
    let bestDist = Infinity;
    for (const b of pickRef.current) {
      const d = Math.hypot(b.x - mx, b.y - my);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }

    if (!best || bestDist > blockSizeRef.current * 1.5) {
      if (hoveredBlock) setHoveredBlock(null);
      return;
    }

    if (hoveredBlock && hoveredBlock.col === best.col && hoveredBlock.row === best.row && hoveredBlock.level === best.level) return;

    const cell = blockGrades[best.level]?.[best.row]?.[best.col];
    if (!cell || cell.grade === null) return;

    setHoveredBlock({
      col: best.col,
      row: best.row,
      level: best.level,
      grade: cell.grade,
      rlM: Math.round(cell.rlM),
      tonnes: Math.round(cell.tonnes),
    });
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
  };

  const handleMouseLeave = () => {
    isDraggingRef.current = false;
    setHoveredBlock(null);
  };

  return (
    <div className="relative rounded-xl overflow-hidden border border-[#1e3a5f] bg-[#0b1220] shadow-2xl group">
      {/* Top floating toolbar */}
      <div className="absolute top-3 left-3 right-3 z-10 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        <div className="flex items-center gap-1 bg-[#0b1220]/90 backdrop-blur border border-[#1e3a5f] rounded-lg p-1 shadow-lg pointer-events-auto">
          <span className="text-[10px] font-mono font-bold text-slate-400 px-2">LEVEL:</span>
          <button
            onClick={() => setSelectedLevel('ALL')}
            className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold transition-all ${
              selectedLevel === 'ALL' ? 'bg-cyan-500 text-slate-950' : 'text-slate-400 hover:text-white'
            }`}
          >
            All
          </button>
          {[0, 1, 2, 3, 4].map((lv) => (
            <button
              key={lv}
              onClick={() => setSelectedLevel(lv)}
              className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold transition-all ${
                selectedLevel === lv ? 'bg-cyan-500 text-slate-950' : 'text-slate-400 hover:text-white'
              }`}
            >
              L{lv + 1}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 pointer-events-auto">
          <button
            onClick={() => setOreOnly((v) => !v)}
            className={`px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold border transition-all shadow-lg flex items-center gap-1.5 ${
              oreOnly
                ? 'bg-amber-500 text-slate-950 border-amber-400 font-extrabold shadow-amber-500/20'
                : 'bg-[#0b1220]/90 text-amber-400 border-amber-500/40 hover:bg-[#1e2a38]'
            }`}
          >
            <Box className="w-3 h-3" />
            <span>{oreOnly ? 'Ore lenses only' : 'Show all blocks'}</span>
          </button>

          <button
            onClick={() => {
              setYaw(0.785);
              setPitch(0.55);
              setSelectedLevel('ALL');
              setOreOnly(false);
            }}
            className="px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold bg-[#0b1220]/90 text-slate-300 border border-[#1e3a5f] hover:text-white hover:bg-[#1e3a5f] transition-all shadow-lg"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Section readout */}
      <div className="absolute top-[52px] left-3 z-10 pointer-events-none text-[9px] font-mono text-slate-500">
        SECTION {selectedLevel === 'ALL' ? 'L1–L5' : `L${(selectedLevel as number) + 1}`} · {num(blockStats.oreT / 1000)} kt ORE / {num(blockStats.wasteT / 1000)} kt WASTE
        {model.sourceBlocks > 0 && <span className="text-slate-600"> · {num(model.sourceBlocks)} kriged blocks binned</span>}
      </div>

      {/* Hover inspection HUD */}
      {hoveredBlock && (
        <div className="absolute top-14 left-3 z-20 pointer-events-none bg-[#0b1220]/95 backdrop-blur-md border border-cyan-500/40 rounded-xl p-3 shadow-2xl font-mono text-[10px] space-y-1.5 min-w-[200px]">
          <div className="flex items-center justify-between border-b border-slate-800 pb-1">
            <span className="font-bold text-cyan-400">CELL-L{hoveredBlock.level + 1}-R{hoveredBlock.row}-C{hoveredBlock.col}</span>
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
              hoveredBlock.grade >= cutoffMn
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                : 'bg-slate-800 text-slate-400 border border-slate-700'
            }`}>
              {hoveredBlock.grade >= cutoffMn ? 'ORE' : 'WASTE'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-slate-300">
            <div>RL: <strong className="text-white">{hoveredBlock.rlM} m</strong></div>
            <div>Grade: <strong className={hoveredBlock.grade >= 35 ? 'text-amber-400 font-extrabold text-xs' : 'text-emerald-400'}>{hoveredBlock.grade.toFixed(1)}% Mn</strong></div>
            <div>Tonnage: <strong className="text-white">{num(hoveredBlock.tonnes / 1000)} kt</strong></div>
            <div>Level: <strong className="text-cyan-400">L{hoveredBlock.level + 1}</strong></div>
          </div>
        </div>
      )}

      {/* Slice statistics */}
      <div className="absolute bottom-3 right-3 z-10 pointer-events-none bg-[#0b1220]/90 backdrop-blur border border-[#1e3a5f] rounded-lg px-3 py-2 shadow-lg font-mono">
        <div className="text-[9px] uppercase tracking-[0.12em] text-slate-500 mb-1">Slice summary</div>
        <div className="flex items-center gap-3 text-[10px]">
          <span className="text-slate-400">ORE <strong className="text-emerald-400">{num(blockStats.oreT / 1000)} kt</strong></span>
          <span className="text-slate-400">AVG <strong className="text-amber-400">{blockStats.avgGrade.toFixed(1)}%</strong></span>
          <span className="text-slate-400">MASS <strong className="text-cyan-300">{num(blockStats.totalT / 1000)} kt</strong></span>
        </div>
      </div>

      {/* Hint */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none bg-[#0b1220]/80 backdrop-blur border border-cyan-500/30 rounded-full px-3 py-1 text-[9px] font-mono text-cyan-300 shadow-lg flex items-center gap-1.5 whitespace-nowrap">
        <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
        <span>Drag to orbit · hover a block to inspect</span>
      </div>

      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        className="w-full h-[470px] cursor-grab active:cursor-grabbing block"
      />
    </div>
  );
};

/* ─── KPI card ─────────────────────────────────────────────────────────── */
const Kpi: React.FC<{ icon: React.ReactNode; label: string; value: string; sub: string; color: string; footer?: React.ReactNode }> = ({ icon, label, value, sub, color, footer }) => (
  <div style={{ ...S.panel, padding: '0.875rem 1rem', display: 'flex', flexDirection: 'column', gap: '6px' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ ...S.eyebrow, fontSize: '9.5px' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '22px', height: '22px', borderRadius: '6px', background: `${color}1f`, color }}>{icon}</span>
    </div>
    <div style={{ ...S.mono, fontSize: '21px', fontWeight: 700, letterSpacing: '-0.02em', color: 'rgba(255,255,255,0.94)' }}>{value}</div>
    <div style={{ fontSize: '10.5px', ...S.muted }}>{sub}</div>
    {footer}
  </div>
);

/* ─── Main Component ───────────────────────────────────────────────────── */
export const ReservesTab: React.FC<ReservesTabProps> = ({ selectedMineId }) => {
  const activeMineId = selectedMineId === 'ALL' ? 'MNE-BAL' : selectedMineId;
  const activeMine = MINES.find((m) => m.id === activeMineId) || MINES[0];

  const [cutoffMn, setCutoffMn] = useState<number>(20);
  const [view3D, setView3D] = useState<boolean>(true);

  const estimate = estimateFor(activeMine.id);
  // 1 % steps line up exactly with the slider, so the readout never disagrees
  // with the curve point being reported.
  const gtCurve = useMemo(
    () => gradeTonnage(estimate, Array.from({ length: 21 }, (_, i) => 10 + i)),
    [estimate],
  );

  // Nearest curve point to the slider (the curve runs 10…30 % Mn).
  const currentGtPoint = gtCurve.reduce(
    (best, p) => (Math.abs(p.cutOff - cutoffMn) < Math.abs(best.cutOff - cutoffMn) ? p : best),
    gtCurve[0],
  );

  const summary = reserveSummary(estimate, currentGtPoint.cutOff);
  const planSummary = reserveSummary(estimate, currentGtPoint.cutOff, true);

  const p50T = summary.totalTonnes;
  const p10T = summary.p10Tonnes;
  const p90T = summary.p90Tonnes;
  const containedMnMt = summary.containedMnT / 1e6;
  // Headline coverage uses the same M+I basis as the Overview so the two
  // screens never disagree; the plan-envelope figure is reported alongside it.
  const mPlusIT = summary.measuredTonnes + summary.indicatedTonnes;
  const ociMonths = mPlusIT > 0 ? Math.round((mPlusIT / (activeMine.designTpd * 365)) * 12) : 0;
  const planTonnes = planSummary.measuredTonnes + planSummary.indicatedTonnes;
  const planMonths = planTonnes > 0 ? Math.round((planTonnes / (activeMine.designTpd * 365)) * 12) : 0;

  const ociColor = ociMonths > 24 ? '#30bf99' : ociMonths > 12 ? '#ffb340' : '#ff6b6b';

  const gtChartData = gtCurve.map((p) => ({
    cutOff: p.cutOff,
    tonnes: +(p.totalTonnes / 1e6).toFixed(3),
    grade: +p.gradeMn.toFixed(2),
    p10: +(p.tonnesP10 / 1e6).toFixed(3),
    p90: +(p.tonnesP90 / 1e6).toFixed(3),
  }));

  const categoryCards = [
    {
      code: '111',
      label: 'Proved',
      tonnes: summary.measuredTonnes,
      grade: summary.meanGradeMn,
      confidence: 'High',
      color: '#30bf99',
      note: '< 25 m drill spacing · measured blocks',
    },
    {
      code: '122',
      label: 'Probable',
      tonnes: summary.indicatedTonnes,
      grade: summary.meanGradeMn * 0.94,
      confidence: 'Medium',
      color: '#ffb340',
      note: '25–50 m spacing · feasibility demonstrated',
    },
    {
      code: '221',
      label: 'Indicated resource',
      tonnes: summary.inferredTonnes * 0.4,
      grade: summary.meanGradeMn * 0.88,
      confidence: 'Exploration',
      color: '#ff8f4d',
      note: 'Continuity inferred from regional trends',
    },
    {
      code: '333',
      label: 'Inferred resource',
      tonnes: summary.inferredTonnes * 0.6,
      grade: summary.meanGradeMn * 0.82,
      confidence: 'Low',
      color: '#8e8e93',
      note: 'Structural interpretation · infill required',
    },
  ];
  const categoryTotal = categoryCards.reduce((s, c) => s + c.tonnes, 0) || 1;

  const uncertaintySpan = Math.max(1, p90T - p10T);
  const p50Pos = Math.min(100, Math.max(0, ((p50T - p10T) / uncertaintySpan) * 100));

  const sensitivity = gtCurve.filter((p) => [12, 16, 20, 24, 28, 30].includes(p.cutOff));

  const inputs = [
    { label: 'Assay composites', value: num(estimate.assayCount) },
    { label: 'Drillholes', value: num(estimate.drillHoleCount) },
    { label: 'Mean spacing', value: `${num(estimate.meanSpacingM)} m` },
    { label: 'Kriging std. error', value: `± ${estimate.meanKrigingSd.toFixed(2)}% Mn` },
    { label: 'Last model run', value: estimate.lastRun },
    { label: 'Snapshot', value: estimate.snapshotId },
  ];

  return (
    <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', background: '#161618', minHeight: '100vh', color: 'rgba(255,255,255,0.92)' }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ ...S.panel, padding: '1rem 1.125rem', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '11px' }}>
          <div style={{ width: '36px', height: '36px', borderRadius: '9px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,122,255,0.14)', border: '0.5px solid rgba(0,122,255,0.32)', color: '#5eaaff', flexShrink: 0 }}>
            <Layers className="w-4 h-4" />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
              <h1 style={{ fontSize: '16px', fontWeight: 700, letterSpacing: '-0.015em', color: 'rgba(255,255,255,0.94)' }}>
                Block Model &amp; UNFC Reserve Intelligence
              </h1>
              <span style={S.chip('#5eaaff', 'rgba(0,122,255,0.14)', 'rgba(0,122,255,0.32)')}>D4</span>
            </div>
            <p style={{ fontSize: '11.5px', ...S.muted }}>
              Regression kriging · XGBoost trend + ordinary kriging · 10 × 10 × 5 m blocks · {activeMine.name}
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px', background: 'rgba(255,255,255,0.05)', border: '0.5px solid rgba(255,255,255,0.10)', borderRadius: '8px', padding: '3px' }}>
            <button
              onClick={() => setView3D(true)}
              style={{
                ...S.btn,
                padding: '0.25rem 0.625rem',
                fontSize: '10.5px',
                background: view3D ? 'rgba(255,255,255,0.10)' : 'transparent',
                borderColor: 'transparent',
                color: view3D ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.42)',
                boxShadow: view3D ? '0 1px 3px rgba(0,0,0,0.35)' : 'none',
              }}
            >
              <Box className="w-3 h-3" /> 3D model
            </button>
            <button
              onClick={() => setView3D(false)}
              style={{
                ...S.btn,
                padding: '0.25rem 0.625rem',
                fontSize: '10.5px',
                background: !view3D ? 'rgba(255,255,255,0.10)' : 'transparent',
                borderColor: 'transparent',
                color: !view3D ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.42)',
                boxShadow: !view3D ? '0 1px 3px rgba(0,0,0,0.35)' : 'none',
              }}
            >
              <BarChart3 className="w-3 h-3" /> Grade–tonnage
            </button>
          </div>
          <span style={S.chip('#bf9bff', 'rgba(191,155,255,0.12)', 'rgba(191,155,255,0.28)')}>Model {estimate.modelVersion}</span>
          <span style={S.chip('rgba(255,255,255,0.55)', 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0.13)')}>Variogram 190 / 62 m</span>
        </div>
      </div>

      {/* ── KPI strip ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 xl:grid-cols-4" style={{ gap: '10px' }}>
        <Kpi
          icon={<Activity className="w-3 h-3" />}
          label="Ore cover · M+I"
          value={`${num(ociMonths)} mo`}
          sub={`Plan envelope ${num(planMonths)} mo · ${activeMine.plan.label}`}
          color={ociColor}
          footer={
            <div style={{ height: '3px', background: 'rgba(255,255,255,0.07)', borderRadius: '99px', overflow: 'hidden', marginTop: '2px' }}>
              <div style={{ height: '100%', width: `${Math.min(100, (ociMonths / 36) * 100).toFixed(0)}%`, background: ociColor, borderRadius: '99px' }} />
            </div>
          }
        />
        <Kpi
          icon={<Layers className="w-3 h-3" />}
          label="P50 reserve"
          value={`${(p50T / 1e6).toFixed(2)} Mt`}
          sub={`${summary.meanGradeMn.toFixed(1)}% Mn · at ${currentGtPoint.cutOff.toFixed(0)}% cut-off`}
          color="#30bf99"
        />
        <Kpi
          icon={<FlaskConical className="w-3 h-3" />}
          label="Contained metal"
          value={`${containedMnMt.toFixed(2)} Mt`}
          sub={`P10 ${(p10T / 1e6).toFixed(2)} Mt · P90 ${(p90T / 1e6).toFixed(2)} Mt ROM`}
          color="#ffb340"
        />
        <Kpi
          icon={<ShieldCheck className="w-3 h-3" />}
          label="Estimate confidence"
          value={`± ${estimate.meanKrigingSd.toFixed(2)}%`}
          sub={`${num(estimate.drillHoleCount)} holes · ${num(estimate.meanSpacingM)} m spacing`}
          color="#5eaaff"
        />
      </div>

      {/* ── Main grid ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3" style={{ gap: '1rem' }}>
        {/* Left column: cut-off simulator + model inputs */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ ...S.panel, overflow: 'hidden' }}>
            <div style={S.panelHead}>
              <span style={S.title}>
                <Sliders className="w-4 h-4" style={{ color: '#30bf99' }} />
                Cut-off simulator
              </span>
              <span style={S.chip('#30bf99', 'rgba(14,145,102,0.14)', 'rgba(14,145,102,0.32)')}>{cutoffMn.toFixed(0)}% Mn</span>
            </div>

            <div style={{ padding: '1rem 1.125rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                <span style={{ ...S.mono, fontSize: '34px', fontWeight: 700, letterSpacing: '-0.03em', color: 'rgba(255,255,255,0.94)' }}>
                  {cutoffMn.toFixed(0)}
                </span>
                <span style={{ fontSize: '12px', ...S.muted }}>% Mn cut-off</span>
                <span style={{ marginLeft: 'auto', ...S.mono, fontSize: '10px', color: '#30bf99' }}>{num(currentGtPoint.blocks)} blocks</span>
              </div>

              <div>
                <input
                  type="range"
                  min="10"
                  max="30"
                  step="1"
                  value={cutoffMn}
                  onChange={(e) => setCutoffMn(parseFloat(e.target.value))}
                  className="w-full cursor-pointer"
                  style={{ accentColor: '#0e9166' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', ...S.mono, fontSize: '8.5px', ...S.faint, marginTop: '2px' }}>
                  <span>10%</span><span>14%</span><span>18%</span><span>22%</span><span>26%</span><span>30%</span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                {[12, 16, 20, 24, 28].map((c) => (
                  <button
                    key={c}
                    onClick={() => setCutoffMn(c)}
                    style={{
                      ...S.btn,
                      padding: '0.2rem 0.5rem',
                      fontSize: '10px',
                      background: currentGtPoint.cutOff === c ? 'rgba(14,145,102,0.18)' : 'transparent',
                      borderColor: currentGtPoint.cutOff === c ? 'rgba(14,145,102,0.4)' : 'rgba(255,255,255,0.09)',
                      color: currentGtPoint.cutOff === c ? '#30bf99' : 'rgba(255,255,255,0.5)',
                    }}
                  >
                    {c}%
                  </button>
                ))}
              </div>

              <div style={{ padding: '0.75rem', background: 'rgba(255,255,255,0.035)', border: '0.5px solid rgba(255,255,255,0.07)', borderRadius: '9px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                {[
                  { l: 'ROM tonnage', v: `${(p50T / 1e6).toFixed(3)} Mt`, c: 'rgba(255,255,255,0.9)' },
                  { l: 'Mean grade', v: `${currentGtPoint.gradeMn.toFixed(2)}%`, c: '#30bf99' },
                  { l: 'Contained Mn', v: `${(currentGtPoint.containedMn / 1e6).toFixed(3)} Mt`, c: '#ffb340' },
                  { l: 'Ore blocks', v: num(currentGtPoint.blocks), c: 'rgba(255,255,255,0.9)' },
                ].map((m) => (
                  <div key={m.l}>
                    <div style={{ ...S.eyebrow, fontSize: '8px', marginBottom: '2px' }}>{m.l}</div>
                    <div style={{ ...S.mono, fontSize: '14px', fontWeight: 700, color: m.c }}>{m.v}</div>
                  </div>
                ))}
              </div>

              {/* Uncertainty band */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', ...S.eyebrow, fontSize: '8px', marginBottom: '5px' }}>
                  <span>Uncertainty band · 100 realisations</span>
                  <span style={S.faint}>{((p90T - p10T) / 1e6).toFixed(2)} Mt spread</span>
                </div>
                <div style={{ position: 'relative', height: '10px', borderRadius: '99px', background: 'linear-gradient(90deg,#ff6b6b33 0%,#ffb34055 40%,#0e916655 62%,#30bf9933 100%)', border: '0.5px solid rgba(255,255,255,0.08)' }}>
                  <div style={{ position: 'absolute', top: '-2px', bottom: '-2px', left: `calc(${p50Pos.toFixed(1)}% - 1.5px)`, width: '3px', borderRadius: '2px', background: '#30bf99', boxShadow: '0 0 6px rgba(48,191,153,0.8)' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', ...S.mono, fontSize: '9px', ...S.faint, marginTop: '3px' }}>
                  <span>P10 {(p10T / 1e6).toFixed(2)}</span>
                  <span style={{ color: '#30bf99' }}>P50 {(p50T / 1e6).toFixed(2)}</span>
                  <span>P90 {(p90T / 1e6).toFixed(2)} Mt</span>
                </div>
              </div>

              {/* Cut-off sensitivity */}
              <div>
                <div style={{ ...S.eyebrow, fontSize: '8px', marginBottom: '4px' }}>Cut-off sensitivity</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {sensitivity.map((p) => {
                    const active = p.cutOff === currentGtPoint.cutOff;
                    return (
                      <button
                        key={p.cutOff}
                        onClick={() => setCutoffMn(p.cutOff)}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '42px 1fr 54px 50px',
                          gap: '6px',
                          alignItems: 'center',
                          padding: '3px 6px',
                          borderRadius: '5px',
                          border: 'none',
                          background: active ? 'rgba(14,145,102,0.12)' : 'transparent',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        <span style={{ ...S.mono, fontSize: '9.5px', color: active ? '#30bf99' : 'rgba(255,255,255,0.45)', textAlign: 'left' }}>{p.cutOff}%</span>
                        <span style={{ height: '3px', background: 'rgba(255,255,255,0.06)', borderRadius: '99px', overflow: 'hidden' }}>
                          <span style={{ display: 'block', height: '100%', width: `${Math.min(100, (p.totalTonnes / (gtCurve[0]?.totalTonnes || 1)) * 100).toFixed(0)}%`, background: active ? '#30bf99' : 'rgba(255,255,255,0.18)', borderRadius: '99px' }} />
                        </span>
                        <span style={{ ...S.mono, fontSize: '9px', color: 'rgba(255,255,255,0.55)', textAlign: 'right' }}>{(p.totalTonnes / 1e6).toFixed(2)} Mt</span>
                        <span style={{ ...S.mono, fontSize: '9px', color: 'rgba(255,255,255,0.35)', textAlign: 'right' }}>{p.gradeMn.toFixed(1)}%</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Model inputs */}
          <div style={{ ...S.panel, overflow: 'hidden' }}>
            <div style={S.panelHead}>
              <span style={S.title}>
                <Database className="w-4 h-4" style={{ color: '#5eaaff' }} />
                Estimation inputs
              </span>
              <span style={{ ...S.mono, fontSize: '9px', ...S.faint }}>{estimate.validationFold}-fold block CV</span>
            </div>
            <div style={{ padding: '0.5rem 1.125rem 0.75rem' }}>
              {inputs.map((row, i) => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0.375rem 0', borderTop: i === 0 ? 'none' : '0.5px solid rgba(255,255,255,0.05)' }}>
                  <span style={{ fontSize: '10.5px', ...S.muted }}>{row.label}</span>
                  <span style={{ ...S.mono, fontSize: '10.5px', color: 'rgba(255,255,255,0.78)' }}>{row.value}</span>
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '8px', fontSize: '9.5px', ...S.faint }}>
                <Ruler className="w-3 h-3" />
                <span>Block geometry 10 × 10 × 5 m · density 2.45 t/m³</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right column: 3D / grade–tonnage + UNFC */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', gridColumn: 'span 2' }} className="xl:col-span-2">
          {view3D ? (
            <div style={{ ...S.panel, overflow: 'hidden' }}>
              <div style={S.panelHead}>
                <span style={S.title}>
                  <Box className="w-4 h-4" style={{ color: '#5eaaff' }} />
                  3D block model · {activeMine.name}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', ...S.mono, fontSize: '9px', ...S.faint }}>
                    <Grid3x3 className="w-3 h-3" />
                    {ISO_COLS} × {ISO_ROWS} × {ISO_LEVELS}
                  </span>
                  <span style={S.chip('#30bf99', 'rgba(14,145,102,0.14)', 'rgba(14,145,102,0.32)')}>Cut-off {cutoffMn.toFixed(0)}%</span>
                </div>
              </div>
              <div style={{ padding: '1rem 1.125rem' }}>
                <BlockModelCanvas cutoffMn={cutoffMn} mineId={activeMine.id} />
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', marginTop: '10px', fontSize: '10px', ...S.faint, lineHeight: 1.55 }}>
                  <Info className="w-3 h-3" style={{ flexShrink: 0, marginTop: '1px' }} />
                  <span>
                    Isometric projection of the kriged block estimate, aggregated to {ISO_COLS} × {ISO_ROWS} × {ISO_LEVELS} display cells
                    (tonnes-weighted Mn%). Cells below cut-off render transparent in ore-only mode. Drag to orbit, hover any cell for its grade, depth
                    and tonnage.
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ ...S.panel, overflow: 'hidden' }}>
              <div style={S.panelHead}>
                <span style={S.title}>
                  <TrendingDown className="w-4 h-4" style={{ color: '#30bf99' }} />
                  Grade–tonnage relationship
                </span>
                <span style={{ ...S.mono, fontSize: '9.5px', ...S.faint }}>Bar = ROM Mt · line = grade</span>
              </div>
              <div style={{ padding: '0.875rem 1.125rem' }}>
                <div style={{ height: '312px' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={gtChartData} margin={{ top: 12, right: 8, left: -14, bottom: 22 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis
                        dataKey="cutOff"
                        tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.38)' }}
                        stroke="rgba(255,255,255,0.12)"
                        label={{ value: 'Cut-off grade (% Mn)', position: 'insideBottom', offset: -14, style: { fontSize: 9, fill: 'rgba(255,255,255,0.38)' } }}
                      />
                      <YAxis
                        yAxisId="tonnes"
                        tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.38)' }}
                        stroke="rgba(255,255,255,0.12)"
                        label={{ value: 'ROM tonnes (Mt)', angle: -90, position: 'insideLeft', offset: 20, style: { fontSize: 9, fill: 'rgba(255,255,255,0.38)' } }}
                      />
                      <YAxis
                        yAxisId="grade"
                        orientation="right"
                        domain={[0, 50]}
                        tick={{ fontSize: 9, fill: 'rgba(255,179,64,0.75)' }}
                        stroke="rgba(255,255,255,0.12)"
                        label={{ value: 'Grade (% Mn)', angle: 90, position: 'insideRight', offset: 16, style: { fontSize: 9, fill: 'rgba(255,179,64,0.7)' } }}
                      />
                      <Tooltip
                        contentStyle={{ background: '#3a3a3c', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: '8px', color: 'rgba(255,255,255,0.9)', fontSize: '11px', fontFamily: 'JetBrains Mono, monospace' }}
                        formatter={(v: number, name: string) => [name === 'Grade' ? `${v}% Mn` : `${v} Mt`, name]}
                      />
                      <ReferenceLine
                        yAxisId="tonnes"
                        x={currentGtPoint.cutOff}
                        stroke="rgba(255,255,255,0.45)"
                        strokeDasharray="4 4"
                        label={{ value: 'current', fill: 'rgba(255,255,255,0.55)', fontSize: 9, position: 'top' }}
                      />
                      <Bar yAxisId="tonnes" dataKey="tonnes" name="ROM tonnes" radius={[3, 3, 0, 0]} maxBarSize={34}>
                        {gtChartData.map((d) => (
                          <Cell key={d.cutOff} fill={d.cutOff === currentGtPoint.cutOff ? '#0e9166' : 'rgba(14,145,102,0.32)'} />
                        ))}
                      </Bar>
                      <Line yAxisId="tonnes" type="monotone" dataKey="p90" name="P90" stroke="rgba(255,255,255,0.22)" strokeDasharray="3 4" dot={false} strokeWidth={1.2} />
                      <Line yAxisId="tonnes" type="monotone" dataKey="p10" name="P10" stroke="rgba(255,255,255,0.22)" strokeDasharray="3 4" dot={false} strokeWidth={1.2} />
                      <Line yAxisId="grade" type="monotone" dataKey="grade" name="Grade" stroke="#ffb340" strokeWidth={2} dot={{ r: 2, fill: '#ffb340' }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginTop: '4px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '9.5px', ...S.muted }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ width: '9px', height: '9px', borderRadius: '2px', background: '#0e9166' }} /> Active cut-off</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ width: '9px', height: '2px', background: '#ffb340' }} /> Grade</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><span style={{ width: '9px', height: '2px', background: 'rgba(255,255,255,0.25)' }} /> P10 / P90</span>
                  </div>
                  <span style={{ ...S.mono, fontSize: '9.5px', ...S.faint }}>{num(currentGtPoint.blocks)} blocks above cut-off</span>
                </div>
              </div>
            </div>
          )}

          {/* UNFC classification */}
          <div style={{ ...S.panel, overflow: 'hidden' }}>
            <div style={S.panelHead}>
              <span style={S.title}>
                <Layers className="w-4 h-4" style={{ color: '#30bf99' }} />
                UNFC-2009 reserve classification
              </span>
              <span style={{ ...S.mono, fontSize: '9.5px', ...S.faint }}>At {currentGtPoint.cutOff.toFixed(0)}% Mn · indicative</span>
            </div>

            <div style={{ padding: '0.875rem 1.125rem', display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
              {/* Stacked classification bar */}
              <div>
                <div style={{ display: 'flex', height: '8px', borderRadius: '99px', overflow: 'hidden', border: '0.5px solid rgba(255,255,255,0.08)' }}>
                  {categoryCards.map((c) => (
                    <div
                      key={c.code}
                      title={`UNFC ${c.code} · ${(c.tonnes / 1e6).toFixed(2)} Mt`}
                      style={{ width: `${(c.tonnes / categoryTotal) * 100}%`, background: c.color, opacity: 0.85, transition: 'width 300ms cubic-bezier(0.22,0.75,0.24,1)' }}
                    />
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '5px', fontSize: '9px', ...S.faint }}>
                  <span>Measured {((summary.measuredTonnes / (categoryTotal || 1)) * 100).toFixed(0)}%</span>
                  <span>Indicated {((summary.indicatedTonnes / (categoryTotal || 1)) * 100).toFixed(0)}%</span>
                  <span>Inferred {((summary.inferredTonnes / (categoryTotal || 1)) * 100).toFixed(0)}%</span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: '8px' }}>
                {categoryCards.map((c) => (
                  <div key={c.code} style={{ padding: '0.75rem 0.875rem', borderRadius: '9px', background: 'rgba(255,255,255,0.035)', border: '0.5px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ width: '3px', height: '12px', borderRadius: '2px', background: c.color }} />
                        <span style={{ ...S.mono, fontSize: '10px', fontWeight: 700, color: c.color }}>UNFC {c.code}</span>
                        <span style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.75)' }}>{c.label}</span>
                      </span>
                      <span style={S.chip(c.color, `${c.color}1c`, `${c.color}55`)}>{c.confidence}</span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                      <span style={{ ...S.mono, fontSize: '19px', fontWeight: 700, color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.02em' }}>
                        {(c.tonnes / 1e6).toFixed(2)} <span style={{ fontSize: '10px', fontWeight: 500, ...S.muted }}>Mt</span>
                      </span>
                      <span style={{ ...S.mono, fontSize: '11px', fontWeight: 700, color: c.color }}>{c.grade.toFixed(1)}% Mn</span>
                    </div>

                    <div style={{ height: '3px', background: 'rgba(255,255,255,0.06)', borderRadius: '99px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${((c.tonnes / categoryTotal) * 100).toFixed(0)}%`, background: c.color, borderRadius: '99px' }} />
                    </div>

                    <p style={{ fontSize: '9.5px', ...S.faint, lineHeight: 1.45 }}>{c.note}</p>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', fontSize: '9.5px', ...S.faint, lineHeight: 1.55 }}>
                <Info className="w-3 h-3" style={{ flexShrink: 0, marginTop: '1px', color: '#5eaaff' }} />
                <span>
                  Category tonnages are decision aids computed from kriged blocks at the selected cut-off. Declared reserves remain the responsibility of a
                  qualified person under UNFC-2009 / JORC reporting.
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
