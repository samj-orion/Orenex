import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  Zap,
  ChevronRight,
  Bot,
  Target,
  Globe,
  ArrowUpRight,
} from 'lucide-react';
import { GeoMapPanel } from './GeoMapPanel';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { MINES } from '../core/geology';
import { buildAlerts, forecastMine, actionCards } from '../core/forecast';
import { reserveSummary, estimateFor } from '../core/reserves';

interface OverviewTabProps {
  selectedMineId: string;
  setActiveTab: (tab: any) => void;
  onSelectAction: (actionId: string) => void;
  onOpenAssistant: () => void;
}

// ── Shared dark panel style ────────────────────────────────────────────────
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
    padding: '0.875rem 1.125rem',
    borderBottom: '0.5px solid rgba(255,255,255,0.07)',
  } as React.CSSProperties,

  panelTitle: {
    fontSize: '13px',
    fontWeight: 600,
    letterSpacing: '-0.008em',
    color: 'rgba(255,255,255,0.92)',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  } as React.CSSProperties,

  label: { fontSize: '11px', color: 'rgba(255,255,255,0.38)', marginBottom: '4px' } as React.CSSProperties,
  mono: { fontFamily: 'JetBrains Mono, monospace' } as React.CSSProperties,

  ghostBtn: {
    background: 'transparent',
    border: 'none',
    color: 'rgba(255,255,255,0.38)',
    fontSize: '11.5px',
    fontWeight: 500,
    cursor: 'pointer',
    padding: '0',
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
  } as React.CSSProperties,

  primaryBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    background: 'linear-gradient(160deg, #17a87e, #0a7a54)',
    border: '0.5px solid rgba(255,255,255,0.12)',
    borderRadius: '7px',
    padding: '0.375rem 0.875rem',
    fontSize: '12px',
    fontWeight: 600,
    color: '#fff',
    cursor: 'pointer',
    boxShadow: '0 1px 4px rgba(14,145,102,0.4)',
    transition: 'all 130ms ease',
  } as React.CSSProperties,

  chip: (color: 'green' | 'red' | 'amber' | 'blue' | 'gray') => {
    const map = {
      green: { bg: 'rgba(14,145,102,0.15)', border: 'rgba(14,145,102,0.35)', color: '#30bf99' },
      red:   { bg: 'rgba(255,59,48,0.13)',  border: 'rgba(255,59,48,0.30)',  color: '#ff6b6b' },
      amber: { bg: 'rgba(255,159,10,0.13)', border: 'rgba(255,159,10,0.30)', color: '#ffb340' },
      blue:  { bg: 'rgba(0,122,255,0.13)',  border: 'rgba(0,122,255,0.30)',  color: '#5eaaff' },
      gray:  { bg: 'rgba(255,255,255,0.07)',border: 'rgba(255,255,255,0.14)',color: 'rgba(255,255,255,0.50)' },
    }[color];
    return {
      display: 'inline-flex', alignItems: 'center', gap: '3px',
      background: map.bg, border: `0.5px solid ${map.border}`,
      borderRadius: '999px', padding: '1px 8px',
      fontSize: '10px', fontWeight: 600, color: map.color,
      textTransform: 'uppercase', letterSpacing: '0.05em',
    } as React.CSSProperties;
  },

  progressTrack: {
    width: '100%', height: '4px', background: 'rgba(255,255,255,0.08)',
    borderRadius: '99px', overflow: 'hidden',
  } as React.CSSProperties,
};

// ── Company-Wide Production Bar ───────────────────────────────────────────
const CompanyProductionBar: React.FC<{ setActiveTab: (tab: any) => void }> = ({ setActiveTab }) => {
  const allMines = MINES.map((m) => {
    const fc = forecastMine(m.id);
    return {
      name: m.code,
      plan7:      fc.planTotal7,
      p50:        fc.days.slice(0, 7).reduce((s, d) => s + d.p50, 0),
      pShort7:    fc.pShort7,
      shortfallT7:fc.shortfallT7,
    };
  });

  const totalPlan     = allMines.reduce((s, m) => s + m.plan7, 0);
  const totalForecast = allMines.reduce((s, m) => s + m.p50,   0);
  const attainment    = (totalForecast / totalPlan * 100).toFixed(1);
  const att           = parseFloat(attainment);

  return (
    <div style={S.panel}>
      <div style={S.panelHead}>
        <h3 style={S.panelTitle}>
          <Target style={{ width: '14px', height: '14px', color: '#30bf99' }} />
          Company-Wide Production — 7-Day Rolling Snapshot
        </h3>
        <button onClick={() => setActiveTab('forecast')} style={S.ghostBtn}>
          Detailed Forecast <ArrowUpRight style={{ width: '11px', height: '11px' }} />
        </button>
      </div>

      <div style={{ padding: '1rem 1.125rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* KPI row */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
          {[
            { label: '7-Day Plan',   value: `${(totalPlan / 1000).toFixed(0)}k t`,     color: 'rgba(255,255,255,0.88)' },
            { label: 'P50 Forecast', value: `${(totalForecast / 1000).toFixed(0)}k t`, color: '#30bf99' },
            {
              label: 'Attainment', value: `${attainment}%`,
              color: att >= 95 ? '#30bf99' : att >= 85 ? '#ffb340' : '#ff6b6b',
            },
          ].map((kpi) => (
            <div key={kpi.label} style={{
              background: 'rgba(255,255,255,0.04)',
              border: '0.5px solid rgba(255,255,255,0.07)',
              borderRadius: '8px',
              padding: '0.625rem 0.75rem',
              textAlign: 'center',
            }}>
              <div style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.38)', marginBottom: '4px' }}>{kpi.label}</div>
              <div style={{ fontSize: '19px', fontWeight: 700, ...S.mono, color: kpi.color, letterSpacing: '-0.02em' }}>
                {kpi.value}
              </div>
            </div>
          ))}
        </div>

        {/* Per-mine progress */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
          {allMines.map((m) => {
            const pct = Math.min(100, (m.p50 / m.plan7) * 100);
            const barColor = pct >= 90 ? '#30bf99' : pct >= 80 ? '#ffb340' : '#ff6b6b';
            return (
              <div key={m.name}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                  <span style={{ fontSize: '11.5px', fontWeight: 600, ...S.mono, color: 'rgba(255,255,255,0.75)' }}>
                    {m.name}
                  </span>
                  <div style={{ display: 'flex', gap: '0.75rem', ...S.mono, fontSize: '11px' }}>
                    <span style={{ color: 'rgba(255,255,255,0.35)' }}>
                      Plan: {(m.plan7 / 1000).toFixed(0)}k t
                    </span>
                    <span style={{ fontWeight: 700, color: m.shortfallT7 > 0 ? '#ff6b6b' : '#30bf99' }}>
                      {m.shortfallT7 > 0 ? `-${m.shortfallT7.toLocaleString()} t` : '✓ On Track'}
                    </span>
                    <span style={{ fontWeight: 700, color: barColor }}>{pct.toFixed(0)}%</span>
                  </div>
                </div>
                <div style={S.progressTrack}>
                  <div style={{
                    height: '100%', borderRadius: '99px',
                    width: `${pct}%`,
                    background: barColor,
                    transition: 'width 700ms ease',
                    boxShadow: `0 0 6px ${barColor}60`,
                  }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ── Custom Recharts Tooltip ───────────────────────────────────────────────
const DarkTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: '#3a3a3c',
      border: '0.5px solid rgba(255,255,255,0.14)',
      borderRadius: '9px',
      padding: '8px 12px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
      fontSize: '11px',
      color: 'rgba(255,255,255,0.88)',
      fontFamily: 'JetBrains Mono, monospace',
    }}>
      <div style={{ fontWeight: 600, marginBottom: '4px', color: 'rgba(255,255,255,0.55)' }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ display: 'flex', justifyContent: 'space-between', gap: '16px' }}>
          <span style={{ color: p.stroke || p.fill || 'rgba(255,255,255,0.55)' }}>{p.name}</span>
          <span style={{ fontWeight: 600 }}>{p.value?.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
};

// ── Main Component ────────────────────────────────────────────────────────
export const OverviewTab: React.FC<OverviewTabProps> = ({
  selectedMineId,
  setActiveTab,
  onSelectAction,
  onOpenAssistant,
}) => {
  const alerts        = buildAlerts();
  const activeMine    = MINES.find((m) => m.id === (selectedMineId === 'ALL' ? 'MNE-BAL' : selectedMineId)) || MINES[0];

  const [copilotQuery, setCopilotQuery] = useState<string>('');

  const forecast   = forecastMine(activeMine.id);
  const estimate   = estimateFor(activeMine.id);
  const unfc       = reserveSummary(estimate, 18);
  const urgentCards = actionCards(alerts[0] || buildAlerts()[0]);

  const chartData = forecast.days.slice(0, 21).map((d) => ({
    date:   d.date.slice(5),
    plan:   d.planT,
    p50:    d.p50,
    p10:    d.p10,
    p90:    d.p90,
    pShort: Math.round(d.pShort * 100),
  }));

  const totalProvedReserves = (unfc.measuredTonnes + unfc.indicatedTonnes) / 1e6;
  const avgGrade  = unfc.meanGradeMn;
  const ociMonths = Math.round(((unfc.measuredTonnes + unfc.indicatedTonnes) / (activeMine.designTpd * 365)) * 12);

  const kpiCards = [
    {
      label: 'Ore Continuity Index',
      badge: { label: 'OCI Live', color: 'green' as const },
      value: `${ociMonths}`,
      unit: 'mo',
      sub: `Months of ore cover at ${activeMine.designTpd.toLocaleString()} t/d`,
      statusColor: ociMonths > 24 ? '#30bf99' : ociMonths > 12 ? '#ffb340' : '#ff6b6b',
      statusLabel: ociMonths > 24 ? 'Adequate' : ociMonths > 12 ? 'Marginal' : 'Critical',
      progressPct: Math.min(100, (ociMonths / 36) * 100),
      onClick: () => setActiveTab('reserves'),
    },
    {
      label: '7-Day Predicted Shortfall',
      badge: {
        label: `P(miss) ${(forecast.pShort7 * 100).toFixed(0)}%`,
        color: (forecast.pShort7 > 0.3 ? 'red' : forecast.pShort7 > 0.15 ? 'amber' : 'green') as 'green' | 'red' | 'amber',
      },
      value: `-${forecast.shortfallT7.toLocaleString()}`,
      unit: 't',
      sub: `Plan: ${forecast.planTotal7.toLocaleString()} t`,
      statusColor: '#ff6b6b',
      statusLabel: null,
      progressPct: null,
      onClick: () => setActiveTab('forecast'),
    },
    {
      label: 'UNFC Contained Reserve',
      badge: { label: 'D4 Kriging', color: 'blue' as const },
      value: `${totalProvedReserves.toFixed(2)}`,
      unit: 'Mt',
      sub: `UNFC 111+122 · ${activeMine.code}`,
      statusColor: '#30bf99',
      statusLabel: `${avgGrade.toFixed(1)}% Mn`,
      progressPct: 62,
      onClick: () => setActiveTab('reserves'),
    },
    {
      label: 'Governance & Model Health',
      badge: { label: 'All Stable', color: 'green' as const },
      value: '10',
      unit: ' Models',
      sub: '15 Data feeds · Sentinel-2, GPM, CMMS OK',
      statusColor: '#30bf99',
      statusLabel: '0 Degraded',
      progressPct: null,
      onClick: undefined,
    },
  ];

  return (
    <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', background: '#161618', minHeight: '100vh' }}>

      {/* ── GEO Map Hero ──────────────────────────────────────────────────── */}
      <div style={{
        background: '#0b1220',
        border: '0.5px solid rgba(30,58,95,0.8)',
        borderRadius: '14px',
        overflow: 'hidden',
        boxShadow: '0 4px 24px rgba(0,0,0,0.7)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.75rem 1.125rem',
          borderBottom: '0.5px solid rgba(30,58,95,0.7)',
          background: 'rgba(11,18,32,0.8)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Globe style={{ width: '14px', height: '14px', color: '#5eaaff' }} />
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', letterSpacing: '-0.01em' }}>
              Live Mn Prospectivity Map
            </span>
            <span style={{
              fontSize: '9.5px', fontFamily: 'JetBrains Mono, monospace',
              background: 'rgba(48,191,153,0.12)', color: '#30bf99',
              border: '0.5px solid rgba(48,191,153,0.3)',
              padding: '1px 8px', borderRadius: '99px',
              textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>
              PU-XGBoost · AUC 0.881
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '10px', fontFamily: 'JetBrains Mono, monospace', color: 'rgba(255,255,255,0.38)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#7f1d1d', display: 'inline-block' }} />
              High Mn
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#d97706', display: 'inline-block' }} />
              Very High
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#fbbf24', border: '1px solid #fbbf24', display: 'inline-block' }} />
              Active Mine
            </span>
          </div>
        </div>
        <div style={{ height: '560px', position: 'relative' }}>
          <GeoMapPanel selectedMineId={selectedMineId} />
        </div>
      </div>

      {/* ── KPI Banner ────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '0.875rem' }}>
        {kpiCards.map((kpi) => (
          <div
            key={kpi.label}
            onClick={kpi.onClick}
            style={{
              ...S.panel,
              padding: '1rem 1.125rem',
              cursor: kpi.onClick ? 'pointer' : 'default',
              transition: 'transform 120ms ease, box-shadow 120ms ease',
            }}
            onMouseEnter={(e) => {
              if (kpi.onClick) {
                (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-1px)';
                (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.6)';
              }
            }}
            onMouseLeave={(e) => {
              if (kpi.onClick) {
                (e.currentTarget as HTMLDivElement).style.transform = '';
                (e.currentTarget as HTMLDivElement).style.boxShadow = (S.panel.boxShadow as string);
              }
            }}
          >
            {/* Row 1: label + chip */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.625rem' }}>
              <span style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.35)' }}>
                {kpi.label}
              </span>
              <span style={S.chip(kpi.badge.color)}>{kpi.badge.label}</span>
            </div>
            {/* Row 2: big value */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '3px', marginBottom: '0.625rem' }}>
              <span style={{ fontSize: '26px', fontWeight: 700, ...S.mono, color: kpi.statusColor, letterSpacing: '-0.03em', lineHeight: 1 }}>
                {kpi.value}
              </span>
              <span style={{ fontSize: '14px', fontWeight: 500, color: 'rgba(255,255,255,0.45)', marginLeft: '1px' }}>
                {kpi.unit}
              </span>
              {kpi.statusLabel && (
                <span style={{ marginLeft: 'auto', fontSize: '11px', fontWeight: 600, color: kpi.statusColor }}>
                  {kpi.statusLabel}
                </span>
              )}
            </div>
            {/* Progress bar */}
            {kpi.progressPct !== null && (
              <div style={{ ...S.progressTrack, marginBottom: '6px' }}>
                <div style={{
                  height: '100%', borderRadius: '99px',
                  width: `${kpi.progressPct}%`,
                  background: kpi.statusColor,
                  boxShadow: `0 0 6px ${kpi.statusColor}60`,
                }} />
              </div>
            )}
            {/* Model chips for governance card */}
            {kpi.label === 'Governance & Model Health' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '4px', marginBottom: '6px' }}>
                {['Kriging','LightGBM','Weibull','Recon','PU-XGB','CMMS'].map((m) => (
                  <span key={m} style={{
                    fontSize: '9px', fontFamily: 'JetBrains Mono, monospace',
                    background: 'rgba(14,145,102,0.12)', color: '#30bf99',
                    border: '0.5px solid rgba(14,145,102,0.25)',
                    padding: '2px 4px', borderRadius: '4px', textAlign: 'center',
                  }}>
                    {m}
                  </span>
                ))}
              </div>
            )}
            <p style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.28)', marginTop: '2px' }}>{kpi.sub}</p>
          </div>
        ))}
      </div>

      {/* ── Alert Banner ─────────────────────────────────────────────────── */}
      {alerts.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '12px',
          padding: '0.875rem 1.125rem',
          background: 'rgba(255,59,48,0.10)',
          border: '0.5px solid rgba(255,59,48,0.28)',
          borderRadius: '10px',
          boxShadow: '0 0 20px rgba(255,59,48,0.1)',
        }}>
          <AlertTriangle style={{ width: '16px', height: '16px', color: '#ff6b6b', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <span style={{ fontWeight: 700, fontSize: '13px', color: '#ff8585' }}>
              {alerts.length} Active Alert{alerts.length > 1 ? 's' : ''} — Engine triggered corrective action cards
            </span>
            <p style={{ fontSize: '11px', color: 'rgba(255,107,107,0.7)', marginTop: '2px', fontFamily: 'JetBrains Mono, monospace' }}>
              {alerts[0]?.mineId} · P(miss 7d) = {(alerts[0]?.pShort * 100).toFixed(0)}%
              · Shortfall: {alerts[0]?.shortfallT.toLocaleString()} t
              · Bottleneck: {alerts[0]?.bottleneck}
            </p>
          </div>
          <button
            onClick={() => setActiveTab('actions')}
            style={S.primaryBtn}
          >
            View Actions <ArrowUpRight style={{ width: '12px', height: '12px' }} />
          </button>
        </div>
      )}

      {/* ── Main 3-column grid ────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '1.25rem' }}>

        {/* Left Column — Mine cards + Copilot */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ ...S.panelTitle, fontSize: '13px' }}>
              <Activity style={{ width: '14px', height: '14px', color: '#30bf99' }} />
              Mine Site Briefing
            </h2>
            <span style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.25)', fontFamily: 'JetBrains Mono, monospace' }}>
              {MINES.length} Active Sites
            </span>
          </div>

          {MINES.map((mine) => {
            const mineFc    = forecastMine(mine.id);
            const isAlert   = mineFc.pShort7 > 0.2;
            const isSelected = mine.id === activeMine.id;
            const attPct    = Math.max(0, 100 - (mineFc.shortfallT7 / mineFc.planTotal7) * 100);
            const barColor  = mineFc.pShort7 > 0.3 ? '#ff6b6b' : mineFc.pShort7 > 0.15 ? '#ffb340' : '#30bf99';

            return (
              <div
                key={mine.id}
                style={{
                  ...S.panel,
                  padding: '0.875rem 1rem',
                  transition: 'all 140ms ease',
                  outline: isSelected ? '1.5px solid rgba(14,145,102,0.45)' : 'none',
                  outlineOffset: '-1px',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.6)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.boxShadow = (S.panel.boxShadow as string);
                }}
              >
                {/* Mine header */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.625rem' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <h3 style={{ fontSize: '13.5px', fontWeight: 700, color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.01em' }}>
                        {mine.name}
                      </h3>
                      <span style={{
                        fontSize: '9.5px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600,
                        background: 'rgba(255,255,255,0.07)', border: '0.5px solid rgba(255,255,255,0.12)',
                        color: 'rgba(255,255,255,0.50)', padding: '1px 5px', borderRadius: '4px',
                      }}>
                        {mine.code}
                      </span>
                    </div>
                    <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', textTransform: 'capitalize', marginTop: '2px' }}>
                      {mine.miningMethod} · {mine.designTpd} t/d · {mine.feedGradeMn}% Mn
                    </p>
                  </div>
                  <span style={isAlert ? S.chip('red') : S.chip('green')}>
                    {isAlert
                      ? <><AlertTriangle style={{ width: '9px', height: '9px' }} /> Alert</>
                      : <><CheckCircle2 style={{ width: '9px', height: '9px' }} /> Normal</>
                    }
                  </span>
                </div>

                {/* Attainment bar */}
                <div style={{ marginBottom: '0.625rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px', marginBottom: '4px', fontFamily: 'JetBrains Mono, monospace' }}>
                    <span style={{ color: 'rgba(255,255,255,0.35)' }}>7d Attainment</span>
                    <span style={{ fontWeight: 700, color: barColor }}>{attPct.toFixed(0)}%</span>
                  </div>
                  <div style={S.progressTrack}>
                    <div style={{
                      height: '100%', borderRadius: '99px',
                      width: `${attPct}%`, background: barColor,
                      transition: 'width 700ms ease', boxShadow: `0 0 5px ${barColor}60`,
                    }} />
                  </div>
                </div>

                {/* Stats row */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
                  gap: '0.5rem', paddingTop: '0.5rem',
                  borderTop: '0.5px solid rgba(255,255,255,0.07)',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: '10.5px',
                }}>
                  {[
                    { l: '7d Gap',    v: mineFc.shortfallT7 > 0 ? `-${mineFc.shortfallT7}t` : '0t',  c: mineFc.shortfallT7 > 0 ? '#ff6b6b' : '#30bf99' },
                    { l: 'Bottleneck',v: mineFc.bottleneck,                                           c: 'rgba(255,255,255,0.75)' },
                    { l: 'P(miss)',   v: `${(mineFc.pShort7 * 100).toFixed(0)}%`,                    c: 'rgba(255,255,255,0.75)' },
                  ].map((stat) => (
                    <div key={stat.l}>
                      <span style={{ display: 'block', color: 'rgba(255,255,255,0.30)', marginBottom: '2px', fontSize: '9.5px' }}>{stat.l}</span>
                      <span style={{ fontWeight: 700, color: stat.c, textTransform: 'capitalize' }}>{stat.v}</span>
                    </div>
                  ))}
                </div>

                {/* Footer */}
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  marginTop: '0.5rem', paddingTop: '0.5rem',
                  borderTop: '0.5px solid rgba(255,255,255,0.07)',
                }}>
                  <span style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.28)' }}>
                    Plan: {mine.plan.label}
                  </span>
                  <button
                    onClick={() => setActiveTab('forecast')}
                    style={{ ...S.ghostBtn, color: '#30bf99', fontWeight: 600, fontSize: '11px' }}
                  >
                    Forecast <ChevronRight style={{ width: '11px', height: '11px' }} />
                  </button>
                </div>
              </div>
            );
          })}

          {/* AI Copilot card */}
          <div style={{
            background: 'linear-gradient(145deg, #0d2a1e, #0a1f16)',
            border: '0.5px solid rgba(14,145,102,0.28)',
            borderRadius: '12px',
            padding: '1rem',
            boxShadow: '0 2px 12px rgba(14,145,102,0.15)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#30bf99', fontWeight: 600, fontSize: '12.5px', marginBottom: '8px' }}>
              <Bot style={{ width: '14px', height: '14px' }} />
              MOIL AI Mining Copilot
              <span style={{
                fontSize: '9.5px', fontFamily: 'JetBrains Mono, monospace',
                background: 'rgba(14,145,102,0.2)', color: '#30bf99',
                padding: '1px 5px', borderRadius: '4px',
              }}>D1</span>
            </div>
            <p style={{ fontSize: '11.5px', color: 'rgba(255,255,255,0.40)', lineHeight: 1.6, marginBottom: '10px' }}>
              Ask in plain language — "Why is Balaghat haulage the bottleneck?" or "What is the 7-day shortfall?"
            </p>
            <input
              type="text"
              placeholder="Ask the Copilot…"
              value={copilotQuery}
              onChange={(e) => setCopilotQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpenAssistant(); }}
              style={{
                width: '100%',
                background: 'rgba(0,0,0,0.25)',
                border: '0.5px solid rgba(14,145,102,0.30)',
                borderRadius: '7px',
                padding: '0.4375rem 0.75rem',
                fontSize: '12px',
                color: 'rgba(255,255,255,0.88)',
                fontFamily: 'inherit',
                marginBottom: '8px',
                outline: 'none',
              }}
            />
            <button
              onClick={onOpenAssistant}
              style={{
                ...S.primaryBtn,
                width: '100%',
                justifyContent: 'center',
                padding: '0.5rem',
              }}
            >
              Open the Copilot
            </button>
          </div>
        </div>

        {/* Right Column — Charts + Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

          {/* Production Forecast Chart */}
          <div style={S.panel}>
            <div style={S.panelHead}>
              <div>
                <h2 style={S.panelTitle}>
                  <TrendingUp style={{ width: '14px', height: '14px', color: '#30bf99' }} />
                  21-Day Quantile Production Forecast
                  <span style={{
                    fontSize: '10px', background: 'rgba(255,255,255,0.07)', border: '0.5px solid rgba(255,255,255,0.12)',
                    color: 'rgba(255,255,255,0.45)', fontFamily: 'JetBrains Mono, monospace',
                    padding: '1px 7px', borderRadius: '4px',
                  }}>P10 / P50 / P90</span>
                </h2>
                <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.30)', marginTop: '2px', fontFamily: 'JetBrains Mono, monospace' }}>
                  {activeMine.name} · Physical Bottleneck Model (D6) · m5-v6.3.0
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '10.5px', fontFamily: 'JetBrains Mono, monospace' }}>
                {[
                  { color: '#0e9166', label: 'P50' },
                  { color: '#ff6b6b', label: 'Plan', dashed: true },
                  { color: 'rgba(14,145,102,0.3)', label: 'Band', square: true },
                ].map((leg) => (
                  <span key={leg.label} style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'rgba(255,255,255,0.38)' }}>
                    {leg.square
                      ? <span style={{ width: '10px', height: '10px', background: leg.color, borderRadius: '2px' }} />
                      : <span style={{ width: '14px', height: '2px', background: leg.color, borderRadius: '1px', borderTop: leg.dashed ? '2px dashed' : undefined }} />
                    }
                    {leg.label}
                  </span>
                ))}
              </div>
            </div>

            <div style={{ padding: '1rem 1.125rem' }}>
              <div style={{ height: '220px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 6, right: 8, left: -22, bottom: 0 }}>
                    <defs>
                      <linearGradient id="pBand" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#0e9166" stopOpacity={0.30} />
                        <stop offset="95%" stopColor="#0e9166" stopOpacity={0.03} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="date" tick={{ fontSize: 9.5, fill: 'rgba(255,255,255,0.30)', fontFamily: 'JetBrains Mono, monospace' }} />
                    <YAxis tick={{ fontSize: 9.5, fill: 'rgba(255,255,255,0.30)', fontFamily: 'JetBrains Mono, monospace' }} domain={['dataMin - 100', 'dataMax + 100']} />
                    <Tooltip content={<DarkTooltip />} />
                    <Area type="monotone" dataKey="p90" stroke="transparent" fill="#0e9166" fillOpacity={0.12} />
                    <Area type="monotone" dataKey="p10" stroke="transparent" fill="#161618" fillOpacity={1} />
                    <Area type="monotone" dataKey="p50" stroke="#0e9166" strokeWidth={2.5} fill="url(#pBand)" name="P50 Forecast (t)" />
                    <Area type="monotone" dataKey="plan" stroke="#ff6b6b" strokeWidth={1.8} strokeDasharray="5 3" fill="none" name="Plan Target (t)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div style={{
                marginTop: '0.875rem', paddingTop: '0.75rem',
                borderTop: '0.5px solid rgba(255,255,255,0.07)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                fontSize: '11px', color: 'rgba(255,255,255,0.35)',
              }}>
                <span>
                  Primary Driver:{' '}
                  <strong style={{ color: 'rgba(255,255,255,0.75)', fontFamily: 'JetBrains Mono, monospace' }}>
                    {forecast.causeMix[0]?.bucket.toUpperCase()}
                  </strong>
                  {' '}({forecast.causeMix[0]?.tonnes.toLocaleString()} t lost)
                </span>
                <span>
                  Coverage:{' '}
                  <strong style={{ color: '#30bf99', fontFamily: 'JetBrains Mono, monospace' }}>
                    {(forecast.coverage * 100).toFixed(0)}%
                  </strong>
                </span>
                <button onClick={() => setActiveTab('forecast')} style={{ ...S.ghostBtn, color: '#30bf99', fontWeight: 600 }}>
                  Full Forecast <ChevronRight style={{ width: '11px', height: '11px' }} />
                </button>
              </div>
            </div>
          </div>

          {/* Company-Wide Production Bar */}
          <CompanyProductionBar setActiveTab={setActiveTab} />

          {/* Urgent Corrective Actions */}
          <div style={S.panel}>
            <div style={S.panelHead}>
              <div>
                <h2 style={S.panelTitle}>
                  <Zap style={{ width: '14px', height: '14px', color: '#ffb340' }} />
                  Top-Ranked Corrective Actions
                  <span style={{
                    fontSize: '10px', background: 'rgba(255,159,10,0.12)', border: '0.5px solid rgba(255,159,10,0.25)',
                    color: '#ffb340', fontFamily: 'JetBrains Mono, monospace', padding: '1px 7px', borderRadius: '4px',
                  }}>D7 Engine</span>
                </h2>
                <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.30)', marginTop: '2px' }}>
                  Ranked by tonnes shortfall recovered per ₹ Lakh invested
                </p>
              </div>
              <button onClick={() => setActiveTab('actions')} style={S.ghostBtn}>
                View All <ArrowUpRight style={{ width: '11px', height: '11px' }} />
              </button>
            </div>

            <div style={{ padding: '0.875rem 1.125rem', display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              {urgentCards.slice(0, 3).map((card, i) => (
                <div
                  key={card.id}
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '0.5px solid rgba(255,255,255,0.08)',
                    borderRadius: '9px',
                    padding: '0.75rem 0.875rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '1rem',
                    transition: 'all 120ms ease',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.055)';
                    (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.13)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)';
                    (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.08)';
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <span style={{
                        fontSize: '9px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700,
                        color: '#30bf99', background: 'rgba(14,145,102,0.15)',
                        border: '0.5px solid rgba(14,145,102,0.3)',
                        padding: '1px 6px', borderRadius: '4px',
                      }}>#{i + 1}</span>
                      <span style={S.chip('green')}>+{card.predictedGainT.toLocaleString()} t</span>
                      <span style={S.chip('gray')}>₹{card.costLakh} L</span>
                      <span style={{ fontSize: '10px', fontFamily: 'JetBrains Mono, monospace', color: 'rgba(255,255,255,0.25)' }}>
                        {card.gainPerLakh} t/₹L
                      </span>
                    </div>
                    <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', letterSpacing: '-0.008em' }}>
                      {card.title}
                    </h3>
                    <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {card.rationale}
                    </p>
                  </div>
                  <button
                    onClick={() => { onSelectAction(card.id); setActiveTab('actions'); }}
                    style={{ ...S.primaryBtn, fontSize: '11.5px', flexShrink: 0 }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = 'linear-gradient(160deg, #1dc08f, #0e9166)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = 'linear-gradient(160deg, #17a87e, #0a7a54)';
                    }}
                  >
                    Execute <ArrowUpRight style={{ width: '11px', height: '11px' }} />
                  </button>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
};
