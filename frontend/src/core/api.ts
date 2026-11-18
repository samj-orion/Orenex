/**
 * Client for the ORENEX Python backend (`backend/orenex/api.py`).
 *
 * The frontend carries its own in-browser engine, so the backend is an
 * *optional accelerator*, never a hard dependency. Every call here fails soft:
 * if the service is unreachable (not started, wrong port, CORS, timeout) the
 * error is normalised to {@link BackendUnavailable} and the caller falls back to
 * the local engine. That keeps the two folders independent at build time while
 * still letting them talk at run time.
 *
 * Point the app at a different host with `VITE_ORENEX_API` (see `.env.example`).
 */

import type { Answer } from './assistant';

/** Base URL of the backend, without a trailing slash. */
export const BACKEND_BASE: string = resolveBase();

function resolveBase(): string {
  // `import.meta.env` is defined by Vite; the optional chain keeps this module
  // importable from plain Node (esbuild/ts-node) where `env` is undefined.
  const raw = (import.meta as { env?: { VITE_ORENEX_API?: string } } | undefined)?.env?.VITE_ORENEX_API;
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  return trimmed || 'http://127.0.0.1:8000';
}

export type BackendState = 'unknown' | 'online' | 'offline';

export interface BackendStatus {
  state: BackendState;
  base: string;
  /** Engine version reported by `/health`, when known. */
  version?: string;
  /** ISO timestamp of the last probe. */
  checkedAt?: string;
}

/** Thrown whenever the backend cannot be reached or answered with JSON. */
export class BackendUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendUnavailable';
  }
}

let status: BackendStatus = { state: 'unknown', base: BACKEND_BASE };
const listeners = new Set<(s: BackendStatus) => void>();

/** Current connection status. Same reference until it changes — `useSyncExternalStore`-safe. */
export function getBackendStatus(): BackendStatus {
  return status;
}

/** Subscribe to status changes; returns an unsubscribe function. */
export function subscribeBackend(fn: (s: BackendStatus) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function setStatus(patch: Partial<BackendStatus>): void {
  status = { ...status, ...patch };
  for (const fn of listeners) fn(status);
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, timeoutMs = 12000 } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BACKEND_BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    const data = (await res.json()) as T;
    setStatus({ state: 'online', checkedAt: new Date().toISOString() });
    return data;
  } catch (err) {
    setStatus({ state: 'offline', checkedAt: new Date().toISOString() });
    throw err instanceof BackendUnavailable ? err : new BackendUnavailable(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/* ─── Endpoint wrappers ─────────────────────────────────────────────────────
 * The paths mirror `backend/orenex/api.py`. Return types are kept loose on
 * purpose: the Python engine is a *reference*, and the UI only ever reads a
 * couple of fields from each payload.
 */

export interface BackendHealth {
  status: string;
  engine: string;
  version: string;
  generatedAt: string;
}

export function backendHealth(): Promise<BackendHealth> {
  return request<BackendHealth>('/health', { timeoutMs: 4000 });
}

export function backendOverview(): Promise<unknown> {
  return request('/overview');
}

export function backendForecast(mineId: string, horizon = 30): Promise<unknown> {
  return request(`/forecast?mine=${encodeURIComponent(mineId)}&horizon=${horizon}`);
}

export function backendAlerts(): Promise<unknown> {
  return request('/alerts');
}

export function backendBacktest(mineId: string): Promise<unknown> {
  return request(`/backtest?mine=${encodeURIComponent(mineId)}`, { timeoutMs: 60000 });
}

export function backendBacktestPortfolio(): Promise<unknown> {
  return request('/backtest/portfolio', { timeoutMs: 120000 });
}

export function backendProspectivity(): Promise<unknown> {
  return request('/prospectivity', { timeoutMs: 60000 });
}

export function backendProspectivityGrid(step = 4): Promise<unknown> {
  return request(`/prospectivity/grid?step=${step}`, { timeoutMs: 60000 });
}

export function backendReserves(): Promise<unknown> {
  return request('/reserves', { timeoutMs: 60000 });
}

export function backendValidation(): Promise<unknown> {
  return request('/validation', { timeoutMs: 180000 });
}

export function backendManganeseModel(): Promise<unknown> {
  return request('/manganese/model');
}

export interface BackendAskContext {
  mineId?: string | null;
  targetId?: string | null;
  cutOff?: number;
}

/** Ask the Python assistant. Mirrors `ask()` in `./assistant`, resolved server-side. */
export function backendAsk(question: string, ctx: BackendAskContext = {}): Promise<Answer> {
  // Body keys mirror `backend/orenex/api.py`: `q` for the question and the
  // engine's own context field names (`mineId`, `targetId`, `cutOff`).
  return request<Answer>('/assistant', {
    method: 'POST',
    body: {
      q: question,
      mineId: ctx.mineId ?? null,
      targetId: ctx.targetId ?? null,
      cutOff: ctx.cutOff ?? 18,
    },
    timeoutMs: 180000,
  });
}

/**
 * One-shot liveness probe. Also refreshes the reported engine version.
 * Resolves `true` when the backend answered `/health`.
 */
export async function pingBackend(): Promise<boolean> {
  try {
    const health = await backendHealth();
    setStatus({ state: 'online', version: health.version });
    return true;
  } catch {
    setStatus({ state: 'offline' });
    return false;
  }
}
