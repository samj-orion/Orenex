# ORENEX frontend

React 18 + TypeScript + Vite single-page app. It is **self-contained**: all
intelligence is computed in the browser from `src/core/`, so it runs with no
backend and no network dependency. The Python engine in `../backend/` is an
*optional* runtime accelerator — see [Backend](#backend).

## Run

```powershell
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc -b && vite build → dist/
npm run preview    # serve the production build
npm run typecheck  # tsc --noEmit
```

## Module map

`src/core/` — the deterministic simulation engine (TypeScript):

| Module | Responsibility |
|--------|----------------|
| `rng.ts` | seeded `mulberry32` PRNG, Box–Muller, quantiles |
| `noise.ts` | Perlin / fBm / ridged noise, field sampling |
| `geo.ts` | EPSG:32644 AOI georeferencing, UTM→lon/lat |
| `format.ts` | `en-IN` number & date formatting |
| `clock.ts` | single session clock |
| `geology.ts` | synthetic belt terrain, units, structures, deposits |
| `prospectivity.ts` | mineral prospectivity model |
| `reserves.ts` | resource / reserve estimation |
| `operations.ts` | mine operations simulation |
| `stageModel.ts` | mining-stage progression model |
| `forecast.ts` | production forecasting |
| `backtest.ts` | forecast backtesting |
| `reconciliation.ts` | grade / tonnage reconciliation factors |
| `validation.ts` | data validation & QA rules |
| `assistant.ts` | rule-based Q&A assistant |
| `models.ts` | model registry + data provenance |
| `manganeseIndia.ts` | India top-50 manganese mine dataset |
| `trainer.ts` | from-scratch gradient-descent ML trainer |
| `manganeseModel.ts` | trained manganese grade / premium heads + deployed predictor |
| `api.ts` | client for the optional Python backend |

`src/hooks/` — `useBackendStatus.ts` polls the backend `/health` endpoint.

### How the AI connects to the engine

- **mn50 → prospectivity.** `manganeseModel.ts` exposes `MANGANESE_PREDICTOR`, the
  grade/premium model refit on all 50 mines. The prospectivity engine
  (`prospectivity.ts`) calls it for each target's predicted depth and blends the
  analogue AI grade with the belt prior into `expectedGradeMn`. Each target also
  carries `aiGradeMn`, `aiPremiumProb` and `aiModelId` so the split is auditable.
- **Copilot → live engines.** `assistant.ts` no longer quotes prose for risk
  questions: it calls `forecastMine`/`buildAlerts` on the spot, and answers
  national-AI questions from `MANGANESE_TRAINING`.

`src/components/` — the tabbed UI (Overview, Prospectivity, Reserves,
Operations/Forecast, Reconciliation, Model Ops, Training, Actions) plus the map
panel, header and assistant drawer. `src/App.tsx` wires the tabs together.

## Backend

A separate, dependency-free Python port of this engine lives in `../backend/`.
The frontend works without it, but if it is running the AI Copilot prefers it and
the header reports **PY ENGINE ONLINE**. Point the app elsewhere with
`VITE_ORENEX_API` (copy `.env.example` to `.env.local`); the default is
`http://127.0.0.1:8000`. Connectivity is best-effort and never blocks the UI —
see `src/core/api.ts`.
