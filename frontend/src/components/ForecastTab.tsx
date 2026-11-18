import React, { useState } from 'react';
import {
  TrendingUp,
  Gauge,
  Truck,
  BarChart3,
  Activity,
  CloudRain,
} from 'lucide-react';
import {
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Line,
  ComposedChart,
  Area,
  Bar,
  ReferenceLine,
  Legend,
} from 'recharts';
import { MINES } from '../core/geology';
import { forecastMine, alertTriggerFor } from '../core/forecast';
import { STAGE_LABEL, fleetFor } from '../core/operations';

interface ForecastTabProps {
  selectedMineId: string;
}

/* ─── Synthetic "actual" production (last 14 days) ──────────────────────── */
function buildPlanActualData(forecast: ReturnType<typeof forecastMine>) {
  const past = 14;
  const future = 21;

  // Simulate past "actual" values with noise around plan
  const pastData = Array.from({ length: past }, (_, i) => {
    const planT = forecast.days[0]?.planT ?? 3500;
    const seed = i * 37 + 19;
    const noise = ((seed % 100) / 100 - 0.45) * 0.18;
    const actualT = Math.round(planT * (1 + noise));
    const shortfall = actualT - planT;
    return {
      date: `D-${past - i}`,
      plan: planT,
      actual: actualT,
      forecast: null as number | null,
      p10: null as number | null,
      p90: null as number | null,
      isPast: true,
      shortfall,
    };
  });

  // Future forecast
  const futureData = forecast.days.slice(0, future).map((d, i) => ({
    date: i === 0 ? 'Today' : d.date.slice(5),
    plan: d.planT,
    actual: null as number | null,
    forecast: d.p50,
    p10: d.p10,
    p90: d.p90,
    isPast: false,
    shortfall: d.p50 - d.planT,
  }));

  return [...pastData.reverse(), ...futureData];
}

/* ─── Stage Bottleneck Ring Gauge ───────────────────────────────────────── */
const StageGauge: React.FC<{ stage: string; label: string; capacity: number; available: number; isBottleneck: boolean }> = ({
  label, capacity, available, isBottleneck,
}) => {
  const pct = Math.min(100, (available / capacity) * 100);
  const r = 26;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  const color = isBottleneck ? '#ff6b6b' : pct > 80 ? '#30bf99' : '#ffb340';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px',
      borderRadius: '8px', border: `0.5px solid ${isBottleneck ? 'rgba(255,59,48,0.35)' : 'rgba(255,255,255,0.1)'}`,
      background: isBottleneck ? 'rgba(255,59,48,0.10)' : 'rgba(255,255,255,0.04)',
      transition: 'all 150ms ease',
    }}>
      <div style={{ position: 'relative', width: '60px', height: '60px' }}>
        <svg viewBox="0 0 60 60" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
          <circle cx={30} cy={30} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={5} />
          <circle
            cx={30} cy={30} r={r} fill="none"
            stroke={color} strokeWidth={5}
            strokeDasharray={`${dash.toFixed(1)} ${(circ - dash).toFixed(1)}`}
            strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 0.6s ease', filter: `drop-shadow(0 0 4px ${color}80)` }}
          />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color }}>{pct.toFixed(0)}%</span>
        </div>
      </div>
      <span style={{ fontSize: '9.5px', fontWeight: 600, marginTop: '5px', textAlign: 'center', lineHeight: 1.3, color: isBottleneck ? '#ff6b6b' : 'rgba(255,255,255,0.55)' }}>
        {label}
      </span>
      {isBottleneck && (
        <span style={{ fontSize: '8.5px', background: 'rgba(255,59,48,0.18)', color: '#ff6b6b', padding: '1px 6px', borderRadius: '99px', marginTop: '4px', fontWeight: 700 }}>BOTTLENECK</span>
      )}
    </div>
  );
};

/* ─── Main Component ────────────────────────────────────────────────────── */
export const ForecastTab: React.FC<ForecastTabProps> = ({ selectedMineId }) => {
  const activeMineId = selectedMineId === 'ALL' ? 'MNE-BAL' : selectedMineId;
  const activeMine = MINES.find((m) => m.id === activeMineId) || MINES[0];

  const [horizonDays, setHorizonDays] = useState<7 | 30>(7);
  const [chartMode, setChartMode] = useState<'quantile' | 'planActual' | 'rain'>('planActual');

  const forecast = forecastMine(activeMine.id);
  const fleet = fleetFor(activeMine.id);

  const quantileData = forecast.days.slice(0, horizonDays === 7 ? 7 : 30).map((d) => ({
    date: d.date.slice(5),
    plan: d.planT,
    p50: d.p50,
    p10: d.p10,
    p90: d.p90,
    pShort: Math.round(d.pShort * 100),
    rain: d.weather.rainMm,
  }));

  const planActualData = buildPlanActualData(forecast);

  const triggerP = alertTriggerFor(activeMine.id);
  const currentPShort = horizonDays === 7 ? forecast.pShort7 : forecast.pShort30;
  const currentShortfall = horizonDays === 7 ? forecast.shortfallT7 : forecast.shortfallT30;

  // Company-wide performance
  const allMineForecasts = MINES.map((m) => ({
    mine: m.name,
    shortName: m.code,
    plan: m.designTpd * 7,
    p50: forecastMine(m.id).days.slice(0, 7).reduce((s, d) => s + d.p50, 0),
    pShort7: forecastMine(m.id).pShort7,
  }));

  return (
    <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', background: '#161618', minHeight: '100vh' }}>
      {/* Top Banner */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between',
        gap: '1rem', background: '#2c2c2e',
        border: '0.5px solid rgba(255,255,255,0.09)', borderRadius: '12px',
        padding: '1rem 1.125rem', boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
      }}>
        <div>
          <h2 style={{ fontSize: '14px', fontWeight: 700, color: 'rgba(255,255,255,0.92)', display: 'flex', alignItems: 'center', gap: '7px', letterSpacing: '-0.01em' }}>
            <TrendingUp style={{ width: '15px', height: '15px', color: '#30bf99' }} />
            Production Shortfall Forecast &amp; Physical Bottleneck Engine
            <span style={{ fontSize: '10px', fontFamily: 'JetBrains Mono, monospace', background: 'rgba(14,145,102,0.15)', color: '#30bf99', border: '0.5px solid rgba(14,145,102,0.35)', padding: '1px 7px', borderRadius: '4px' }}>D6</span>
          </h2>
          <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginTop: '3px', fontFamily: 'JetBrains Mono, monospace' }}>
            LightGBM Quantile Regression + Physical Circuit Model · {activeMine.name} ({activeMine.code})
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {/* Horizon toggle */}
          <div style={{ display: 'flex', background: 'rgba(255,255,255,0.06)', borderRadius: '7px', padding: '3px', border: '0.5px solid rgba(255,255,255,0.1)', gap: '2px' }}>
            {([7, 30] as const).map((d) => (
              <button key={d} onClick={() => setHorizonDays(d)} style={{
                padding: '0.25rem 0.75rem', fontSize: '12px', fontWeight: 600, borderRadius: '5px',
                border: 'none', cursor: 'pointer', transition: 'all 120ms ease',
                background: horizonDays === d ? '#3a3a3c' : 'transparent',
                color: horizonDays === d ? '#30bf99' : 'rgba(255,255,255,0.40)',
                boxShadow: horizonDays === d ? '0 1px 3px rgba(0,0,0,0.4)' : 'none',
                fontFamily: 'inherit',
              }}>{d}-Day</button>
            ))}
          </div>

          {/* Chart mode */}
          <div style={{ display: 'flex', background: 'rgba(255,255,255,0.06)', borderRadius: '7px', padding: '3px', border: '0.5px solid rgba(255,255,255,0.1)', gap: '2px' }}>
            {([
              { id: 'planActual', label: 'Plan vs Actual', icon: <Activity style={{ width: '11px', height: '11px' }} /> },
              { id: 'quantile',   label: 'Quantile Band',  icon: <TrendingUp style={{ width: '11px', height: '11px' }} /> },
              { id: 'rain',       label: 'Rain Overlay',   icon: <CloudRain style={{ width: '11px', height: '11px' }} /> },
            ] as const).map((m) => (
              <button key={m.id} onClick={() => setChartMode(m.id)} style={{
                display: 'flex', alignItems: 'center', gap: '4px',
                padding: '0.25rem 0.625rem', fontSize: '11.5px', fontWeight: 600,
                borderRadius: '5px', border: 'none', cursor: 'pointer', transition: 'all 120ms ease',
                background: chartMode === m.id ? '#3a3a3c' : 'transparent',
                color: chartMode === m.id ? '#30bf99' : 'rgba(255,255,255,0.40)',
                boxShadow: chartMode === m.id ? '0 1px 3px rgba(0,0,0,0.4)' : 'none',
                fontFamily: 'inherit', whiteSpace: 'nowrap',
              }}>{m.icon}{m.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '0.875rem' }}>
        {[
          { label: `${horizonDays}-Day Shortfall`, value: `-${currentShortfall.toLocaleString()} t`, sub: `P(miss) = ${(currentPShort * 100).toFixed(0)}%`, color: '#ff6b6b' },
          { label: 'Binding Constraint', value: forecast.bottleneck, sub: 'Physical circuit model', color: 'rgba(255,255,255,0.88)', cap: true },
          { label: 'Plan Attainment (7d)', value: `${(100-(forecast.shortfallT7/forecast.planTotal7)*100).toFixed(1)}%`, sub: `Plan: ${forecast.planTotal7.toLocaleString()} t`, color: '#30bf99' },
          { label: 'Lead Time Warning', value: forecast.leadTimeDays ? `${forecast.leadTimeDays}d` : 'Now', sub: forecast.leadTimeDays ? `${forecast.leadTimeDays}d before breach` : 'Immediate action', color: '#ffb340' },
        ].map((k) => (
          <div key={k.label} style={{ background: '#2c2c2e', border: '0.5px solid rgba(255,255,255,0.09)', borderRadius: '10px', padding: '1rem 1.125rem', boxShadow: '0 2px 8px rgba(0,0,0,0.4)' }}>
            <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.35)', marginBottom: '6px' }}>{k.label}</div>
            <div style={{ fontSize: '22px', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: k.color, letterSpacing: '-0.02em', textTransform: k.cap ? 'capitalize' : undefined }}>{k.value}</div>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.38)', marginTop: '4px' }}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Main Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '1.25rem' }}>
        {/* Left Column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* Stage Circuit Gauges */}
          <div style={{ background: '#2c2c2e', border: '0.5px solid rgba(255,255,255,0.09)', borderRadius: '12px', padding: '1rem 1.125rem', boxShadow: '0 2px 8px rgba(0,0,0,0.45)' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '12px', paddingBottom: '10px', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
              <Gauge style={{ width: '14px', height: '14px', color: '#30bf99' }} />
              Mining Stage Circuit Availability
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '8px' }}>
              {forecast.days[0]?.stages.map((st) => (
                <StageGauge
                  key={st.stage}
                  stage={st.stage}
                  label={STAGE_LABEL[st.stage]}
                  capacity={st.capacityT}
                  available={st.availableFraction * st.capacityT}
                  isBottleneck={st.isBottleneck}
                />
              ))}
            </div>
            <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.28)', textAlign: 'center', marginTop: '10px', paddingTop: '8px', borderTop: '0.5px solid rgba(255,255,255,0.07)' }}>
              Availability = (active / total) × MTBF fraction · CMMS-linked
            </div>
          </div>

          {/* Equipment Health */}
          <div style={{ background: '#2c2c2e', border: '0.5px solid rgba(255,255,255,0.09)', borderRadius: '12px', padding: '1rem 1.125rem', boxShadow: '0 2px 8px rgba(0,0,0,0.45)' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '12px', paddingBottom: '10px', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
              <Truck style={{ width: '14px', height: '14px', color: '#30bf99' }} />
              Equipment Survival Hazard (AFT Weibull)
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontFamily: 'JetBrains Mono, monospace', fontSize: '11px' }}>
              {fleet.slice(0, 5).map((eq) => (
                <div key={eq.equipId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderRadius: '7px', background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.08)' }}>
                  <div>
                    <span style={{ fontWeight: 700, color: 'rgba(255,255,255,0.88)', display: 'block' }}>{eq.equipId}</span>
                    <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', textTransform: 'capitalize' }}>{eq.type} · {eq.ageYears}y</span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ fontWeight: 700, padding: '2px 7px', borderRadius: '5px', display: 'block', fontSize: '10.5px', background: eq.failureRisk7d > 0.25 ? 'rgba(255,59,48,0.15)' : 'rgba(14,145,102,0.15)', color: eq.failureRisk7d > 0.25 ? '#ff6b6b' : '#30bf99' }}>
                      {(eq.failureRisk7d * 100).toFixed(0)}% 7d Risk
                    </span>
                    <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.30)', marginTop: '2px', display: 'block' }}>MTTR: ~{Math.round(8 + eq.ageYears * 1.2)}h</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Company-Wide Performance */}
          <div style={{ background: '#2c2c2e', border: '0.5px solid rgba(255,255,255,0.09)', borderRadius: '12px', padding: '1rem 1.125rem', boxShadow: '0 2px 8px rgba(0,0,0,0.45)' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '12px', paddingBottom: '10px', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
              <BarChart3 style={{ width: '14px', height: '14px', color: '#30bf99' }} />
              Company-Wide 7-Day Attainment
            </h3>
            <div style={{ height: '140px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={allMineForecasts} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="shortName" tick={{ fontSize: 9.5, fill: 'rgba(255,255,255,0.35)', fontFamily: 'JetBrains Mono, monospace' }} />
                  <YAxis tick={{ fontSize: 9.5, fill: 'rgba(255,255,255,0.35)', fontFamily: 'JetBrains Mono, monospace' }} />
                  <Tooltip contentStyle={{ background: '#3a3a3c', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: '8px', color: 'rgba(255,255,255,0.88)', fontSize: '11px', fontFamily: 'JetBrains Mono, monospace' }} />
                  <Bar dataKey="plan" fill="rgba(255,255,255,0.10)" name="Plan (t)" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="p50" name="Forecast P50 (t)" radius={[3, 3, 0, 0]}>
                    {allMineForecasts.map((entry, i) => (
                      <Bar key={i} dataKey="p50" fill={entry.pShort7 > 0.3 ? '#ff6b6b' : '#30bf99'} />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Center/Right: Charts */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Main Chart */}
          <div style={{ background: '#2c2c2e', border: '0.5px solid rgba(255,255,255,0.09)', borderRadius: '12px', padding: '1rem 1.125rem', boxShadow: '0 2px 8px rgba(0,0,0,0.45)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem', paddingBottom: '0.75rem', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
              <div>
                <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.92)', display: 'flex', alignItems: 'center', gap: '7px' }}>
                  {chartMode === 'planActual' ? <Activity style={{ width: '14px', height: '14px', color: '#30bf99' }} /> : <TrendingUp style={{ width: '14px', height: '14px', color: '#30bf99' }} />}
                  {chartMode === 'planActual' && 'Plan vs Actual vs Forecast'}
                  {chartMode === 'quantile' && `${horizonDays}-Day Quantile Band (P10/P50/P90)`}
                  {chartMode === 'rain' && 'Forecast with Satellite Rainfall'}
                </h3>
                <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginTop: '2px', fontFamily: 'JetBrains Mono, monospace' }}>
                  {chartMode === 'planActual' && 'Past actuals (bars) · Future P50 (line) · Plan target (dashed)'}
                  {chartMode === 'quantile' && 'P10–P90 uncertainty band · P50 median forecast'}
                  {chartMode === 'rain' && 'Right axis: GPM IMERG rainfall mm/day · Auto-adjusted for rain'}
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '10.5px', fontFamily: 'JetBrains Mono, monospace', color: 'rgba(255,255,255,0.38)', flexShrink: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: '14px', height: '2px', background: '#0e9166', borderRadius: '1px', display: 'inline-block' }} /> P50</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><span style={{ width: '14px', height: '0', borderTop: '2px dashed #ff6b6b', display: 'inline-block' }} /> Plan</span>
              </div>
            </div>

            <div style={{ height: '300px' }}>
              <ResponsiveContainer width="100%" height="100%">
                {chartMode === 'planActual' ? (
                  <ComposedChart data={planActualData} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="forecastGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0e9166" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#0e9166" stopOpacity={0.03} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="date" tick={{ fontSize: 9.5, fill: 'rgba(255,255,255,0.35)', fontFamily: 'JetBrains Mono, monospace' }} />
                    <YAxis tick={{ fontSize: 9.5, fill: 'rgba(255,255,255,0.35)', fontFamily: 'JetBrains Mono, monospace' }} domain={['dataMin - 200', 'dataMax + 200']} />
                    <Tooltip contentStyle={{ background: '#3a3a3c', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: '8px', color: 'rgba(255,255,255,0.88)', fontSize: '11px', fontFamily: 'JetBrains Mono, monospace' }} />
                    <ReferenceLine x="Today" stroke="#ffb340" strokeDasharray="3 3" label={{ value: 'Today', fill: '#ffb340', fontSize: 9, position: 'top' }} />
                    <Area type="monotone" dataKey="p90" stroke="transparent" fill="#0e9166" fillOpacity={0.10} name="P90" />
                    <Area type="monotone" dataKey="p10" stroke="transparent" fill="#161618" fillOpacity={1} name="P10" />
                    <Area type="monotone" dataKey="forecast" stroke="#0e9166" strokeWidth={2} fill="url(#forecastGrad)" name="Forecast P50 (t)" />
                    <Bar dataKey="actual" fill="rgba(255,255,255,0.25)" fillOpacity={0.6} radius={[2, 2, 0, 0]} name="Actual (t)" barSize={10} />
                    <Line type="monotone" dataKey="plan" stroke="#ff6b6b" strokeWidth={1.5} strokeDasharray="5 3" dot={false} name="Plan (t)" />
                    <Legend wrapperStyle={{ fontSize: '11px', color: 'rgba(255,255,255,0.50)' }} />
                  </ComposedChart>
                ) : chartMode === 'quantile' ? (
                  <ComposedChart data={quantileData} margin={{ top: 10, right: 20, left: -10, bottom: 0 }}>
                    <defs>
                      <linearGradient id="qBand" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0e9166" stopOpacity={0.28} />
                        <stop offset="95%" stopColor="#0e9166" stopOpacity={0.04} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="date" tick={{ fontSize: 9.5, fill: 'rgba(255,255,255,0.35)', fontFamily: 'JetBrains Mono, monospace' }} />
                    <YAxis tick={{ fontSize: 9.5, fill: 'rgba(255,255,255,0.35)', fontFamily: 'JetBrains Mono, monospace' }} domain={['dataMin - 200', 'dataMax + 200']} />
                    <Tooltip contentStyle={{ background: '#3a3a3c', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: '8px', color: 'rgba(255,255,255,0.88)', fontSize: '11px' }} />
                    <Area type="monotone" dataKey="p90" stroke="transparent" fill="#0e9166" fillOpacity={0.12} />
                    <Area type="monotone" dataKey="p10" stroke="transparent" fill="#161618" fillOpacity={1} />
                    <Area type="monotone" dataKey="p50" stroke="#0e9166" strokeWidth={2.5} fill="url(#qBand)" name="P50 Forecast (t)" />
                    <Line type="monotone" dataKey="plan" stroke="#ff6b6b" strokeWidth={2} strokeDasharray="4 4" dot={false} name="Plan (t)" />
                  </ComposedChart>
                ) : (
                  <ComposedChart data={quantileData} margin={{ top: 10, right: 30, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="date" tick={{ fontSize: 9.5, fill: 'rgba(255,255,255,0.35)', fontFamily: 'JetBrains Mono, monospace' }} />
                    <YAxis yAxisId="left" tick={{ fontSize: 9.5, fill: 'rgba(255,255,255,0.35)', fontFamily: 'JetBrains Mono, monospace' }} domain={['dataMin - 200', 'dataMax + 200']} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 9.5, fill: 'rgba(94,170,255,0.7)', fontFamily: 'JetBrains Mono, monospace' }} domain={[0, 80]} />
                    <Tooltip contentStyle={{ background: '#3a3a3c', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: '8px', color: 'rgba(255,255,255,0.88)', fontSize: '11px' }} />
                    <Line yAxisId="left" type="monotone" dataKey="p50" stroke="#0e9166" strokeWidth={2.5} dot={false} name="P50 Forecast (t)" />
                    <Line yAxisId="left" type="monotone" dataKey="plan" stroke="#ff6b6b" strokeWidth={2} strokeDasharray="4 4" dot={false} name="Plan (t)" />
                    <Bar yAxisId="right" dataKey="rain" fill="#5eaaff" fillOpacity={0.30} radius={[2, 2, 0, 0]} name="Rainfall (mm)" barSize={10} />
                  </ComposedChart>
                )}
              </ResponsiveContainer>
            </div>

            {/* Summary footer */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', paddingTop: '0.75rem', marginTop: '0.75rem', borderTop: '0.5px solid rgba(255,255,255,0.07)', fontSize: '11px', color: 'rgba(255,255,255,0.38)' }}>
              <span>Driver: <strong style={{ color: 'rgba(255,255,255,0.75)', fontFamily: 'JetBrains Mono, monospace' }}>{forecast.causeMix[0]?.bucket.toUpperCase()}</strong> ({forecast.causeMix[0]?.tonnes.toLocaleString()} t lost)</span>
              <span>Coverage: <strong style={{ color: '#30bf99', fontFamily: 'JetBrains Mono, monospace' }}>{(forecast.coverage * 100).toFixed(0)}%</strong></span>
              <span>Alert Threshold: <strong style={{ fontFamily: 'JetBrains Mono, monospace', color: '#ff6b6b' }}>{(triggerP * 100).toFixed(0)}% P(miss)</strong></span>
            </div>
          </div>

          {/* Loss Attribution */}
          <div style={{ background: '#2c2c2e', border: '0.5px solid rgba(255,255,255,0.09)', borderRadius: '12px', padding: '1rem 1.125rem', boxShadow: '0 2px 8px rgba(0,0,0,0.45)' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.92)', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '12px', paddingBottom: '10px', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
              <BarChart3 style={{ width: '14px', height: '14px', color: '#30bf99' }} />
              SHAP Loss Attribution — Cause Mix Breakdown
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              {forecast.causeMix.map((c) => (
                <div key={c.bucket} style={{ padding: '0.75rem', borderRadius: '8px', background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.09)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontWeight: 700, fontSize: '12.5px', color: 'rgba(255,255,255,0.88)', textTransform: 'capitalize' }}>{c.bucket}</span>
                    <span style={{ fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', fontSize: '13px', color: '#ff6b6b' }}>-{c.tonnes.toLocaleString()} t</span>
                  </div>
                  <div style={{ height: '4px', background: 'rgba(255,255,255,0.08)', borderRadius: '99px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: '#ff6b6b', borderRadius: '99px', width: `${(c.share * 100).toFixed(0)}%`, boxShadow: '0 0 5px rgba(255,107,107,0.5)' }} />
                  </div>
                  <div style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.35)', marginTop: '5px' }}>{(c.share * 100).toFixed(1)}% of total capacity loss</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
