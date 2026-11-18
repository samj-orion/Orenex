import React from 'react';
import {
  Activity,
  Map,
  Layers,
  TrendingUp,
  Zap,
  GitCommit,
  Cpu,
  Bot,
  AlertTriangle,
  ChevronDown,
} from 'lucide-react';
import { MINES } from '../core/geology';
import { useBackendStatus } from '../hooks/useBackendStatus';

export type TabType = 'overview' | 'prospectivity' | 'reserves' | 'forecast' | 'actions' | 'reconciliation' | 'modelops' | 'training';

interface HeaderProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  selectedMineId: string;
  setSelectedMineId: (id: string) => void;
  openAlertsCount: number;
  isAssistantOpen: boolean;
  setIsAssistantOpen: (open: boolean) => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  selectedMineId,
  setSelectedMineId,
  openAlertsCount,
  isAssistantOpen,
  setIsAssistantOpen,
}) => {
  const backend = useBackendStatus();

  const tabs: { id: TabType; label: string; tag: string; icon: React.ReactNode }[] = [
    { id: 'overview',       label: 'Control Room',     tag: 'D1',  icon: <Activity    className="w-3.5 h-3.5" /> },
    { id: 'prospectivity',  label: 'Prospectivity',    tag: 'D3',  icon: <Map         className="w-3.5 h-3.5" /> },
    { id: 'reserves',       label: 'Reserve Model',    tag: 'D4',  icon: <Layers      className="w-3.5 h-3.5" /> },
    { id: 'forecast',       label: 'Shortfall Forecast',tag: 'D6', icon: <TrendingUp  className="w-3.5 h-3.5" /> },
    { id: 'actions',        label: 'Corrective Actions',tag: 'D7', icon: <Zap         className="w-3.5 h-3.5" /> },
    { id: 'reconciliation', label: 'Reconciliation',   tag: 'D8',  icon: <GitCommit   className="w-3.5 h-3.5" /> },
    { id: 'modelops',       label: 'Model Governance', tag: 'D10', icon: <Cpu         className="w-3.5 h-3.5" /> },
    { id: 'training',       label: 'AI Training',      tag: 'D11', icon: <Bot         className="w-3.5 h-3.5" /> },
  ];

  return (
    <header
      className="sticky top-0 z-30"
      style={{
        background: 'rgba(28,28,30,0.88)',
        backdropFilter: 'blur(24px) saturate(180%)',
        WebkitBackdropFilter: 'blur(24px) saturate(180%)',
        borderBottom: '0.5px solid rgba(255,255,255,0.09)',
        boxShadow: '0 1px 0 rgba(255,255,255,0.03), 0 2px 12px rgba(0,0,0,0.5)',
      }}
    >
      {/* ── System status strip (macOS menu-bar style) ──────────────────── */}
      <div
        style={{
          borderBottom: '0.5px solid rgba(255,255,255,0.06)',
          background: 'rgba(22,22,24,0.6)',
          padding: '0 1.5rem',
          height: '28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{
            fontSize: '10.5px',
            fontWeight: 600,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: '#30bf99',
          }}>
            MOIL Ltd
          </span>
          <span style={{ width: '1px', height: '10px', background: 'rgba(255,255,255,0.12)' }} />
          <span style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.40)', letterSpacing: '0.01em' }}>
            Balaghat–Nagpur Manganese Belt
          </span>
          <span style={{ fontSize: '10px', fontFamily: 'JetBrains Mono, monospace', color: 'rgba(255,255,255,0.22)' }}>
            PS SIH26009
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <span style={{ fontSize: '10px', fontFamily: 'JetBrains Mono, monospace', color: 'rgba(255,255,255,0.30)' }}>
            SNAPSHOT <span style={{ color: 'rgba(255,255,255,0.55)' }}>2026-10-03-a91</span>
          </span>
          <span style={{ fontSize: '10px', fontFamily: 'JetBrains Mono, monospace', color: 'rgba(255,255,255,0.30)' }}>
            MODEL <span style={{ color: 'rgba(255,255,255,0.55)' }}>m5-v6.3.0</span>
          </span>
          {/* Engine status dot */}
          <span
            title={`Engine: ${backend.base}${backend.version ? ` (v${backend.version})` : ''}`}
            style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10.5px', color: 'rgba(255,255,255,0.40)' }}
          >
            <span style={{
              width: '5px',
              height: '5px',
              borderRadius: '50%',
              background: backend.state === 'online' ? '#30bf99'
                        : backend.state === 'offline' ? '#ff9f0a'
                        : 'rgba(255,255,255,0.25)',
              boxShadow: backend.state === 'online' ? '0 0 6px rgba(48,191,153,0.6)' : 'none',
            }} />
            <span style={{ color: backend.state === 'online' ? '#30bf99' : 'rgba(255,255,255,0.35)' }}>
              {backend.state === 'online' ? 'Python engine live'
               : backend.state === 'offline' ? 'Local engine'
               : 'Probing…'}
            </span>
          </span>
        </div>
      </div>

      {/* ── Brand + controls bar ─────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0.625rem 1.5rem',
      }}>
        {/* Left: Logo + Mine Switcher */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          {/* Logo mark */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '34px',
              height: '34px',
              borderRadius: '9px',
              background: 'linear-gradient(145deg, #17a87e, #0a5c3e)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(14,145,102,0.45), inset 0 0.5px 0 rgba(255,255,255,0.2)',
              flexShrink: 0,
            }}>
              <svg viewBox="0 0 32 32" style={{ width: '18px', height: '18px', fill: 'none', stroke: '#E8C86A', strokeWidth: 2 }}>
                <path d="M8 22.5 16 7l8 15.5H8Z" strokeLinejoin="round" />
                <path d="M12.4 16.4h7.2" strokeWidth="1.6" />
              </svg>
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <h1 style={{
                  fontSize: '15px',
                  fontWeight: 700,
                  letterSpacing: '-0.02em',
                  color: 'rgba(255,255,255,0.95)',
                }}>
                  ORENEX
                </h1>
                <span style={{
                  fontSize: '10px',
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  background: 'rgba(14,145,102,0.18)',
                  border: '0.5px solid rgba(14,145,102,0.4)',
                  color: '#30bf99',
                  padding: '1px 7px',
                  borderRadius: '999px',
                }}>
                  Manganese AI
                </span>
              </div>
              <p style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.35)', marginTop: '1px', letterSpacing: '-0.005em' }}>
                Reserve intelligence · shortfall forecasting · human-approved action
              </p>
            </div>
          </div>

          {/* Divider */}
          <div style={{ width: '0.5px', height: '28px', background: 'rgba(255,255,255,0.1)' }} />

          {/* Mine site selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{
              fontSize: '10px',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: 'rgba(255,255,255,0.30)',
            }}>
              Mine Site
            </span>
            <div style={{ position: 'relative' }}>
              <select
                value={selectedMineId}
                onChange={(e) => setSelectedMineId(e.target.value)}
                style={{
                  appearance: 'none',
                  background: 'rgba(255,255,255,0.07)',
                  border: '0.5px solid rgba(255,255,255,0.15)',
                  borderRadius: '7px',
                  padding: '0.3125rem 2rem 0.3125rem 0.75rem',
                  fontSize: '12.5px',
                  fontWeight: 600,
                  color: 'rgba(255,255,255,0.88)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  boxShadow: 'inset 0 0.5px 0 rgba(255,255,255,0.06)',
                  outline: 'none',
                }}
                onFocus={(e) => {
                  (e.target as HTMLSelectElement).style.borderColor = 'rgba(14,145,102,0.55)';
                  (e.target as HTMLSelectElement).style.boxShadow = '0 0 0 3px rgba(14,145,102,0.12), inset 0 0.5px 0 rgba(255,255,255,0.06)';
                }}
                onBlur={(e) => {
                  (e.target as HTMLSelectElement).style.borderColor = 'rgba(255,255,255,0.15)';
                  (e.target as HTMLSelectElement).style.boxShadow = 'inset 0 0.5px 0 rgba(255,255,255,0.06)';
                }}
              >
                <option value="ALL">All Prototype Mines (3 Sites)</option>
                {MINES.map((mine) => (
                  <option key={mine.id} value={mine.id}>
                    {mine.name} ({mine.code}) — {mine.miningMethod}
                  </option>
                ))}
              </select>
              <ChevronDown
                style={{
                  width: '13px',
                  height: '13px',
                  color: 'rgba(255,255,255,0.45)',
                  position: 'absolute',
                  right: '8px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  pointerEvents: 'none',
                }}
              />
            </div>
          </div>
        </div>

        {/* Right: Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {/* Alert pill */}
          {openAlertsCount > 0 && (
            <button
              onClick={() => setActiveTab('forecast')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                background: 'rgba(255,59,48,0.14)',
                border: '0.5px solid rgba(255,59,48,0.35)',
                borderRadius: '7px',
                padding: '0.3125rem 0.75rem',
                fontSize: '12px',
                fontWeight: 600,
                color: '#ff6b6b',
                cursor: 'pointer',
                transition: 'all 130ms ease',
                boxShadow: '0 0 12px rgba(255,59,48,0.15)',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,59,48,0.22)';
                (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 16px rgba(255,59,48,0.25)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,59,48,0.14)';
                (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 0 12px rgba(255,59,48,0.15)';
              }}
            >
              <AlertTriangle style={{ width: '13px', height: '13px' }} />
              <span>{openAlertsCount} Alert{openAlertsCount > 1 ? 's' : ''}</span>
            </button>
          )}

          {/* AI Copilot button */}
          <button
            onClick={() => setIsAssistantOpen(!isAssistantOpen)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '7px',
              background: isAssistantOpen
                ? 'linear-gradient(160deg, #17a87e, #0a7a54)'
                : 'rgba(255,255,255,0.07)',
              border: isAssistantOpen
                ? '0.5px solid rgba(255,255,255,0.15)'
                : '0.5px solid rgba(255,255,255,0.14)',
              borderRadius: '8px',
              padding: '0.375rem 0.875rem',
              fontSize: '12.5px',
              fontWeight: 600,
              color: isAssistantOpen ? '#fff' : 'rgba(255,255,255,0.75)',
              cursor: 'pointer',
              transition: 'all 150ms cubic-bezier(0.25,0.46,0.45,0.94)',
              boxShadow: isAssistantOpen
                ? '0 1px 4px rgba(14,145,102,0.45), inset 0 0.5px 0 rgba(255,255,255,0.18)'
                : 'inset 0 0.5px 0 rgba(255,255,255,0.06)',
            }}
          >
            <Bot style={{ width: '14px', height: '14px' }} />
            <span>MOIL AI Copilot</span>
            <span style={{
              fontSize: '9.5px',
              fontFamily: 'JetBrains Mono, monospace',
              fontWeight: 500,
              background: isAssistantOpen ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.1)',
              color: isAssistantOpen ? '#fff' : 'rgba(255,255,255,0.45)',
              padding: '1px 5px',
              borderRadius: '4px',
            }}>
              ⌘K
            </span>
          </button>
        </div>
      </div>

      {/* ── Navigation tab bar ──────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '2px',
          padding: '0 1.5rem',
          borderTop: '0.5px solid rgba(255,255,255,0.06)',
          background: 'rgba(22,22,24,0.4)',
          overflowX: 'auto',
        }}
        className="no-scrollbar"
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '0.5625rem 0.875rem',
                fontSize: '12.5px',
                fontWeight: isActive ? 600 : 500,
                whiteSpace: 'nowrap',
                borderBottom: isActive ? '1.5px solid #30bf99' : '1.5px solid transparent',
                color: isActive ? '#30bf99' : 'rgba(255,255,255,0.45)',
                background: isActive ? 'rgba(14,145,102,0.07)' : 'transparent',
                cursor: 'pointer',
                transition: 'all 130ms ease',
                borderRadius: '8px 8px 0 0',
                letterSpacing: '-0.005em',
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.72)';
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.45)';
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                }
              }}
            >
              <span style={{ opacity: isActive ? 1 : 0.7 }}>{tab.icon}</span>
              <span>{tab.label}</span>
              <span style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '9px',
                letterSpacing: '0.05em',
                color: isActive ? 'rgba(48,191,153,0.65)' : 'rgba(255,255,255,0.18)',
                marginLeft: '1px',
              }}>
                {tab.tag}
              </span>
            </button>
          );
        })}
      </div>
    </header>
  );
};
