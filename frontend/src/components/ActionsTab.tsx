import React, { useState, useMemo } from 'react';
import {
  Zap,
  CheckCircle2,
  AlertTriangle,
  Sliders,
  FileCheck,
  PlayCircle,
  TrendingUp,
  Cpu,
  Clock,
  DollarSign,
  Target,
  X,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
} from 'recharts';
import { MINES } from '../core/geology';
import { buildAlerts, actionCards } from '../core/forecast';

interface ActionsTabProps {
  selectedMineId: string;
  selectedActionId?: string;
}

/* ─── What-If Simulation ────────────────────────────────────────────────── */
interface WhatIfState {
  extraDumpers: number;
  drillRigs: number;
  blastFreq: number;
  maintenanceBudget: number;
}

function runWhatIf(base: number, params: WhatIfState): number {
  const dumperGain = params.extraDumpers * 820;
  const drillGain = params.drillRigs * 420;
  const blastGain = (params.blastFreq - 1) * 340;
  const maintGain = (params.maintenanceBudget - 10) * 15;
  return Math.round(base + dumperGain + drillGain + blastGain + maintGain);
}

/* ─── Playbook Rules ────────────────────────────────────────────────────── */
const PLAYBOOK_RULES = [
  { id: 'PB-01', trigger: 'Haulage bottleneck > 25%', action: 'Request 2× additional 50T dumpers from Nagpur yard', horizon: 'Immediate (24h)', confidence: 94 },
  { id: 'PB-02', trigger: 'Drill availability < 70%', action: 'Schedule preventive overhaul for drill fleet D3/D4', horizon: '3–7 days', confidence: 88 },
  { id: 'PB-03', trigger: 'P(miss 30d) > 40%', action: 'Initiate inter-mine ore transfer protocol (Nagpur → Balaghat)', horizon: '7–14 days', confidence: 76 },
  { id: 'PB-04', trigger: 'Rain forecast > 40 mm/3d', action: 'Advance blast schedule; pre-position ore stock at ROM pad', horizon: 'Pre-emptive 48h', confidence: 82 },
  { id: 'PB-05', trigger: 'OCI < 12 months', action: 'Escalate drill programme; fast-track UNFC 221 infill drilling', horizon: '30–60 days', confidence: 71 },
  { id: 'PB-06', trigger: 'F2 deviation > ±5%', action: 'Investigate face sampling protocol; re-assay primary splits', horizon: 'Immediate', confidence: 90 },
];

/* ─── OR-Tools Portfolio Optimizer Simulation ───────────────────────────── */
function optimizePortfolio(cards: ReturnType<typeof actionCards>, budget: number) {
  // Greedy knapsack approximation (simulates OR-Tools CP-SAT)
  const sorted = [...cards].sort((a, b) => b.gainPerLakh - a.gainPerLakh);
  let remaining = budget;
  const selected: typeof cards = [];
  for (const c of sorted) {
    if (c.costLakh <= remaining) {
      selected.push(c);
      remaining -= c.costLakh;
    }
  }
  const totalGain = selected.reduce((s, c) => s + c.predictedGainT, 0);
  const totalCost = selected.reduce((s, c) => s + c.costLakh, 0);
  return { selected, totalGain, totalCost, remaining };
}

/* ─── Main Component ────────────────────────────────────────────────────── */
export const ActionsTab: React.FC<ActionsTabProps> = ({ selectedActionId }) => {
  const alerts = buildAlerts();
  const primaryAlert = alerts[0] || buildAlerts()[0];
  const cards = actionCards(primaryAlert);

  const [activeCardId, setActiveCardId] = useState<string>(selectedActionId || cards[0]?.id || '');
  const [approvedCards, setApprovedCards] = useState<Record<string, boolean>>({});
  const [showApprovalModal, setShowApprovalModal] = useState<boolean>(false);
  const [signerRole, setSignerRole] = useState<string>('P. Nair (Production Planner)');
  const [activePanel, setActivePanel] = useState<'cards' | 'optimizer' | 'whatif' | 'playbook'>('cards');

  // What-If state
  const [whatIf, setWhatIf] = useState<WhatIfState>({
    extraDumpers: 0,
    drillRigs: 0,
    blastFreq: 1,
    maintenanceBudget: 10,
  });
  const baseShortfall = primaryAlert?.shortfallT || 4800;
  const simulatedOutput = runWhatIf(-baseShortfall, whatIf);
  const netChange = simulatedOutput - (-baseShortfall);

  // Optimizer
  const [optimizerBudget, setOptimizerBudget] = useState<number>(50);
  const portfolio = useMemo(() => optimizePortfolio(cards, optimizerBudget), [cards, optimizerBudget]);

  const selectedCard = cards.find((c) => c.id === activeCardId) || cards[0];

  const handleApprove = () => {
    if (selectedCard) {
      setApprovedCards((prev) => ({ ...prev, [selectedCard.id]: true }));
      setShowApprovalModal(false);
    }
  };

  // Radar chart data for selected card feasibility
  const radarData = selectedCard ? [
    { subject: 'Tonnes', A: Math.min(100, (selectedCard.predictedGainT / 8000) * 100) },
    { subject: 'Cost Eff.', A: Math.min(100, selectedCard.gainPerLakh * 6) },
    { subject: 'Lead Time', A: Math.max(0, 100 - selectedCard.leadDays * 8) },
    { subject: 'Feasibility', A: selectedCard.feasibility.filter(f => f.ok).length / selectedCard.feasibility.length * 100 },
    { subject: 'Confidence', A: 72 + (selectedCard.id.charCodeAt(selectedCard.id.length - 1) % 20) },
  ] : [];

  return (
    <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', background: '#161618', minHeight: '100vh', color: 'rgba(255,255,255,0.92)' }}>
      {/* Top Banner */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', background: '#2c2c2e', border: '0.5px solid rgba(255,255,255,0.09)', borderRadius: '12px', padding: '1rem 1.125rem', boxShadow: '0 2px 8px rgba(0,0,0,0.45)' }}>
        <div>
          <h2 style={{ fontSize: '14px', fontWeight: 700, color: 'rgba(255,255,255,0.92)', display: 'flex', alignItems: 'center', gap: '7px', letterSpacing: '-0.01em' }}>
            <Zap style={{ width: '15px', height: '15px', color: '#ffb340' }} />
            Corrective Action Engine — OR-Tools Optimiser &amp; Human Approval
            <span style={{ fontSize: '10px', fontFamily: 'JetBrains Mono, monospace', background: 'rgba(255,159,10,0.15)', color: '#ffb340', border: '0.5px solid rgba(255,159,10,0.35)', padding: '1px 7px', borderRadius: '4px' }}>D7</span>
          </h2>
          <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.35)', marginTop: '3px' }}>
            Rule-Based Playbook + CP-SAT Constraint Optimizer · Ranked by Shortfall Tonnes / ₹ Lakh
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {[{ l: 'd7-v3.1.0', c: 'green' }, { l: 'Human-in-Loop', c: 'green' }, { l: `${cards.filter(c => !approvedCards[c.id]).length} Pending`, c: 'amber' }].map((chip) => (
            <span key={chip.l} style={{ display: 'inline-flex', alignItems: 'center', background: chip.c === 'green' ? 'rgba(14,145,102,0.15)' : 'rgba(255,159,10,0.15)', border: `0.5px solid ${chip.c === 'green' ? 'rgba(14,145,102,0.35)' : 'rgba(255,159,10,0.35)'}`, color: chip.c === 'green' ? '#30bf99' : '#ffb340', borderRadius: '999px', padding: '2px 9px', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{chip.l}</span>
          ))}
        </div>
      </div>

      {/* Sub-navigation */}
      <div style={{ display: 'flex', background: 'rgba(255,255,255,0.06)', borderRadius: '8px', padding: '3px', border: '0.5px solid rgba(255,255,255,0.1)', gap: '2px', width: 'fit-content' }}>
        {([
          { id: 'cards',     label: 'Action Cards',        icon: <Zap       style={{ width: '11px', height: '11px' }} /> },
          { id: 'optimizer', label: 'Portfolio Optimizer', icon: <Cpu       style={{ width: '11px', height: '11px' }} /> },
          { id: 'whatif',    label: 'What-If Simulation',  icon: <PlayCircle style={{ width: '11px', height: '11px' }} /> },
          { id: 'playbook',  label: 'Playbook Rules',      icon: <FileCheck  style={{ width: '11px', height: '11px' }} /> },
        ] as const).map((tab) => (
          <button key={tab.id} onClick={() => setActivePanel(tab.id)} style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '0.3125rem 0.75rem', fontSize: '12px', fontWeight: 600, borderRadius: '6px', border: 'none', cursor: 'pointer', transition: 'all 120ms ease', background: activePanel === tab.id ? '#3a3a3c' : 'transparent', color: activePanel === tab.id ? '#30bf99' : 'rgba(255,255,255,0.40)', boxShadow: activePanel === tab.id ? '0 1px 3px rgba(0,0,0,0.4)' : 'none', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
            {tab.icon}{tab.label}
          </button>
        ))}
      </div>

      {/* ── PANEL: Action Cards ────────────────────────────────────────── */}
      {activePanel === 'cards' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '1.25rem' }}>
          {/* Card List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2px' }}>
              <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Sliders style={{ width: '14px', height: '14px', color: '#30bf99' }} />
                Ranked Candidates ({cards.length})
              </h3>
            </div>
            {cards.map((card, idx) => {
              const isSelected = card.id === selectedCard?.id;
              const isApproved = !!approvedCards[card.id];
              return (
                <div
                  key={card.id}
                  onClick={() => setActiveCardId(card.id)}
                  style={{ padding: '0.875rem 1rem', borderRadius: '10px', cursor: 'pointer', border: `0.5px solid ${isSelected ? 'rgba(14,145,102,0.5)' : 'rgba(255,255,255,0.08)'}`, background: isSelected ? 'rgba(14,145,102,0.08)' : 'rgba(255,255,255,0.04)', outline: isSelected ? '1px solid rgba(14,145,102,0.3)' : 'none', outlineOffset: '-1px', transition: 'all 130ms ease' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontSize: '9.5px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: '#30bf99', background: 'rgba(14,145,102,0.15)', border: '0.5px solid rgba(14,145,102,0.3)', padding: '1px 7px', borderRadius: '4px' }}>Rank #{idx + 1}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', background: isApproved ? 'rgba(14,145,102,0.15)' : 'rgba(255,159,10,0.15)', border: `0.5px solid ${isApproved ? 'rgba(14,145,102,0.35)' : 'rgba(255,159,10,0.35)'}`, color: isApproved ? '#30bf99' : '#ffb340', borderRadius: '999px', padding: '1px 7px', fontSize: '9.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      {isApproved ? <><CheckCircle2 style={{ width: '9px', height: '9px' }} /> Approved</> : 'Pending'}
                    </span>
                  </div>
                  <h4 style={{ fontWeight: 700, fontSize: '13px', color: 'rgba(255,255,255,0.88)', marginBottom: '6px', letterSpacing: '-0.008em' }}>{card.title}</h4>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontFamily: 'JetBrains Mono, monospace', fontSize: '10.5px', paddingTop: '6px', borderTop: '0.5px solid rgba(255,255,255,0.07)' }}>
                    <span style={{ fontWeight: 700, color: '#30bf99' }}>+{card.predictedGainT.toLocaleString()} t</span>
                    <span style={{ color: 'rgba(255,255,255,0.40)' }}>₹{card.costLakh} L</span>
                    <span style={{ color: 'rgba(255,255,255,0.30)' }}>{card.leadDays}d Lead</span>
                  </div>
                  <div style={{ marginTop: '6px', height: '3px', background: 'rgba(255,255,255,0.08)', borderRadius: '99px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: '#0e9166', borderRadius: '99px', width: `${Math.min(100, (card.gainPerLakh / 250) * 100).toFixed(0)}%`, boxShadow: '0 0 5px rgba(14,145,102,0.5)' }} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Card Detail */}
          {selectedCard && (
            <div>
              <div style={{ background: '#2c2c2e', border: '0.5px solid rgba(255,255,255,0.09)', borderRadius: '12px', padding: '1.25rem', boxShadow: '0 2px 8px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', paddingBottom: '1rem', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
                  <div>
                    <span style={{ fontSize: '9.5px', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, background: 'rgba(14,145,102,0.15)', color: '#30bf99', border: '0.5px solid rgba(14,145,102,0.3)', padding: '1px 8px', borderRadius: '4px', display: 'inline-block', marginBottom: '8px' }}>{selectedCard.psExample}</span>
                    <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.012em', marginBottom: '4px' }}>{selectedCard.title}</h3>
                    <p style={{ fontSize: '11.5px', color: 'rgba(255,255,255,0.40)' }}>Target Mine: {MINES.find((m) => m.id === primaryAlert.mineId)?.name || 'Balaghat Deep Cast'}</p>
                  </div>
                  {approvedCards[selectedCard.id] ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(14,145,102,0.12)', border: '0.5px solid rgba(14,145,102,0.35)', color: '#30bf99', padding: '0.5rem 0.875rem', borderRadius: '8px', fontSize: '12px', fontWeight: 700 }}>
                      <CheckCircle2 style={{ width: '13px', height: '13px' }} /> APPROVED &amp; DISPATCHED
                    </div>
                  ) : (
                    <button onClick={() => setShowApprovalModal(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', background: 'linear-gradient(160deg,#17a87e,#0a7a54)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '0.5rem 1.125rem', fontSize: '12.5px', fontWeight: 700, color: '#fff', cursor: 'pointer', boxShadow: '0 1px 4px rgba(14,145,102,0.4)', transition: 'all 130ms ease' }}>
                      Authorize &amp; Approve →
                    </button>
                  )}
                </div>

                {/* Rationale */}
                <div style={{ padding: '0.875rem', background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.08)', borderRadius: '8px' }}>
                  <h4 style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', marginBottom: '6px' }}>Action Rationale &amp; Counterfactual</h4>
                  <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.65)', lineHeight: 1.65 }}>{selectedCard.rationale}</p>
                </div>

                {/* KPIs */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  <div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginBottom: '10px', fontFamily: 'JetBrains Mono, monospace' }}>
                      {[{ icon: <TrendingUp style={{ width: '13px', height: '13px' }} />, label: 'Recovered', value: `+${selectedCard.predictedGainT.toLocaleString()} t`, color: '#30bf99' }, { icon: <DollarSign style={{ width: '13px', height: '13px' }} />, label: 'Cost', value: `₹${selectedCard.costLakh} L`, color: 'rgba(255,255,255,0.80)' }, { icon: <Clock style={{ width: '13px', height: '13px' }} />, label: 'Lead Time', value: `${selectedCard.leadDays}d`, color: '#ffb340' }].map((k) => (
                        <div key={k.label} style={{ padding: '0.75rem', background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.08)', borderRadius: '8px', textAlign: 'center' }}>
                          <div style={{ color: k.color, marginBottom: '4px', display: 'flex', justifyContent: 'center' }}>{k.icon}</div>
                          <span style={{ fontSize: '9.5px', color: 'rgba(255,255,255,0.35)', display: 'block', marginBottom: '3px' }}>{k.label}</span>
                          <span style={{ fontWeight: 700, fontSize: '14px', color: k.color }}>{k.value}</span>
                        </div>
                      ))}
                    </div>

                    {/* Feasibility */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                      <h4 style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', marginBottom: '4px' }}>Feasibility Checks</h4>
                      {selectedCard.feasibility.map((item, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.08)', borderRadius: '7px', fontSize: '11.5px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                            {item.ok ? <CheckCircle2 style={{ width: '13px', height: '13px', color: '#30bf99' }} /> : <AlertTriangle style={{ width: '13px', height: '13px', color: '#ffb340' }} />}
                            <span style={{ fontWeight: 600, color: 'rgba(255,255,255,0.80)' }}>{item.label}</span>
                          </div>
                          <span style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.38)', fontFamily: 'JetBrains Mono, monospace' }}>{item.detail}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Radar Chart */}
                  <div>
                    <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', marginBottom: '8px' }}>Effectiveness Radar</div>
                    <div style={{ height: '210px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <RadarChart data={radarData}>
                          <PolarGrid stroke="rgba(255,255,255,0.1)" />
                          <PolarAngleAxis dataKey="subject" tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.45)', fontFamily: 'JetBrains Mono, monospace' }} />
                          <Radar dataKey="A" stroke="#0e9166" fill="#0e9166" fillOpacity={0.2} strokeWidth={2} />
                        </RadarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── PANEL: Portfolio Optimizer ─────────────────────────────── */}
      {activePanel === 'optimizer' && (
        <div>
          <div style={{ background: '#2c2c2e', border: '0.5px solid rgba(255,255,255,0.09)', borderRadius: '12px', padding: '1.25rem', boxShadow: '0 2px 8px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '0.875rem', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
              <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px' }}>
                <Cpu style={{ width: '14px', height: '14px', color: '#30bf99' }} />
                CP-SAT Portfolio Optimizer (OR-Tools Simulation)
              </h3>
              <span style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.50)', borderRadius: '999px', padding: '2px 9px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.05em' }}>Greedy Knapsack Approximation</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '1.5rem' }}>
              {/* Budget slider */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.35)', marginBottom: '6px' }}>Total Available Budget</div>
                  <div style={{ fontSize: '28px', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.02em' }}>₹{optimizerBudget} Lakh</div>
                </div>
                <input type="range" min="10" max="150" step="5" value={optimizerBudget} onChange={(e) => setOptimizerBudget(Number(e.target.value))} style={{ width: '100%', cursor: 'pointer', accentColor: '#0e9166' }} />
                <div style={{ padding: '0.875rem', background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.08)', borderRadius: '8px', fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {[{ l: 'Actions Selected', v: `${portfolio.selected.length} / ${cards.length}`, c: 'rgba(255,255,255,0.80)' }, { l: 'Tonnes Recovered', v: `+${portfolio.totalGain.toLocaleString()} t`, c: '#30bf99' }, { l: 'Budget Spent', v: `₹${portfolio.totalCost} Lakh`, c: 'rgba(255,255,255,0.80)' }, { l: 'Remaining', v: `₹${portfolio.remaining.toFixed(0)} Lakh`, c: '#30bf99' }].map((r) => (
                    <div key={r.l} style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'rgba(255,255,255,0.40)' }}>{r.l}</span>
                      <strong style={{ color: r.c }}>{r.v}</strong>
                    </div>
                  ))}
                </div>
              </div>

              {/* Portfolio Bar Chart */}
              <div>
                <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.35)', marginBottom: '10px' }}>Gain vs Cost by Action (Selected = Green)</div>
                <div style={{ height: '250px' }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={cards.map((c) => ({ name: c.title.slice(0, 16) + '…', gain: c.predictedGainT, cost: c.costLakh, selected: portfolio.selected.some(s => s.id === c.id) }))} margin={{ top: 5, right: 10, left: -15, bottom: 40 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis dataKey="name" tick={{ fontSize: 8.5, fill: 'rgba(255,255,255,0.35)', fontFamily: 'JetBrains Mono, monospace' }} angle={-30} textAnchor="end" />
                      <YAxis tick={{ fontSize: 9, fill: 'rgba(255,255,255,0.35)', fontFamily: 'JetBrains Mono, monospace' }} />
                      <Tooltip contentStyle={{ background: '#3a3a3c', border: '0.5px solid rgba(255,255,255,0.14)', borderRadius: '8px', color: 'rgba(255,255,255,0.88)', fontSize: '11px', fontFamily: 'JetBrains Mono, monospace' }} />
                      <Bar dataKey="gain" name="Tonnes Recovered" radius={[3, 3, 0, 0]}>
                        {cards.map((c) => (
                          <Cell key={c.id} fill={portfolio.selected.some(s => s.id === c.id) ? '#0e9166' : 'rgba(255,255,255,0.15)'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Selected actions list */}
            <div>
              <div style={{ fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.35)', marginBottom: '10px' }}>Optimizer-Selected Actions</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {portfolio.selected.map((c, i) => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '0.625rem 0.875rem', borderRadius: '8px', background: 'rgba(14,145,102,0.08)', border: '0.5px solid rgba(14,145,102,0.25)', fontFamily: 'JetBrains Mono, monospace', fontSize: '11px' }}>
                    <span style={{ fontWeight: 700, color: '#30bf99', width: '18px' }}>#{i + 1}</span>
                    <span style={{ flex: 1, fontWeight: 600, color: 'rgba(255,255,255,0.80)', fontFamily: 'inherit', fontSize: '12px' }}>{c.title}</span>
                    <span style={{ fontWeight: 700, color: '#30bf99' }}>+{c.predictedGainT.toLocaleString()} t</span>
                    <span style={{ color: 'rgba(255,255,255,0.45)' }}>₹{c.costLakh} L</span>
                    <span style={{ color: '#30bf99' }}>{c.gainPerLakh} t/₹L</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── PANEL: What-If Simulation ────────────────────────────────────── */}
      {activePanel === 'whatif' && (
        <div style={{ background: '#2c2c2e', border: '0.5px solid rgba(255,255,255,0.09)', borderRadius: '12px', padding: '1.25rem', boxShadow: '0 2px 8px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '0.875rem', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px' }}>
              <PlayCircle style={{ width: '14px', height: '14px', color: '#30bf99' }} />
              What-If Production Simulation
            </h3>
            <div style={{ padding: '0.375rem 0.875rem', borderRadius: '8px', fontFamily: 'JetBrains Mono, monospace', fontSize: '13px', fontWeight: 700, background: netChange >= 0 ? 'rgba(14,145,102,0.12)' : 'rgba(255,59,48,0.12)', border: `0.5px solid ${netChange >= 0 ? 'rgba(14,145,102,0.35)' : 'rgba(255,59,48,0.35)'}`, color: netChange >= 0 ? '#30bf99' : '#ff6b6b' }}>
              Net Change: {netChange >= 0 ? '+' : ''}{netChange.toLocaleString()} t / 7d
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
            {/* Controls */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.125rem' }}>
              {[
                { key: 'extraDumpers' as const,      label: 'Extra Dumpers (50T)',   min: 0, max: 6,  step: 1,   unit: 'units',  color: '#0e9166' },
                { key: 'drillRigs' as const,         label: 'Additional Drill Rigs', min: 0, max: 4,  step: 1,   unit: 'rigs',   color: '#ffb340' },
                { key: 'blastFreq' as const,         label: 'Blast Frequency',       min: 1, max: 3,  step: 0.5, unit: '× / day', color: '#ff6b6b' },
                { key: 'maintenanceBudget' as const, label: 'Maintenance Budget',    min: 5, max: 40, step: 5,   unit: '₹ Lakh', color: '#bf9bff' },
              ].map(({ key, label, min, max, step, unit, color }) => (
                <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.75)' }}>{label}</label>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, fontSize: '13px', color }}>{whatIf[key]} {unit}</span>
                  </div>
                  <input type="range" min={min} max={max} step={step} value={whatIf[key]} onChange={(e) => setWhatIf((s) => ({ ...s, [key]: Number(e.target.value) }))} style={{ width: '100%', cursor: 'pointer', accentColor: color }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'rgba(255,255,255,0.30)', fontFamily: 'JetBrains Mono, monospace' }}>
                    <span>{min} {unit}</span><span>{max} {unit}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Simulation Output */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
              <div style={{ padding: '1.25rem', borderRadius: '12px', border: '0.5px solid rgba(14,145,102,0.35)', background: 'rgba(14,145,102,0.08)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#30bf99' }}>Simulated 7-Day Output</div>
                <div style={{ fontSize: '36px', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.03em' }}>{simulatedOutput.toLocaleString()} t</div>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.45)' }}>vs. Base Shortfall: {(-baseShortfall).toLocaleString()} t</div>
                <div style={{ fontSize: '15px', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: netChange >= 0 ? '#30bf99' : '#ff6b6b' }}>
                  {netChange >= 0 ? '+' : ''}{netChange.toLocaleString()} t ({((netChange / baseShortfall) * 100).toFixed(0)}% recovery)
                </div>
              </div>

              <div style={{ padding: '0.875rem', background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.08)', borderRadius: '8px', fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)' }}>Marginal Contribution</div>
                {[
                  { label: 'Extra Dumpers',      gain: whatIf.extraDumpers * 820 },
                  { label: 'Drill Rigs',          gain: whatIf.drillRigs * 420 },
                  { label: 'Blast Frequency',    gain: (whatIf.blastFreq - 1) * 340 },
                  { label: 'Maintenance Budget', gain: (whatIf.maintenanceBudget - 10) * 15 },
                ].map((row) => (
                  <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: 'rgba(255,255,255,0.45)' }}>{row.label}</span>
                    <strong style={{ color: row.gain > 0 ? '#30bf99' : '#ff6b6b' }}>{row.gain >= 0 ? '+' : ''}{row.gain.toLocaleString()} t</strong>
                  </div>
                ))}
              </div>

              <button onClick={() => alert('Scenario saved and forwarded to Production Planner for review.')} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px', background: 'linear-gradient(160deg,#17a87e,#0a7a54)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '0.625rem 1rem', fontSize: '12.5px', fontWeight: 700, color: '#fff', cursor: 'pointer', boxShadow: '0 1px 4px rgba(14,145,102,0.4)', transition: 'all 130ms ease', width: '100%', fontFamily: 'inherit' }}>
                Save Scenario &amp; Forward to Planner →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PANEL: Playbook Rules ─────────────────────────────────────────── */}
      {activePanel === 'playbook' && (
        <div style={{ background: '#2c2c2e', border: '0.5px solid rgba(255,255,255,0.09)', borderRadius: '12px', padding: '1.25rem', boxShadow: '0 2px 8px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '0.875rem', borderBottom: '0.5px solid rgba(255,255,255,0.07)' }}>
            <h3 style={{ fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.88)', display: 'flex', alignItems: 'center', gap: '7px' }}>
              <FileCheck style={{ width: '14px', height: '14px', color: '#30bf99' }} />
              Standing Corrective Action Playbook ({PLAYBOOK_RULES.length} rules)
            </h3>
            <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.38)' }}>Auto-triggered by threshold breach · Requires human approval</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {PLAYBOOK_RULES.map((rule) => (
              <div key={rule.id} style={{ padding: '0.875rem 1rem', borderRadius: '8px', background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, fontSize: '10.5px', background: 'rgba(14,145,102,0.15)', color: '#30bf99', border: '0.5px solid rgba(14,145,102,0.3)', padding: '1px 8px', borderRadius: '4px' }}>{rule.id}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11.5px', color: 'rgba(255,255,255,0.55)' }}>
                      <AlertTriangle style={{ width: '11px', height: '11px', color: '#ffb340' }} />
                      <span>Trigger: <strong style={{ color: 'rgba(255,255,255,0.80)' }}>{rule.trigger}</strong></span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '10.5px', fontFamily: 'JetBrains Mono, monospace', color: 'rgba(255,255,255,0.38)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Clock style={{ width: '10px', height: '10px' }} />{rule.horizon}
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', background: rule.confidence > 85 ? 'rgba(14,145,102,0.15)' : rule.confidence > 75 ? 'rgba(255,159,10,0.15)' : 'rgba(255,59,48,0.15)', border: `0.5px solid ${rule.confidence > 85 ? 'rgba(14,145,102,0.35)' : rule.confidence > 75 ? 'rgba(255,159,10,0.35)' : 'rgba(255,59,48,0.35)'}`, color: rule.confidence > 85 ? '#30bf99' : rule.confidence > 75 ? '#ffb340' : '#ff6b6b', borderRadius: '999px', padding: '1px 8px', fontSize: '9.5px', fontWeight: 700, letterSpacing: '0.05em' }}>{rule.confidence}% conf.</span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '7px', paddingLeft: '4px' }}>
                  <Target style={{ width: '12px', height: '12px', color: '#30bf99', marginTop: '2px', flexShrink: 0 }} />
                  <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.65)', lineHeight: 1.6 }}>{rule.action}</p>
                </div>

                <div style={{ height: '3px', background: 'rgba(255,255,255,0.08)', borderRadius: '99px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: '99px', width: `${rule.confidence}%`, background: rule.confidence > 85 ? '#0e9166' : rule.confidence > 75 ? '#ffb340' : '#ff6b6b', boxShadow: `0 0 5px ${rule.confidence > 85 ? 'rgba(14,145,102,0.5)' : 'rgba(255,159,10,0.5)'}` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Approval Modal */}
      {showApprovalModal && selectedCard && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ background: '#2c2c2e', borderRadius: '14px', maxWidth: '420px', width: '100%', padding: '1.375rem', display: 'flex', flexDirection: 'column', gap: '1rem', boxShadow: '0 20px 60px rgba(0,0,0,0.7), 0 0 0 0.5px rgba(255,255,255,0.12)', animation: 'fade-up 0.24s cubic-bezier(0.16,1,0.3,1) both' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '0.875rem', borderBottom: '0.5px solid rgba(255,255,255,0.09)' }}>
              <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'rgba(255,255,255,0.92)', display: 'flex', alignItems: 'center', gap: '7px', letterSpacing: '-0.01em' }}>
                <FileCheck style={{ width: '14px', height: '14px', color: '#30bf99' }} />
                Human Approval &amp; Sign-off
              </h3>
              <button onClick={() => setShowApprovalModal(false)} style={{ background: 'rgba(255,255,255,0.07)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: '7px', padding: '0.3125rem', cursor: 'pointer', color: 'rgba(255,255,255,0.55)', display: 'flex', alignItems: 'center', transition: 'all 120ms ease' }}>
                <X style={{ width: '14px', height: '14px' }} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '12.5px' }}>
              <p style={{ color: 'rgba(255,255,255,0.60)', lineHeight: 1.6 }}>
                By approving, you authorize the dispatcher to execute:
                <strong style={{ display: 'block', color: 'rgba(255,255,255,0.88)', marginTop: '4px', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px' }}>{selectedCard.title}</strong>
              </p>
              <div style={{ padding: '0.875rem', background: 'rgba(255,255,255,0.04)', border: '0.5px solid rgba(255,255,255,0.08)', borderRadius: '8px', fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {[{ l: 'Expected Tonnes', v: `+${selectedCard.predictedGainT} t` }, { l: 'Budget', v: `₹${selectedCard.costLakh} Lakh` }, { l: 'Lead Time', v: `${selectedCard.leadDays} days` }].map((r) => (
                  <div key={r.l} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'rgba(255,255,255,0.40)' }}>{r.l}</span>
                    <strong style={{ color: 'rgba(255,255,255,0.88)' }}>{r.v}</strong>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <label style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)' }}>Authorized Signer Role</label>
                <select value={signerRole} onChange={(e) => setSignerRole(e.target.value)} style={{ background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.15)', borderRadius: '7px', padding: '0.5rem 0.75rem', fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.80)', fontFamily: 'inherit', outline: 'none', cursor: 'pointer' }}>
                  <option style={{ background: '#3a3a3c' }} value="P. Nair (Production Planner)">P. Nair (Production Planner)</option>
                  <option style={{ background: '#3a3a3c' }} value="Dr. A. Deshmukh (Chief Geologist)">Dr. A. Deshmukh (Chief Geologist)</option>
                  <option style={{ background: '#3a3a3c' }} value="R. Iyer (Maintenance Head)">R. Iyer (Maintenance Head)</option>
                  <option style={{ background: '#3a3a3c' }} value="V. Krishnan (General Manager, Mines)">V. Krishnan (General Manager, Mines)</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', paddingTop: '0.875rem', borderTop: '0.5px solid rgba(255,255,255,0.09)' }}>
              <button onClick={() => setShowApprovalModal(false)} style={{ background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '0.5rem 0.875rem', fontSize: '12.5px', fontWeight: 600, color: 'rgba(255,255,255,0.55)', cursor: 'pointer', fontFamily: 'inherit', transition: 'all 120ms ease' }}>Cancel</button>
              <button onClick={handleApprove} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', background: 'linear-gradient(160deg,#17a87e,#0a7a54)', border: '0.5px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '0.5rem 1.125rem', fontSize: '12.5px', fontWeight: 700, color: '#fff', cursor: 'pointer', boxShadow: '0 1px 4px rgba(14,145,102,0.4)', fontFamily: 'inherit', transition: 'all 130ms ease' }}>
                Sign &amp; Dispatch Action
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
