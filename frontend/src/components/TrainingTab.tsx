import React, { useMemo, useState } from 'react';
import { Bot, Database, Activity, RefreshCw, Target, Gauge, ShieldCheck, MapPin } from 'lucide-react';
import {
  LineChart, Line, BarChart, Bar, ScatterChart, Scatter,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  ReferenceLine, Cell,
} from 'recharts';
import { MANGANESE_STATS } from '../core/manganeseIndia';
import { MANGANESE_TRAINING, trainManganeseModel } from '../core/manganeseModel';
import { num } from '../core/format';

type SortKey = 'dataset' | 'grade' | 'prob' | 'capacity';

// ── Shared styles ─────────────────────────────────────────────────────────────
const S = {
  panel: {
    background: '#2c2c2e',
    border: '0.5px solid rgba(255,255,255,0.09)',
    borderRadius: '12px',
    padding: '1rem 1.125rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
  } as React.CSSProperties,

  tick: { fontSize: 9, fill: 'rgba(255,255,255,0.35)', fontFamily: 'JetBrains Mono, monospace' },
  tooltip: {
    background: '#3a3a3c',
    border: '0.5px solid rgba(255,255,255,0.14)',
    borderRadius: '8px',
    color: 'rgba(255,255,255,0.88)',
    fontSize: '11px',
    fontFamily: 'JetBrains Mono, monospace',
  },
  eyebrow: {
    fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' as const,
    letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', marginBottom: '6px',
  },
  sectionHead: (icon: React.ReactNode, text: string) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '0.5px solid rgba(255,255,255,0.07)', marginBottom: '12px' }}>
      <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px' }}>
        {icon}{text}
      </h3>
    </div>
  ),
};

export const TrainingTab: React.FC = () => {
  const [training, setTraining] = useState(MANGANESE_TRAINING);
  const [seed, setSeed] = useState(MANGANESE_TRAINING.seed);
  const [sortKey, setSortKey] = useState<SortKey>('dataset');

  const retrain = () => {
    const next = seed + 1;
    setSeed(next);
    setTraining(trainManganeseModel(next));
  };

  const regLoss = useMemo(() => training.regression.loss.map((loss, epoch) => ({ epoch, loss })), [training]);
  const clfLoss = useMemo(() => training.classification.loss.map((loss, epoch) => ({ epoch, loss })), [training]);
  const regImportance = training.regression.coefficients.slice(0, 8).map((c) => ({
    label: c.feature, weight: Number(c.weight.toFixed(3)),
  }));

  const rows = useMemo(() => {
    const copy = [...training.predictions];
    if (sortKey === 'grade')    copy.sort((a, b) => b.cvPredictedGrade - a.cvPredictedGrade);
    if (sortKey === 'prob')     copy.sort((a, b) => b.highProb - a.highProb);
    if (sortKey === 'capacity') copy.sort((a, b) => b.capacityKt - a.capacityKt);
    return copy;
  }, [training, sortKey]);

  const rm = training.regression.metrics;
  const cm = training.classification.metrics;
  const rTrain = training.regression.trainMetrics;
  const cTrain = training.classification.trainMetrics;

  const scatter = training.predictions.map((p) => ({
    actual: p.actualGrade,
    predicted: Number(p.cvPredictedGrade.toFixed(2)),
  }));

  return (
    <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', background: '#161618', minHeight: '100vh', color: 'rgba(255,255,255,0.92)' }}>

      {/* ── Banner ─────────────────────────────────────────────────────────── */}
      <div style={{ ...S.panel, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '14px', fontWeight: 700, color: 'rgba(255,255,255,0.92)', display: 'flex', alignItems: 'center', gap: '7px', letterSpacing: '-0.01em' }}>
            <Bot style={{ width: '15px', height: '15px', color: '#30bf99' }} />
            National Manganese Model Training
            <span style={{ fontSize: '10px', fontFamily: 'JetBrains Mono, monospace', background: 'rgba(14,145,102,0.15)', color: '#30bf99', border: '0.5px solid rgba(14,145,102,0.35)', padding: '1px 7px', borderRadius: '4px' }}>D11</span>
          </h2>
          <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginTop: '3px', fontFamily: 'JetBrains Mono, monospace' }}>
            {training.rows} Indian manganese mines · {MANGANESE_STATS.stateCount} states · trained in-browser · 5-fold cross-validated
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', fontSize: '11px' }}>
            <div style={{ color: 'rgba(255,255,255,0.30)', textTransform: 'uppercase', fontSize: '9.5px', letterSpacing: '0.1em' }}>MODEL</div>
            <div style={{ fontWeight: 700, color: 'rgba(255,255,255,0.88)' }}>{training.version}</div>
            <div style={{ color: 'rgba(255,255,255,0.35)' }}>seed {seed}</div>
          </div>
          <button
            onClick={retrain}
            title="Re-fit with a new fold split"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'linear-gradient(160deg,#17a87e,#0a7a54)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '0.5rem 1rem', fontSize: '12.5px', fontWeight: 700, color: '#fff', cursor: 'pointer', boxShadow: '0 1px 4px rgba(14,145,102,0.4)', transition: 'all 130ms ease', fontFamily: 'inherit' }}
          >
            <RefreshCw style={{ width: '13px', height: '13px' }} />
            Retrain
          </button>
        </div>
      </div>

      {/* ── Stat Cards ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: '0.75rem' }}>
        {[
          { label: 'Mines',       value: num(MANGANESE_STATS.mineCount),                   icon: <Database style={{ width: '13px', height: '13px' }} /> },
          { label: 'States',      value: num(MANGANESE_STATS.stateCount),                  icon: <MapPin   style={{ width: '13px', height: '13px' }} /> },
          { label: 'ROM Cap',     value: `${num(MANGANESE_STATS.capacityMt, 2)} Mt/yr`,    icon: <Gauge    style={{ width: '13px', height: '13px' }} /> },
          { label: 'Reserves',    value: `${num(MANGANESE_STATS.reserveMt, 1)} Mt`,        icon: <Database style={{ width: '13px', height: '13px' }} /> },
          { label: 'Mean Grade',  value: `${num(MANGANESE_STATS.meanGradeMn, 1)}% Mn`,     icon: <Activity style={{ width: '13px', height: '13px' }} /> },
          { label: 'Underground', value: `${num(MANGANESE_STATS.undergroundShare * 100, 0)}% cap`, icon: <Target style={{ width: '13px', height: '13px' }} /> },
        ].map((c) => (
          <div key={c.label} style={{ ...S.panel, display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'rgba(255,255,255,0.35)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {c.icon}{c.label}
            </div>
            <div style={{ fontWeight: 700, fontSize: '14px', color: 'rgba(255,255,255,0.88)', fontFamily: 'JetBrains Mono, monospace' }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* ── Two trained heads ──────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>

        {/* Grade Regressor */}
        <div style={{ ...S.panel, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px' }}>
              <Activity style={{ width: '13px', height: '13px', color: '#30bf99' }} />
              M6-A · ROM grade regressor
            </h3>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '9.5px', fontWeight: 700, background: 'rgba(14,145,102,0.15)', color: '#30bf99', border: '0.5px solid rgba(14,145,102,0.3)', padding: '1px 8px', borderRadius: '4px' }}>RIDGE</span>
          </div>
          <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.40)' }}>{training.regression.algorithm}</p>

          {/* Metrics */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '8px', paddingTop: '8px', borderTop: '0.5px solid rgba(255,255,255,0.07)', fontFamily: 'JetBrains Mono, monospace', fontSize: '11px' }}>
            {[{ l: 'CV R²', v: num(rm.r2, 3), c: '#30bf99' }, { l: 'CV MAE', v: `${num(rm.mae, 2)}%`, c: '#30bf99' }, { l: 'CV RMSE', v: `${num(rm.rmse, 2)}%`, c: '#30bf99' }, { l: 'Train R²', v: num(rTrain.r2, 3), c: 'rgba(255,255,255,0.45)' }].map((m) => (
              <div key={m.l}>
                <div style={S.eyebrow}>{m.l}</div>
                <div style={{ fontWeight: 700, color: m.c }}>{m.v}</div>
              </div>
            ))}
          </div>

          {/* Loss curve */}
          <div>
            <div style={S.eyebrow}>Gradient-descent loss (MSE + L2)</div>
            <div style={{ height: '110px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={regLoss} margin={{ top: 4, right: 6, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="epoch" tick={S.tick} stroke="rgba(255,255,255,0.12)" />
                  <YAxis tick={S.tick} stroke="rgba(255,255,255,0.12)" width={44} />
                  <Tooltip contentStyle={S.tooltip} formatter={(v: number) => v.toFixed(4)} />
                  <Line type="monotone" dataKey="loss" stroke="#30bf99" dot={false} strokeWidth={1.8} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Feature importance */}
          <div>
            <div style={S.eyebrow}>Standardised coefficients (top 8)</div>
            <div style={{ height: '170px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={regImportance} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 60 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" horizontal={false} />
                  <XAxis type="number" tick={S.tick} stroke="rgba(255,255,255,0.12)" />
                  <YAxis type="category" dataKey="label" tick={{ ...S.tick, fontSize: 8.5 }} stroke="rgba(255,255,255,0.12)" width={92} />
                  <Tooltip contentStyle={S.tooltip} />
                  <ReferenceLine x={0} stroke="rgba(255,255,255,0.18)" />
                  <Bar dataKey="weight" radius={[2, 2, 2, 2]}>
                    {regImportance.map((d, i) => (
                      <Cell key={i} fill={d.weight >= 0 ? '#0e9166' : '#ff6b6b'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Premium-grade Classifier */}
        <div style={{ ...S.panel, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px' }}>
              <Target style={{ width: '13px', height: '13px', color: '#bf9bff' }} />
              M6-B · Premium-grade classifier
            </h3>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '9.5px', fontWeight: 700, background: 'rgba(191,155,255,0.15)', color: '#bf9bff', border: '0.5px solid rgba(191,155,255,0.3)', padding: '1px 8px', borderRadius: '4px' }}>LOGISTIC</span>
          </div>
          <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.40)' }}>
            {training.classification.algorithm} · target = ROM grade ≥ {training.gradeThreshold}% Mn
          </p>

          {/* Metrics */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '8px', paddingTop: '8px', borderTop: '0.5px solid rgba(255,255,255,0.07)', fontFamily: 'JetBrains Mono, monospace', fontSize: '11px' }}>
            {[{ l: 'CV AUC', v: num(cm.auc, 3), c: '#bf9bff' }, { l: 'CV Acc.', v: `${num(cm.accuracy * 100, 1)}%`, c: '#bf9bff' }, { l: 'CV F1', v: num(cm.f1, 3), c: '#bf9bff' }, { l: 'Train AUC', v: num(cTrain.auc, 3), c: 'rgba(255,255,255,0.45)' }].map((m) => (
              <div key={m.l}>
                <div style={S.eyebrow}>{m.l}</div>
                <div style={{ fontWeight: 700, color: m.c }}>{m.v}</div>
              </div>
            ))}
          </div>

          {/* Loss curve */}
          <div>
            <div style={S.eyebrow}>Gradient-descent loss (BCE + L2)</div>
            <div style={{ height: '110px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={clfLoss} margin={{ top: 4, right: 6, bottom: 0, left: -18 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="epoch" tick={S.tick} stroke="rgba(255,255,255,0.12)" />
                  <YAxis tick={S.tick} stroke="rgba(255,255,255,0.12)" width={44} />
                  <Tooltip contentStyle={S.tooltip} formatter={(v: number) => v.toFixed(4)} />
                  <Line type="monotone" dataKey="loss" stroke="#ff6b6b" dot={false} strokeWidth={1.8} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Actual vs Predicted scatter */}
          <div>
            <div style={S.eyebrow}>Out-of-fold grade: actual vs predicted</div>
            <div style={{ height: '170px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 6, right: 10, bottom: 4, left: -18 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                  <XAxis type="number" dataKey="actual" name="Actual %Mn" domain={[18, 34]} tick={S.tick} stroke="rgba(255,255,255,0.12)" />
                  <YAxis type="number" dataKey="predicted" name="Predicted %Mn" domain={[18, 34]} tick={S.tick} stroke="rgba(255,255,255,0.12)" width={40} />
                  <Tooltip contentStyle={S.tooltip} />
                  <ReferenceLine segment={[{ x: 18, y: 18 }, { x: 34, y: 34 }]} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 3" />
                  <Scatter data={scatter} fill="#0e9166" fillOpacity={0.75} />
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      {/* ── Predictions Table ──────────────────────────────────────────────── */}
      <div style={S.panel}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '10px', borderBottom: '0.5px solid rgba(255,255,255,0.07)', marginBottom: '10px' }}>
          <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px' }}>
            <Database style={{ width: '13px', height: '13px', color: '#30bf99' }} />
            Mine inventory &amp; out-of-fold predictions
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.38)' }}>Sort:</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              style={{ background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.15)', borderRadius: '7px', padding: '0.3rem 0.6rem', fontSize: '11.5px', fontWeight: 600, color: 'rgba(255,255,255,0.80)', fontFamily: 'inherit', outline: 'none', cursor: 'pointer' }}
            >
              <option style={{ background: '#3a3a3c' }} value="dataset">Dataset order</option>
              <option style={{ background: '#3a3a3c' }} value="grade">Predicted grade</option>
              <option style={{ background: '#3a3a3c' }} value="prob">Premium probability</option>
              <option style={{ background: '#3a3a3c' }} value="capacity">Capacity</option>
            </select>
          </div>
        </div>

        <div style={{ overflowX: 'auto', maxHeight: '440px', borderRadius: '8px', border: '0.5px solid rgba(255,255,255,0.08)' }}>
          <table style={{ width: '100%', fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', borderCollapse: 'collapse' }}>
            <thead style={{ background: 'rgba(255,255,255,0.05)', position: 'sticky', top: 0, zIndex: 10 }}>
              <tr style={{ color: 'rgba(255,255,255,0.35)', fontSize: '9.5px', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                {['Mine', 'State', 'Operator', 'Method', 'Cap kt/yr', 'Actual %Mn', 'Pred %Mn', 'Δ', `P(≥${training.gradeThreshold})`].map((h, i) => (
                  <th key={h} style={{ padding: '7px 10px', fontWeight: 700, textAlign: i > 3 ? 'right' : 'left', borderBottom: '0.5px solid rgba(255,255,255,0.08)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const absRes = Math.abs(p.residual);
                const resColor = absRes <= 1.5 ? '#30bf99' : absRes <= 3 ? '#ffb340' : '#ff6b6b';
                const premium = p.highProb >= 0.5;
                return (
                  <tr key={p.mineId} style={{ borderTop: '0.5px solid rgba(255,255,255,0.05)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                    <td style={{ padding: '6px 10px', color: 'rgba(255,255,255,0.80)', fontWeight: 600 }}>{p.name}</td>
                    <td style={{ padding: '6px 10px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(14,145,102,0.12)', border: '0.5px solid rgba(14,145,102,0.25)', color: '#30bf99', borderRadius: '4px', padding: '0px 6px', fontSize: '9.5px', fontWeight: 700 }}>{p.state}</span>
                    </td>
                    <td style={{ padding: '6px 10px', color: 'rgba(255,255,255,0.45)' }}>{p.operator}</td>
                    <td style={{ padding: '6px 10px', color: 'rgba(255,255,255,0.45)' }}>{p.miningMethod}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', color: 'rgba(255,255,255,0.70)' }}>{num(p.capacityKt)}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', color: 'rgba(255,255,255,0.80)' }}>{num(p.actualGrade, 1)}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', color: 'rgba(255,255,255,0.80)' }}>{num(p.cvPredictedGrade, 1)}</td>
                    <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700, color: resColor }}>
                      {p.residual >= 0 ? '+' : ''}{num(p.residual, 1)}
                    </td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                      <span style={{ fontWeight: 700, color: premium ? '#30bf99' : 'rgba(255,255,255,0.30)' }}>
                        {num(p.highProb * 100, 0)}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Governance ─────────────────────────────────────────────────────── */}
      <div style={S.panel}>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '10px', paddingBottom: '8px', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
          <ShieldCheck style={{ width: '13px', height: '13px', color: '#30bf99' }} />
          Training governance &amp; known limits
        </h3>
        <ul style={{ paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '6px', color: 'rgba(255,255,255,0.50)', fontSize: '11.5px', lineHeight: 1.7 }}>
          <li>Source rows are public and <strong style={{ color: 'rgba(255,255,255,0.80)' }}>indicative</strong> (IBM Indian Minerals Yearbook, GSI memoirs, MOIL/SMIORE/State DMG returns) — replace with audited mine-plan values before operational use.</li>
          <li>{training.rows} rows is a small training set; both heads use L2 regularisation and report <strong style={{ color: 'rgba(255,255,255,0.80)' }}>out-of-fold</strong> metrics only. Treat R²/AUC as indicative, not deployment-grade.</li>
          <li>'Predicted %Mn' is produced by a model that never saw that mine (5-fold CV). 'Train R²' is shown for contrast and is expected to be higher — the gap is the overfit signal.</li>
          <li>Coordinates and grades are approximate centroids/ROM values, not survey-accurate. Reservoirs of uncertainty (sampling, moisture, dilution) are not modelled.</li>
        </ul>
      </div>
    </div>
  );
};
