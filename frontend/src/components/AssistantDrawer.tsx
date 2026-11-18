import React, { useState, useRef, useEffect } from 'react';
import { Bot, Send, X, User } from 'lucide-react';
import { ask, type Answer } from '../core/assistant';
import { backendAsk } from '../core/api';
import { useBackendStatus } from '../hooks/useBackendStatus';

interface AssistantDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  selectedMineId: string;
}

interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  timestamp: string;
  queryIntent?: string;
  confidence?: number;
  engine?: 'python' | 'local';
}

export const AssistantDrawer: React.FC<AssistantDrawerProps> = ({ isOpen, onClose, selectedMineId }) => {
  const backend = useBackendStatus();
  const [inputQuery, setInputQuery] = useState<string>('');
  const [isThinking, setIsThinking] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'm-1',
      sender: 'assistant',
      text: 'MOIL Mining AI Copilot — I answer from the live engine. Ask about reserve position, shortfall forecasts, bottlenecks, or corrective actions for any mine.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!isOpen) return null;

  const handleSend = async (queryText?: string) => {
    const textToSend = queryText || inputQuery;
    if (!textToSend.trim()) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      sender: 'user',
      text: textToSend,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!queryText) setInputQuery('');
    setIsThinking(true);

    const ctx = {
      mineId: selectedMineId === 'ALL' ? 'MNE-BAL' : selectedMineId,
      targetId: null as string | null,
      cutOff: 18,
    };

    let response: Answer;
    let engine: 'python' | 'local' = 'local';
    try {
      response = await backendAsk(textToSend, ctx);
      engine = 'python';
    } catch {
      response = ask(textToSend, { ...ctx, estimate: null });
    }

    const responseText = response.blocks
      .map((b) => b.text || (b.items ? b.items.join('\n') : ''))
      .filter(Boolean)
      .join('\n\n');

    setIsThinking(false);

    const assistantMsg: ChatMessage = {
      id: `a-${Date.now()}`,
      sender: 'assistant',
      text: responseText || 'Evidence queried.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      queryIntent: response.intent,
      confidence: response.confidence || undefined,
      engine,
    };

    setMessages((prev) => [...prev, assistantMsg]);
  };

  const samplePrompts = [
    'What is the 7-day shortfall for Balaghat Deep Cast?',
    'Summarize UNFC reserves at 20% Mn cutoff.',
    'Why is haulage the binding constraint at Nagpur?',
    'Recommend actions for the upcoming wet spell.',
  ];

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 40,
          background: 'rgba(0,0,0,0.50)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          animation: 'fade-in 0.18s ease both',
        }}
      />

      {/* Drawer panel */}
      <div
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 50,
          width: '100%', maxWidth: '440px',
          background: '#1c1c1e',
          borderLeft: '0.5px solid rgba(255,255,255,0.1)',
          boxShadow: '-8px 0 40px rgba(0,0,0,0.7)',
          display: 'flex', flexDirection: 'column',
          animation: 'slide-left 0.28s cubic-bezier(0.16,1,0.3,1) both',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '1rem 1.125rem',
          background: 'linear-gradient(160deg, rgba(14,145,102,0.15), rgba(14,145,102,0.05))',
          borderBottom: '0.5px solid rgba(255,255,255,0.08)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '34px', height: '34px', borderRadius: '9px',
              background: 'linear-gradient(145deg, #17a87e, #0a7a54)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(14,145,102,0.45), inset 0 0.5px 0 rgba(255,255,255,0.2)',
            }}>
              <Bot style={{ width: '16px', height: '16px', color: '#fff' }} />
            </div>
            <div>
              <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'rgba(255,255,255,0.92)', letterSpacing: '-0.012em', display: 'flex', alignItems: 'center', gap: '6px' }}>
                MOIL Mining AI Copilot
                <span style={{
                  fontSize: '9.5px', fontFamily: 'JetBrains Mono, monospace',
                  background: 'rgba(14,145,102,0.2)', color: '#30bf99',
                  border: '0.5px solid rgba(14,145,102,0.35)',
                  padding: '1px 6px', borderRadius: '4px',
                }}>D1</span>
              </h3>
              <p style={{ fontSize: '10.5px', color: 'rgba(255,255,255,0.35)', marginTop: '1px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                Balaghat–Nagpur belt ·{' '}
                <span style={{ color: backend.state === 'online' ? '#30bf99' : 'rgba(255,255,255,0.35)' }}>
                  {backend.state === 'online' ? 'Python engine' : 'local engine'}
                </span>
                <span style={{
                  width: '5px', height: '5px', borderRadius: '50%',
                  background: backend.state === 'online' ? '#30bf99' : 'rgba(255,255,255,0.22)',
                  boxShadow: backend.state === 'online' ? '0 0 6px rgba(48,191,153,0.6)' : 'none',
                  display: 'inline-block',
                }} />
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              background: 'rgba(255,255,255,0.07)',
              border: '0.5px solid rgba(255,255,255,0.12)',
              borderRadius: '7px',
              padding: '0.3125rem',
              cursor: 'pointer',
              color: 'rgba(255,255,255,0.55)',
              display: 'flex', alignItems: 'center',
              transition: 'all 120ms ease',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.12)';
              (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.88)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.07)';
              (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.55)';
            }}
          >
            <X style={{ width: '15px', height: '15px' }} />
          </button>
        </div>

        {/* Quick prompts */}
        <div style={{
          padding: '0.75rem 1.125rem',
          borderBottom: '0.5px solid rgba(255,255,255,0.07)',
          background: 'rgba(255,255,255,0.02)',
        }}>
          <p style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.25)', marginBottom: '8px' }}>
            Suggested Queries
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {samplePrompts.map((prompt, idx) => (
              <button
                key={idx}
                onClick={() => handleSend(prompt)}
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '0.5px solid rgba(255,255,255,0.12)',
                  borderRadius: '6px',
                  padding: '0.3125rem 0.625rem',
                  fontSize: '11px',
                  color: 'rgba(255,255,255,0.58)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 120ms ease',
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: 'inherit',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(14,145,102,0.12)';
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(14,145,102,0.3)';
                  (e.currentTarget as HTMLButtonElement).style.color = '#30bf99';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)';
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.12)';
                  (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.58)';
                }}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>

        {/* Message stream */}
        <div style={{
          flex: 1, overflowY: 'auto',
          padding: '1rem 1.125rem',
          display: 'flex', flexDirection: 'column', gap: '1rem',
          background: '#161618',
        }}>
          {messages.map((msg) => (
            <div
              key={msg.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                flexDirection: msg.sender === 'user' ? 'row-reverse' : 'row',
                animation: 'fade-up 0.24s ease both',
              }}
            >
              {/* Avatar */}
              <div style={{
                width: '28px', height: '28px', borderRadius: '50%', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: msg.sender === 'user'
                  ? 'linear-gradient(145deg, #17a87e, #0a7a54)'
                  : '#2c2c2e',
                border: '0.5px solid rgba(255,255,255,0.12)',
                boxShadow: msg.sender === 'user' ? '0 1px 4px rgba(14,145,102,0.35)' : '0 1px 3px rgba(0,0,0,0.4)',
              }}>
                {msg.sender === 'user'
                  ? <User style={{ width: '13px', height: '13px', color: '#fff' }} />
                  : <Bot  style={{ width: '13px', height: '13px', color: '#30bf99' }} />
                }
              </div>

              {/* Bubble */}
              <div style={{
                maxWidth: '82%',
                borderRadius: msg.sender === 'user' ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
                padding: '0.625rem 0.875rem',
                fontSize: '12px',
                lineHeight: 1.65,
                background: msg.sender === 'user'
                  ? 'linear-gradient(160deg, #17a87e, #0a7a54)'
                  : '#2c2c2e',
                border: '0.5px solid ' + (msg.sender === 'user' ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.09)'),
                color: msg.sender === 'user' ? '#fff' : 'rgba(255,255,255,0.88)',
                boxShadow: msg.sender === 'user'
                  ? '0 2px 8px rgba(14,145,102,0.3)'
                  : '0 1px 4px rgba(0,0,0,0.4)',
              }}>
                <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{msg.text}</div>

                {(msg.queryIntent || msg.engine) && (
                  <div style={{
                    marginTop: '8px',
                    paddingTop: '6px',
                    borderTop: '0.5px solid rgba(255,255,255,0.1)',
                    display: 'flex', justifyContent: 'space-between',
                    fontSize: '9.5px', fontFamily: 'JetBrains Mono, monospace',
                    color: 'rgba(255,255,255,0.30)',
                    flexWrap: 'wrap', gap: '4px',
                  }}>
                    <span>Intent: {msg.queryIntent ?? '—'}</span>
                    <span style={{ display: 'flex', gap: '8px' }}>
                      {msg.engine === 'python' && <span style={{ color: '#30bf99' }}>via Python</span>}
                      {msg.engine === 'local'  && <span>local engine</span>}
                      {msg.confidence ? <span>Conf: {(msg.confidence * 100).toFixed(0)}%</span> : null}
                    </span>
                  </div>
                )}

                <div style={{
                  textAlign: 'right', fontSize: '9px', opacity: 0.45, marginTop: '4px',
                  fontFamily: 'JetBrains Mono, monospace',
                }}>
                  {msg.timestamp}
                </div>
              </div>
            </div>
          ))}

          {/* Thinking indicator */}
          {isThinking && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', animation: 'fade-in 0.2s ease both' }}>
              <div style={{
                width: '28px', height: '28px', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: '#2c2c2e', border: '0.5px solid rgba(255,255,255,0.12)',
              }}>
                <Bot style={{ width: '13px', height: '13px', color: '#30bf99' }} />
              </div>
              <div style={{
                background: '#2c2c2e',
                border: '0.5px solid rgba(255,255,255,0.09)',
                borderRadius: '4px 12px 12px 12px',
                padding: '0.625rem 0.875rem',
                display: 'flex', alignItems: 'center', gap: '5px',
              }}>
                {[0, 1, 2].map((i) => (
                  <span key={i} style={{
                    width: '5px', height: '5px', borderRadius: '50%',
                    background: '#30bf99',
                    animation: `pulse-ring 1.4s ease-in-out ${i * 0.2}s infinite`,
                    display: 'inline-block', opacity: 0.7,
                  }} />
                ))}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <form
          onSubmit={(e) => { e.preventDefault(); handleSend(); }}
          style={{
            padding: '0.875rem 1.125rem',
            background: '#1c1c1e',
            borderTop: '0.5px solid rgba(255,255,255,0.08)',
            display: 'flex', alignItems: 'center', gap: '8px',
          }}
        >
          <input
            type="text"
            value={inputQuery}
            onChange={(e) => setInputQuery(e.target.value)}
            placeholder="Ask MOIL Mining Assistant…"
            style={{
              flex: 1,
              background: 'rgba(255,255,255,0.06)',
              border: '0.5px solid rgba(255,255,255,0.12)',
              borderRadius: '8px',
              padding: '0.5rem 0.875rem',
              fontSize: '12.5px',
              fontFamily: 'inherit',
              color: 'rgba(255,255,255,0.92)',
              outline: 'none',
              transition: 'all 130ms ease',
              boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.25)',
            }}
            onFocus={(e) => {
              (e.target as HTMLInputElement).style.borderColor = 'rgba(14,145,102,0.55)';
              (e.target as HTMLInputElement).style.boxShadow = '0 0 0 3px rgba(14,145,102,0.12), inset 0 1px 3px rgba(0,0,0,0.25)';
            }}
            onBlur={(e) => {
              (e.target as HTMLInputElement).style.borderColor = 'rgba(255,255,255,0.12)';
              (e.target as HTMLInputElement).style.boxShadow = 'inset 0 1px 3px rgba(0,0,0,0.25)';
            }}
          />
          <button
            type="submit"
            disabled={!inputQuery.trim()}
            style={{
              width: '36px', height: '36px', borderRadius: '8px',
              background: inputQuery.trim()
                ? 'linear-gradient(160deg, #17a87e, #0a7a54)'
                : 'rgba(255,255,255,0.07)',
              border: '0.5px solid ' + (inputQuery.trim() ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.10)'),
              color: inputQuery.trim() ? '#fff' : 'rgba(255,255,255,0.25)',
              cursor: inputQuery.trim() ? 'pointer' : 'not-allowed',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 130ms ease',
              boxShadow: inputQuery.trim() ? '0 1px 4px rgba(14,145,102,0.4)' : 'none',
              flexShrink: 0,
            }}
          >
            <Send style={{ width: '14px', height: '14px' }} />
          </button>
        </form>
      </div>
    </>
  );
};
