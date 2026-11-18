import React, { useState } from 'react';
import { Cpu, Database, ShieldCheck, Activity } from 'lucide-react';
import { MODELS, SOURCES, AUDIT, FLOWS } from '../core/models';

// ── Shared dark surface style ────────────────────────────────────────────────
const dark = {
  panel: {
    background: '#2c2c2e',
    border: '0.5px solid rgba(255,255,255,0.09)',
    borderRadius: '12px',
    padding: '1rem 1.125rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
  } as React.CSSProperties,

  row: {
    padding: '0.75rem 0.875rem',
    borderRadius: '8px',
    background: 'rgba(255,255,255,0.04)',
    border: '0.5px solid rgba(255,255,255,0.08)',
    display: 'flex', flexDirection: 'column' as const,
    gap: '8px',
  } as React.CSSProperties,

  label: { fontSize: '10px', color: 'rgba(255,255,255,0.35)', display: 'block', marginBottom: '2px' },
  value: { color: 'rgba(255,255,255,0.80)', fontWeight: 600 },
  mono: { fontFamily: 'JetBrains Mono, monospace' },

  chip: (ok: boolean) => ({
    display: 'inline-flex', alignItems: 'center', gap: '3px',
    background: ok ? 'rgba(14,145,102,0.15)' : 'rgba(255,159,10,0.15)',
    border: `0.5px solid ${ok ? 'rgba(14,145,102,0.35)' : 'rgba(255,159,10,0.35)'}`,
    color: ok ? '#30bf99' : '#ffb340',
    borderRadius: '999px', padding: '1px 8px',
    fontSize: '9.5px', fontWeight: 700, textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  } as React.CSSProperties),

  danger: () => ({
    display: 'inline-flex', alignItems: 'center',
    background: 'rgba(255,59,48,0.15)',
    border: '0.5px solid rgba(255,59,48,0.35)',
    color: '#ff6b6b',
    borderRadius: '999px', padding: '1px 8px',
    fontSize: '9.5px', fontWeight: 700, textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  } as React.CSSProperties),
};

export const ModelOpsTab: React.FC = () => {
  const [activeSubTab, setActiveSubTab] = useState<'models' | 'sources' | 'audit' | 'flows'>('models');

  const subTabs = [
    { id: 'models',  label: `Model Registry (${MODELS.length})` },
    { id: 'sources', label: `Data Sources (${SOURCES.length})` },
    { id: 'audit',   label: `Audit Trail (${AUDIT.length})` },
    { id: 'flows',   label: `Flow Runs (${FLOWS.length})` },
  ] as const;

  return (
    <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', background: '#161618', minHeight: '100vh', color: 'rgba(255,255,255,0.92)' }}>
      {/* Top Banner */}
      <div style={{ ...dark.panel, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '14px', fontWeight: 700, color: 'rgba(255,255,255,0.92)', display: 'flex', alignItems: 'center', gap: '7px', letterSpacing: '-0.01em' }}>
            <Cpu style={{ width: '15px', height: '15px', color: '#30bf99' }} />
            Model Operations, Data Lineage &amp; Audit Governance
            <span style={{ fontSize: '10px', ...dark.mono, background: 'rgba(14,145,102,0.15)', color: '#30bf99', border: '0.5px solid rgba(14,145,102,0.35)', padding: '1px 7px', borderRadius: '4px' }}>D10</span>
          </h2>
          <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginTop: '3px' }}>
            Traceable Predictions · Immutable Audit Logs · Data Quality Quarantine Gating
          </p>
        </div>

        {/* Segmented control */}
        <div style={{ display: 'flex', background: 'rgba(255,255,255,0.06)', borderRadius: '8px', padding: '3px', border: '0.5px solid rgba(255,255,255,0.1)', gap: '2px' }}>
          {subTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveSubTab(t.id)}
              style={{
                padding: '0.3125rem 0.75rem', fontSize: '11.5px', fontWeight: 600, borderRadius: '6px',
                border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                background: activeSubTab === t.id ? '#3a3a3c' : 'transparent',
                color: activeSubTab === t.id ? '#30bf99' : 'rgba(255,255,255,0.40)',
                boxShadow: activeSubTab === t.id ? '0 1px 3px rgba(0,0,0,0.4)' : 'none',
                transition: 'all 120ms ease', whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Models Tab ─────────────────────────────────────────────────────── */}
      {activeSubTab === 'models' && (
        <div style={dark.panel}>
          <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '12px', paddingBottom: '10px', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
            <Cpu style={{ width: '14px', height: '14px', color: '#30bf99' }} />
            Registered Model Inventory &amp; Performance Cards
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {MODELS.map((m) => (
              <div key={m.id} style={{ ...dark.row, cursor: 'default' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontWeight: 700, fontSize: '13px', color: 'rgba(255,255,255,0.88)' }}>{m.name}</span>
                    <span style={{ fontSize: '10px', ...dark.mono, background: 'rgba(255,255,255,0.07)', border: '0.5px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.45)', padding: '1px 6px', borderRadius: '4px' }}>{m.version}</span>
                  </div>
                  <span style={m.status === 'production' ? dark.chip(true) : dark.chip(false)}>
                    {m.status.toUpperCase()}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '0.625rem', paddingTop: '8px', borderTop: '0.5px solid rgba(255,255,255,0.07)', ...dark.mono, fontSize: '11px' }}>
                  {[
                    { label: 'Task',            value: m.task,      color: 'rgba(255,255,255,0.80)' },
                    { label: 'Algorithm',       value: m.algorithm,  color: 'rgba(255,255,255,0.80)' },
                    { label: m.primaryMetric,   value: m.metricValue, color: '#30bf99' },
                    { label: 'Drift PSI',       value: `${m.driftStatus} (${m.driftPsis})`, color: m.driftStatus === 'stable' ? '#30bf99' : '#ffb340' },
                  ].map((col) => (
                    <div key={col.label}>
                      <span style={dark.label}>{col.label}</span>
                      <span style={{ fontWeight: 600, color: col.color }}>{col.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Sources Tab ─────────────────────────────────────────────────────── */}
      {activeSubTab === 'sources' && (
        <div style={dark.panel}>
          <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '12px', paddingBottom: '10px', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
            <Database style={{ width: '14px', height: '14px', color: '#30bf99' }} />
            Data Source Catalog &amp; Ingestion Pipelines
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', ...dark.mono, fontSize: '11px' }}>
            {SOURCES.map((src) => (
              <div key={src.id} style={dark.row}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontWeight: 700, fontSize: '13px', color: 'rgba(255,255,255,0.88)' }}>{src.name}</span>
                    <span style={{ color: 'rgba(255,255,255,0.38)' }}>({src.provider})</span>
                  </div>
                  <span style={src.quality === 'ok' ? dark.chip(true) : dark.danger()}>{src.quality.toUpperCase()}</span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '0.625rem', paddingTop: '8px', borderTop: '0.5px solid rgba(255,255,255,0.07)' }}>
                  {[
                    { label: 'Coverage',        value: `${src.coveragePct}%`,      color: 'rgba(255,255,255,0.80)' },
                    { label: 'Validation Pass',  value: `${src.validationPassPct}%`, color: '#30bf99' },
                    { label: 'Connector',        value: src.connector,              color: 'rgba(255,255,255,0.80)' },
                    { label: 'Consumers',        value: src.consumers.join(', '),   color: 'rgba(255,255,255,0.55)' },
                  ].map((col) => (
                    <div key={col.label}>
                      <span style={dark.label}>{col.label}</span>
                      <span style={{ fontWeight: 600, color: col.color }}>{col.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Audit Trail Tab ─────────────────────────────────────────────────── */}
      {activeSubTab === 'audit' && (
        <div style={dark.panel}>
          <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '12px', paddingBottom: '10px', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
            <ShieldCheck style={{ width: '14px', height: '14px', color: '#30bf99' }} />
            Immutable Audit Log &amp; Action Trail
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', ...dark.mono, fontSize: '11px' }}>
            {AUDIT.map((a) => (
              <div key={a.id} style={{ ...dark.row, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '3px' }}>
                    <span style={{ fontWeight: 700, color: 'rgba(255,255,255,0.88)' }}>{a.id}</span>
                    <span style={{ fontWeight: 600, color: '#30bf99' }}>{a.action}</span>
                    <span style={{ color: 'rgba(255,255,255,0.38)' }}>by {a.actor} ({a.role})</span>
                  </div>
                  <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '10.5px', marginTop: '2px' }}>{a.detail}</p>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <span style={{ color: 'rgba(255,255,255,0.45)', display: 'block' }}>{a.at.slice(0, 16)}</span>
                  <span style={{ color: 'rgba(255,255,255,0.22)', fontSize: '9.5px' }}>{a.fromIp}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Flow Runs Tab ───────────────────────────────────────────────────── */}
      {activeSubTab === 'flows' && (
        <div style={dark.panel}>
          <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '12px', paddingBottom: '10px', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
            <Activity style={{ width: '14px', height: '14px', color: '#30bf99' }} />
            Orchestration Flow Execution Runs
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', ...dark.mono, fontSize: '11px' }}>
            {FLOWS.map((f) => (
              <div key={f.id} style={dark.row}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 700, fontSize: '13px', color: 'rgba(255,255,255,0.88)' }}>
                    {f.label} <span style={{ color: 'rgba(255,255,255,0.35)', fontWeight: 400 }}>({f.id})</span>
                  </span>
                  <span style={{ ...dark.chip(true), fontSize: '9.5px' }}>
                    {f.status.toUpperCase()} — {f.durationS}s
                  </span>
                </div>

                <div style={{ paddingTop: '8px', borderTop: '0.5px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {f.steps.map((st, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '10.5px' }}>
                      <span style={{ color: 'rgba(255,255,255,0.60)' }}>{st.name}</span>
                      <span style={{ fontWeight: 600, color: '#30bf99' }}>{st.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
