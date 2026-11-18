import React, { useState } from 'react';
import { GitCommit, BarChart3, TrendingUp, AlertTriangle } from 'lucide-react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine, Legend, Cell,
} from 'recharts';
import { MINES } from '../core/geology';
import { buildReconciliation } from '../core/reconciliation';

interface ReconciliationTabProps { selectedMineId: string; }

function buildFTrend(baseF1: number, baseF2: number, baseF3: number) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];
  return months.map((month, i) => ({
    month,
    F1: +(baseF1 + ((i * 37 + 11) % 100) / 1000 - 0.05).toFixed(3),
    F2: +(baseF2 + ((i * 53 + 17) % 100) / 1000 - 0.05).toFixed(3),
    F3: +(baseF3 + ((i * 71 + 23) % 100) / 1000 - 0.05).toFixed(3),
  }));
}

const panel: React.CSSProperties = {
  background: '#2c2c2e',
  border: '0.5px solid rgba(255,255,255,0.09)',
  borderRadius: '12px',
  padding: '1rem 1.125rem',
  boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
};

const eyebrow: React.CSSProperties = {
  fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)',
};

const sectionTitle = (icon: React.ReactNode, text: string) => (
  <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '10px', paddingBottom: '8px', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
    {icon}{text}
  </h3>
);

const CHART_TICK = { fontSize: 9.5, fill: 'rgba(255,255,255,0.35)', fontFamily: 'JetBrains Mono, monospace' };
const TOOLTIP = { background: '#3a3a3c', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: '8px', color: 'rgba(255,255,255,0.88)', fontSize: '11px', fontFamily: 'JetBrains Mono, monospace' };

export const ReconciliationTab: React.FC<ReconciliationTabProps> = ({ selectedMineId }) => {
  const activeMineId = selectedMineId === 'ALL' ? 'MNE-BAL' : selectedMineId;
  const activeMine = MINES.find((m) => m.id === activeMineId) || MINES[0];
  const recon = buildReconciliation(activeMine.id);
  const [activeMetric, setActiveMetric] = useState<'F1' | 'F2' | 'F3' | 'all'>('all');

  const trend = buildFTrend(recon.meanF1, recon.meanF2, recon.meanF3);
  const drivers = recon.factors[0]?.drivers ?? [];

  const F1_OK = Math.abs(recon.meanF1 - 1.0) <= 0.05;
  const F2_OK = Math.abs(recon.meanF2 - 1.0) <= 0.05;
  const F3_OK = Math.abs(recon.meanF3 - 1.0) <= 0.05;
  const allOK = F1_OK && F2_OK && F3_OK;

  const fFactors = [
    { key: 'F1', label: 'F1 Mine Call Factor',       value: recon.meanF1, ok: F1_OK, color: '#30bf99', desc: 'Ratio of Ore Mined (Assay + Tonnage) to Block Model Draw Prediction.' },
    { key: 'F2', label: 'F2 Process Call Factor',     value: recon.meanF2, ok: F2_OK, color: '#ffb340', desc: 'Ratio of Plant Processing Feed Assays to Pit Mined Assays.' },
    { key: 'F3', label: 'F3 Commercial Call Factor',  value: recon.meanF3, ok: F3_OK, color: '#bf9bff', desc: 'Overall Factor from In-Situ Block Model to Final Railway Dispatch.' },
  ];

  return (
    <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', background: '#161618', minHeight: '100vh', color: 'rgba(255,255,255,0.92)' }}>

      {/* ── Top Banner ── */}
      <div style={{ ...panel, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '14px', fontWeight: 700, color: 'rgba(255,255,255,0.92)', display: 'flex', alignItems: 'center', gap: '7px', letterSpacing: '-0.01em' }}>
            <GitCommit style={{ width: '15px', height: '15px', color: '#30bf99' }} />
            Monthly Mine Reconciliation &amp; F-Factor Audit
            <span style={{ fontSize: '10px', fontFamily: 'JetBrains Mono, monospace', background: 'rgba(14,145,102,0.15)', color: '#30bf99', border: '0.5px solid rgba(14,145,102,0.35)', padding: '1px 7px', borderRadius: '4px' }}>D8</span>
            <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.40)', fontSize: '13px' }}>— {activeMine.name}</span>
          </h2>
          <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginTop: '3px', fontFamily: 'JetBrains Mono, monospace' }}>
            F1 (Mine Call) · F2 (Process Call) · F3 (Commercial Call) · SHAP Residual Decomposition
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(14,145,102,0.15)', border: '0.5px solid rgba(14,145,102,0.35)', color: '#30bf99', borderRadius: '999px', padding: '2px 9px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>m10-v2.2.0</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: allOK ? 'rgba(14,145,102,0.15)' : 'rgba(255,159,10,0.15)', border: `0.5px solid ${allOK ? 'rgba(14,145,102,0.35)' : 'rgba(255,159,10,0.35)'}`, color: allOK ? '#30bf99' : '#ffb340', borderRadius: '999px', padding: '2px 9px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            {!allOK && <AlertTriangle style={{ width: '10px', height: '10px' }} />}
            {allOK ? 'All Within Tolerance' : 'Deviation Detected'}
          </span>
        </div>
      </div>

      {/* ── F-Factor KPI Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '1rem' }}>
        {fFactors.map(({ key, label, value, ok, color, desc }) => (
          <div key={key} style={{ ...panel, outline: ok ? 'none' : '1px solid rgba(255,159,10,0.25)', outlineOffset: '-1px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={eyebrow}>{label}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', background: ok ? 'rgba(14,145,102,0.15)' : 'rgba(255,159,10,0.15)', border: `0.5px solid ${ok ? 'rgba(14,145,102,0.35)' : 'rgba(255,159,10,0.35)'}`, color: ok ? '#30bf99' : '#ffb340', borderRadius: '999px', padding: '1px 7px', fontSize: '9.5px', fontWeight: 700 }}>Target 1.00 ± 0.05</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '30px', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color, letterSpacing: '-0.02em' }}>{value.toFixed(3)}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', fontWeight: 600, color: ok ? '#30bf99' : '#ffb340' }}>
                {ok ? <><span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#30bf99', display: 'inline-block' }} />Within tolerance</> : <><AlertTriangle style={{ width: '11px', height: '11px' }} />Deviation!</>}
              </span>
            </div>

            {/* Deviation bar */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ ...eyebrow, fontSize: '9.5px' }}>Deviation from 1.000</span>
              <div style={{ position: 'relative', height: '5px', background: 'rgba(255,255,255,0.08)', borderRadius: '99px', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', left: '50%', top: 0, height: '100%', width: '1px', background: 'rgba(255,255,255,0.2)' }} />
                <div style={{
                  position: 'absolute', height: '100%', borderRadius: '99px',
                  background: ok ? '#0e9166' : '#ffb340',
                  boxShadow: `0 0 5px ${ok ? 'rgba(14,145,102,0.5)' : 'rgba(255,159,10,0.5)'}`,
                  left: value >= 1 ? '50%' : `${Math.max(10, 50 + (value - 1) * 100)}%`,
                  width: `${Math.min(40, Math.abs(value - 1) * 200)}%`,
                }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9.5px', fontFamily: 'JetBrains Mono, monospace', color: 'rgba(255,255,255,0.25)' }}>
                <span>0.90</span><span>1.00</span><span>1.10</span>
              </div>
            </div>
            <p style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.38)', lineHeight: 1.6 }}>{desc}</p>
          </div>
        ))}
      </div>

      {/* ── Trend + SHAP ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>

        {/* F-Factor Trend */}
        <div style={panel}>
          {sectionTitle(<TrendingUp style={{ width: '14px', height: '14px', color: '#30bf99' }} />, 'Monthly F-Factor Trend (YTD 2026)')}
          <div style={{ display: 'flex', gap: '4px', marginBottom: '10px', background: 'rgba(255,255,255,0.06)', borderRadius: '7px', padding: '3px', border: '0.5px solid rgba(255,255,255,0.1)', width: 'fit-content' }}>
            {(['all', 'F1', 'F2', 'F3'] as const).map((m) => (
              <button key={m} onClick={() => setActiveMetric(m)} style={{ padding: '0.25rem 0.625rem', fontSize: '11px', fontWeight: 600, borderRadius: '5px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', background: activeMetric === m ? '#3a3a3c' : 'transparent', color: activeMetric === m ? '#30bf99' : 'rgba(255,255,255,0.40)', transition: 'all 120ms ease' }}>
                {m === 'all' ? 'All' : m}
              </button>
            ))}
          </div>
          <div style={{ height: '240px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="month" tick={CHART_TICK} />
                <YAxis tick={CHART_TICK} domain={[0.88, 1.12]} />
                <Tooltip contentStyle={TOOLTIP} formatter={(v: number) => [v.toFixed(3), '']} />
                <ReferenceLine y={1.0} stroke="#0e9166" strokeDasharray="4 4" label={{ value: 'Target 1.00', fill: '#30bf99', fontSize: 9 }} />
                <ReferenceLine y={1.05} stroke="rgba(255,159,10,0.5)" strokeDasharray="3 3" strokeWidth={0.7} />
                <ReferenceLine y={0.95} stroke="rgba(255,159,10,0.5)" strokeDasharray="3 3" strokeWidth={0.7} />
                {(activeMetric === 'all' || activeMetric === 'F1') && <Line type="monotone" dataKey="F1" stroke="#30bf99" strokeWidth={2} dot={{ r: 3, fill: '#30bf99' }} name="F1 Mine Call" />}
                {(activeMetric === 'all' || activeMetric === 'F2') && <Line type="monotone" dataKey="F2" stroke="#ffb340" strokeWidth={2} dot={{ r: 3, fill: '#ffb340' }} name="F2 Process Call" />}
                {(activeMetric === 'all' || activeMetric === 'F3') && <Line type="monotone" dataKey="F3" stroke="#bf9bff" strokeWidth={2} dot={{ r: 3, fill: '#bf9bff' }} name="F3 Commercial" />}
                {activeMetric === 'all' && <Legend wrapperStyle={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)' }} />}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.30)', marginTop: '6px' }}>
            Amber dashed lines = ±5% tolerance band. Values outside trigger SHAP investigation workflow.
          </p>
        </div>

        {/* SHAP Attribution */}
        <div style={panel}>
          {sectionTitle(<BarChart3 style={{ width: '14px', height: '14px', color: '#30bf99' }} />, 'SHAP Reconciliation Residual Drivers')}
          <div style={{ height: '200px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart layout="vertical"
                data={drivers.map((d: { label: string; contributionPct: number }) => ({ label: d.label, value: d.contributionPct }))}
                margin={{ top: 5, right: 30, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                <XAxis type="number" tick={CHART_TICK} tickFormatter={(v) => `${v}%`} />
                <YAxis type="category" dataKey="label" tick={CHART_TICK} width={120} />
                <Tooltip contentStyle={TOOLTIP} formatter={(v: number) => [`${v.toFixed(2)}%`, 'Contribution']} />
                <ReferenceLine x={0} stroke="rgba(255,255,255,0.2)" strokeWidth={1.5} />
                <Bar dataKey="value" radius={[0, 3, 3, 0]} name="SHAP Contribution (%)">
                  {drivers.map((d: { contributionPct: number }, i: number) => (
                    <Cell key={i} fill={d.contributionPct > 0 ? '#0e9166' : '#ff6b6b'} />
                  ))}
                </Bar>
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginTop: '8px' }}>
            {drivers.slice(0, 4).map((driver: { label: string; contributionPct: number; direction: string }) => (
              <div key={driver.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.08)', borderRadius: '7px', fontSize: '11.5px' }}>
                <div>
                  <span style={{ fontWeight: 600, color: 'rgba(255,255,255,0.80)' }}>{driver.label}</span>
                  <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', display: 'block' }}>Direction: {driver.direction} · SHAP attribution</span>
                </div>
                <span style={{ fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: driver.contributionPct > 0 ? '#30bf99' : '#ff6b6b' }}>
                  {driver.contributionPct > 0 ? `+${driver.contributionPct.toFixed(2)}%` : `${driver.contributionPct.toFixed(2)}%`}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Reconciliation Chain ── */}
      <div style={panel}>
        {sectionTitle(<GitCommit style={{ width: '14px', height: '14px', color: '#30bf99' }} />, 'Reconciliation Chain: In-Situ → Mine → Plant → Dispatch')}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {[
            { label: 'In-Situ Block Model',  sub: '(Kriging Estimate)', value: '100%',                                                    ok: null },
            { label: '× F1 Mine Call',       sub: `(${recon.meanF1.toFixed(3)})`, value: `${(recon.meanF1 * 100).toFixed(1)}%`,           ok: F1_OK },
            { label: '× F2 Process Call',    sub: `(${recon.meanF2.toFixed(3)})`, value: `${(recon.meanF1 * recon.meanF2 * 100).toFixed(1)}%`, ok: F2_OK },
            { label: '× F3 Commercial',      sub: `(${recon.meanF3.toFixed(3)})`, value: `${(recon.meanF1 * recon.meanF2 * recon.meanF3 * 100).toFixed(1)}%`, ok: F3_OK },
            { label: 'Final Dispatched',     sub: '(Railway Weigh)',   value: `${(recon.meanF1 * recon.meanF2 * recon.meanF3 * 100).toFixed(1)}%`, ok: true, final: true },
          ].map((step, i, arr) => (
            <React.Fragment key={step.label}>
              <div style={{
                flex: 1, textAlign: 'center', padding: '0.875rem 0.625rem', borderRadius: '10px', minWidth: '110px',
                background: (step as any).final ? 'rgba(14,145,102,0.15)' : step.ok === null ? 'rgba(255,255,255,0.05)' : step.ok ? 'rgba(14,145,102,0.08)' : 'rgba(255,159,10,0.08)',
                border: `0.5px solid ${(step as any).final ? 'rgba(14,145,102,0.4)' : step.ok === null ? 'rgba(255,255,255,0.1)' : step.ok ? 'rgba(14,145,102,0.3)' : 'rgba(255,159,10,0.3)'}`,
              }}>
                <div style={{ fontWeight: 700, fontSize: '20px', fontFamily: 'JetBrains Mono, monospace', color: (step as any).final ? '#30bf99' : step.ok === null ? 'rgba(255,255,255,0.80)' : step.ok ? '#30bf99' : '#ffb340' }}>{step.value}</div>
                <div style={{ fontSize: '11px', fontWeight: 600, marginTop: '3px', color: 'rgba(255,255,255,0.75)' }}>{step.label}</div>
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.38)', fontFamily: 'JetBrains Mono, monospace' }}>{step.sub}</div>
              </div>
              {i < arr.length - 1 && <div style={{ color: 'rgba(255,255,255,0.25)', fontSize: '16px', flexShrink: 0 }}>→</div>}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
};
