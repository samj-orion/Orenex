# ORENEX — AI-powered manganese mining intelligence platform

> **PS SIH26009 · MOIL Ltd.** — a decision-support prototype for India's manganese mining sector.

ORENEX brings geological prospectivity, resource/reserve estimation, mine operations simulation, production forecasting and model governance into one interactive application. It is built as **two independent applications** that share one deterministic simulation engine: a self-contained React single-page app and an optional Python JSON API service.

Every result is generated from a seeded, reproducible computation and carries model/provenance metadata (`confidence`, `source`, `aiModelId`, and similar fields), so outputs can be traced and audited rather than treated as opaque guesses.

---

## Table of contents

- [Why ORENEX](#why-orenex)
- [Feature tour](#feature-tour)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Scripts and commands](#scripts-and-commands)
- [Using the application](#using-the-application)
- [Simulation engine](#simulation-engine)
- [AI and machine learning](#ai-and-machine-learning)
- [Backend API reference](#backend-api-reference)
- [Verification and testing](#verification-and-testing)
- [Cross-engine parity](#cross-engine-parity)
- [Data provenance and disclaimer](#data-provenance-and-disclaimer)
- [Troubleshooting](#troubleshooting)
- [Further reading](#further-reading)

---

## Why ORENEX

Manganese exploration and mine planning decisions depend on fragmented inputs: geological surveys, assay datasets, production history, grade control and market signals. ORENEX prototypes a unified workflow where:

- a **synthetic but georeferenced belt** provides a repeatable district/orebody baseline;
- a **prospectivity model** ranks greenfield targets using both belt priors and a trained AI grade predictor;
- **reserve and operations models** translate geology into tonnage, grade and production schedules;
- **forecasting and backtesting** quantify likely shortfalls and test the forecast method against history;
- **reconciliation and validation** catch grade/tonnage drift and data-quality problems;
- an **AI Copilot** answers questions by calling those live engines, so answers use the same numbers the screens show.

The prototype is intentionally deterministic: a given seed reproduces the same district, orebody and shortfall in both the browser and Python implementations.

---

## Feature tour

The header exposes eight tabbed "deliverables" (D1–D11 tags) plus a global mine selector, alert pill and Copilot button:

| Tag | Tab | What it does |
|-----|-----|--------------|
| **D1** | Control Room | Dashboard with hero map, KPIs, alerts, mine briefings, 21-day P10/P50/P90 forecast chart, company production and top corrective actions. |
| **D3** | Prospectivity | 60×42 raster evidence layers (probability, host, magnetic, ferric), P1/P2/P3 target filtering, hover readout, feature attribution, evidence stack and drill-plan suggestions. |
| **D4** | Reserve Model | Interactive canvas 3D block model (orbit, level L1–L5 filter, ore-only mode) plus grade–tonnage chart; cutoff slider 10–30% Mn. |
| **D6** | Shortfall Forecast | 7/30-day horizon switch; plan-vs-actual, quantile and rain-impact chart modes; fleet risk, stage bottleneck gauges and company-wide attainment. |
| **D7** | Corrective Actions | Action cards with approval workflow, greedy portfolio optimizer, what-if sliders (dumpers, drill rigs, blast frequency, maintenance budget) and a six-rule escalation playbook. |
| **D8** | Reconciliation | F1/F2/F3 call-factor cards with ±0.05 tolerance, Jan–Oct trends, residual drivers and the In-Situ → Mine → Plant → Dispatch chain. |
| **D10** | Model Governance | Four sub-tabs: Model Registry, Data Sources, Audit Trail and Flow Runs. |
| **D11** | AI Training | In-browser retraining with regression/classification loss curves, feature coefficients, cross-validation scatter, sortable dataset table and governance notes. |

The **MOIL AI Copilot** drawer answers questions using live engine calls. Suggested prompts include "What is the 7-day shortfall for Balaghat Deep Cast?", "Summarize UNFC reserves at 20% Mn cutoff.", "Why is haulage the binding constraint at Nagpur?" and "Recommend actions for the upcoming wet spell." Messages show query intent, confidence, timestamp and whether the answer came `via Python` or the local engine.

The UI is built with React 18, TypeScript, Tailwind CSS (a macOS-inspired dark theme with mining-green accent tokens), Leaflet with a canvas heatmap overlay (maps), Recharts (charts), custom canvas/SVG visuals, and Lucide icons. Inter and JetBrains Mono are loaded from Google Fonts.

---

## Architecture

```
                         ┌────────────────────────────────────────────┐
                         │              Browser (SPA)                  │
                         │                                              │
  user interactions ────▶│  components/  →  App.tsx  →  hooks/          │
                         │       │                                      │
                         │       ▼                                      │
                         │  core/  — deterministic TS engine            │
                         │  (geology → prospectivity → reserves →       │
                         │   operations → forecast → assistant)         │
                         │       ▲                                      │
                         └───────┼──────────────────────────────────────┘
                                 │  optional HTTP (best-effort)
                                 │  VITE_ORENEX_API (default 127.0.0.1:8000)
                                 ▼
                         ┌────────────────────────────────────────────┐
                         │              Python service                 │
                         │  orenex/api.py  — ThreadingHTTPServer       │
                         │  orenex/engine.py — aggregate facade        │
                         │  orenex/*.py — stdlib port of the engine    │
                         └────────────────────────────────────────────┘
```

**Key design points**

- The frontend is **fully functional offline**. Its engine lives in `frontend/src/core/` and computes everything in the browser.

Global UI state in `App.tsx` (`activeTab`, `selectedMineId` default `ALL`, `selectedActionId`, assistant open flag) drives cross-tab navigation: selecting an action from the dashboard jumps to Actions, and the alert pill jumps to Forecast. The header shows the Balaghat–Nagpur Manganese Belt, snapshot `2026-10-03-a91` and model `m5-v6.3.0`.
- The backend is a **parallel port**, not a required dependency. It uses **only the Python standard library** and exposes the same engine as JSON over HTTP.
- At run time, `frontend/src/core/api.ts` prefers the Python engine for Copilot answers when `/health` responds; otherwise it silently falls back to the local engine. `frontend/src/hooks/useBackendStatus.ts` polls health every 30 seconds, and the header shows **Python engine live** (green), **Local engine** (amber) or **Probing…** (gray), with a tooltip showing the base URL and version.
- Both engines share field names (camelCase) and a bit-for-bit port of the `mulberry32` seeded PRNG and noise functions, so outputs are directly comparable.

---

## Repository layout

```
Orenex_V.1.0.0/
├── frontend/
│   ├── src/
│   │   ├── core/                     deterministic simulation engine (TypeScript)
│   │   │   ├── rng.ts                seeded mulberry32 PRNG, Box–Muller, quantiles
│   │   │   ├── noise.ts              Perlin / fBm / ridged noise, field sampling
│   │   │   ├── geo.ts                EPSG:32644 AOI georeferencing, UTM → lon/lat
│   │   │   ├── format.ts             en-IN number and date formatting
│   │   │   ├── clock.ts              single session clock
│   │   │   ├── geology.ts            synthetic belt terrain, units, structures, deposits
│   │   │   ├── prospectivity.ts      mineral prospectivity model
│   │   │   ├── reserves.ts           resource / reserve estimation
│   │   │   ├── operations.ts         mine operations simulation
│   │   │   ├── stageModel.ts         mining-stage progression model
│   │   │   ├── forecast.ts           production forecasting
│   │   │   ├── backtest.ts           forecast backtesting
│   │   │   ├── reconciliation.ts     grade / tonnage reconciliation factors
│   │   │   ├── validation.ts         data validation & QA rules
│   │   │   ├── assistant.ts          rule-based Q&A assistant
│   │   │   ├── models.ts             model registry + data provenance
│   │   │   ├── manganeseIndia.ts     India top-50 manganese mine dataset
│   │   │   ├── trainer.ts            from-scratch gradient-descent ML trainer
│   │   │   ├── manganeseModel.ts     trained manganese grade / premium heads + predictor
│   │   │   └── api.ts                client for the optional Python backend
│   │   ├── hooks/                    useBackendStatus.ts (health polling)
│   │   ├── components/               tabbed UI, map panel, header, assistant drawer
│   │   ├── App.tsx                   tab wiring
│   │   ├── main.tsx                  React entry point
│   │   └── index.css                 global styles / Tailwind layers
│   ├── .env.example                  backend URL configuration template
│   ├── index.html                    Vite HTML entry
│   ├── package.json                  scripts and dependencies
│   ├── tailwind.config.js            Tailwind theme
│   ├── postcss.config.js             PostCSS pipeline
│   ├── tsconfig.json                 TypeScript project config
│   ├── vite.config.ts                Vite dev/build config
│   └── README.md                     module map and frontend architecture
├── backend/
│   ├── run.py                        CLI launcher (argparse → orenex.api.serve)
│   ├── orenex/                       Python port of the engine
│   │   ├── api.py                    http.server JSON API
│   │   ├── engine.py                 facade aggregating all engine functions
│   │   ├── rng.py, noise.py, geo.py, format.py, clock.py
│   │   ├── geology.py, prospectivity.py, reserves.py, operations.py, stage_model.py
│   │   ├── forecast.py, backtest.py, reconciliation.py, validation.py
│   │   ├── assistant.py, models.py
│   │   ├── manganese_india.py, manganese_model.py, trainer.py
│   │   └── __init__.py
│   ├── tests/smoke.py                end-to-end engine smoke test
│   ├── requirements.txt              intentionally empty (stdlib only)
│   ├── README.md                     endpoint list and layout
│   └── PORTING.md                    TypeScript → Python porting conventions
└── README.md                         this file
```

Build output (`frontend/dist/`), dependencies (`node_modules/`), Python bytecode and virtual environments are ignored via `.gitignore`.

---

## Requirements

| Component | Requirement | Notes |
|-----------|-------------|-------|
| Frontend | Node.js **18+** and npm | Vite 5, TypeScript 5, React 18 |
| Backend (optional) | CPython **3.11+** (tested on 3.14) | No third-party packages; `requirements.txt` is intentionally empty |

Frontend runtime dependencies: `react`, `react-dom`, `leaflet`, `lucide-react`, `recharts`.
Frontend dev dependencies: `vite`, `typescript`, `tailwindcss`, `postcss`, `autoprefixer`, `@vitejs/plugin-react`, and type packages.

---

## Getting started

### Option A — frontend only (zero setup beyond npm)

```powershell
cd frontend
npm install
npm run dev        # http://localhost:5173
```

The full simulation runs in the browser. The header will show **Local engine**, which is expected and harmless.

### Option B — full stack with the Python engine

Terminal 1 (backend):

```powershell
cd backend
python run.py
# or: python run.py --host 127.0.0.1 --port 8000
```

Terminal 2 (frontend):

```powershell
cd frontend
npm install
npm run dev
```

The header should now read **Python engine live**. Note that heavy backend layers (reserves/prospectivity grids) build on the first request and can take roughly a minute.

### Production build

```powershell
cd frontend
npm run build      # tsc -b && vite build → dist/
npm run preview    # serve the production bundle locally
```

`frontend/dist/` is a static bundle; it can be served by any static web server.

---

## Configuration

### Frontend environment

Copy `frontend/.env.example` to `frontend/.env.local`:

```env
# Base URL of the optional Python backend.
VITE_ORENEX_API=http://127.0.0.1:8000
```

- Default when unset: `http://127.0.0.1:8000`.
- Health is polled by `useBackendStatus.ts` every 30 seconds; failed checks fall back to the local engine without blocking the UI. Copilot requests use a 180-second timeout because heavy backend layers can take a while to build.
- Change the value when the API runs on another host/port.
- Vite dev server runs on port `5173` (`host: true`), uses `base: './'` for relative asset paths, aliases `@` → `src`, and outputs to `dist/`.

### Backend CLI

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `8000` | Listen port |

---

## Scripts and commands

| Location | Command | Purpose |
|----------|---------|---------|
| `frontend/` | `npm install` | Install dependencies |
| `frontend/` | `npm run dev` | Start Vite dev server (port 5173) |
| `frontend/` | `npm run build` | Type-check (`tsc -b`) and build production bundle |
| `frontend/` | `npm run preview` | Serve `dist/` locally |
| `frontend/` | `npm run typecheck` | `tsc --noEmit` |
| `backend/` | `python run.py` | Start JSON API on port 8000 |
| `backend/` | `python -m tests.smoke` | Run end-to-end engine smoke test |

---

## Using the application

### Global controls

The sticky header provides the tab navigation, a mine `<select>` populated from `MINES`, an alert pill (count from `buildAlerts()`, clicking it opens Forecast), the backend status dot, and the **MOIL AI Copilot** button. The `ALL` mine selection is resolved to `MNE-BAL` wherever a single mine is required.

### Control Room (D1)

Landing dashboard. The `GeoMapPanel` hero map supports toggles for heatmap, mines, national occurrences, occurrences and targets; zoom/fit-India/fullscreen controls; hover readouts of latitude, longitude, probability and Mn %; click-to-predict; state/region selection for MP, MH, OD, KA and AP; custom-region entry by name/lat/lng; and target workflows (assay sampling, mining approval, unviable). KPI cards come from geology, forecast and reserves engines; a 21-day P10/P50/P90 area chart uses Recharts; top actions can be clicked through to D7.

### Prospectivity (D3)

Technical raster view over the `NX`×`NY` (60×42) grid. Switch between `prob`, `host`, `mag` and `ferric` layers; filter targets by P1/P2/P3 priority; hover cells for normalized coordinates and feature values; inspect a selected target's feature attribution, evidence stack and suggested drill plan. Targets expose `expectedGradeMn`, `aiGradeMn`, `aiPremiumProb` and `aiModelId`, making the AI contribution auditable.

### Reserve Model (D4)

Drag to orbit the canvas block model, hover blocks for a details HUD, filter levels L1–L5 or All, toggle ore-only, reset the view, or switch to a Recharts grade–tonnage chart. Moving the cutoff slider (10–30% Mn, default 20) recomputes reserve estimates and summaries live.

### Shortfall Forecast (D6)

Choose a 7- or 30-day horizon and a chart mode: plan vs actual, quantile forecast (P10/P50/P90) or rain impact. The view also shows synthetic 14-day actual production, fleet-risk framing, SHAP-like loss attribution, stage availability gauges with bottleneck highlighting, company-wide 7-day attainment and alert trigger status from `alertTriggerFor`.

### Corrective Actions (D7)

Browse action cards with gain, cost, predicted tonnes and confidence; open the approval modal and choose a signer role. Switch between Cards, Optimizer (greedy knapsack approximation of OR-Tools CP-SAT, budget-driven), What-if (extra dumpers, drill rigs, blast frequency, maintenance budget) and the six-rule Playbook. Approvals and scenarios are local to the session.

### Reconciliation (D8)

Inspect F1 (mine call), F2 (process call) and F3 (global call) factors with pass/fail against ±0.05 tolerance, monthly Jan–Oct trends filterable by factor, residual-driver bars and the full In-Situ → Mine → Plant → Dispatch chain.

### Model Governance (D10)

Four sub-tabs backed by `MODELS`, `SOURCES`, `AUDIT` and `FLOWS` from `core/models`: registered models and versions, data-source lineage, audit events and pipeline flow runs.

### AI Training (D11)

Click **Retrain** to run `trainManganeseModel` in the browser with a new seed. View regression/classification loss curves, top regression coefficients, an actual-vs-predicted cross-validation scatter, a sortable dataset table and explicit governance/limitations notes.

### AI Copilot drawer

The drawer first tries `backendAsk` with context (`mineId` resolved to `MNE-BAL` for `ALL`, `targetId: null`, `cutOff: 18`) and falls back to the local `ask()` with no estimate if the backend is unavailable. Answers are flattened to text and labelled with their engine source.

Number/date formatting follows `en-IN` conventions throughout.

---

## Simulation engine

The engine is a pipeline of small, composable modules present in **both** implementations:

| Stage | Module(s) | Responsibility |
|-------|-----------|----------------|
| Determinism | `rng`, `noise`, `clock` | Seeded `mulberry32` PRNG, Box–Muller samples and quantiles; Perlin/fBm/ridged noise fields; one session clock. |
| Georeferencing | `geo`, `format` | EPSG:32644 area-of-interest handling, UTM → longitude/latitude, `en-IN` formatting. |
| Geology | `geology` | Synthetic belt terrain, geological units, structures and deposits. |
| Targets | `prospectivity` | Prospectivity scoring and ranked targets; blends belt prior with AI grade prediction. |
| Quantity | `reserves`, `stageModel` | Resource/reserve estimation and mining-stage progression. |
| Production | `operations`, `forecast` | Operations simulation, production forecasting and alerts. |
| Assurance | `backtest`, `reconciliation`, `validation` | Forecast backtesting, grade/tonnage reconciliation, QA rules. |
| Knowledge | `models`, `manganeseIndia`, `trainer`, `manganeseModel` | Model registry/provenance, national dataset, ML training, deployed predictor. |
| Interaction | `assistant`, `api` | Rule-based Q&A over live engine calls; optional Python client. |

The seeded generator and noise functions are ported bit-for-bit, so a given seed reproduces the same district, orebody and shortfall in TypeScript and Python.

### Reference parameters (Python port)

The backend builds its datasets deterministically at import time from fixed seeds and exposes the same constants as the browser engine:

| Subsystem | Concrete values |
|-----------|-----------------|
| Georeferencing | EPSG:32644 AOI, 65 km × 58 km (`minE=703000`, `minN=7732000`, `maxE=768000`, `maxN=7790000`) |
| Geology | 168×150 terrain grid (~390 m cells), 16 geological units across 7 lithologies (`GON`, `QSP`, `IMP`, `BIF`, `GRN`, `ALL`, `DOL`), 26 structures, 3 mines (`MNE-BAL`, `MNE-NAG`, `MNE-BHA`) |
| Prospectivity | 132×118 grid (~4 km blocks), 12 features (host, horizon/fault proximity, magnetic/gravity anomalies, ferric, clay, NDVI, relief, slope, soil moisture, occurrence proximity), PU-logistic fit (140 iterations), 12-feature logistic model with PAVA isotonic calibration |
| Targets | Probability floor 0.42, 5×5 local maxima, 250 m spacing, maximum 26 targets, depth clamped 3–190 m |
| Reserves | 433 drillholes, 10×10×5 m blocks, 2 m assays composited to 4 m, spherical variogram kriging, confidence classes measured/indicated/inferred, UNFC summaries, grade–tonnage at 8–30% Mn (step 2) |
| Operations | 1,095 days (3 years) × 3 shifts/day, 5 stages (drill, blast, muck, haul, hoist), 75 machines, Weibull equipment failures, weather and blast logs |
| Forecast | 45-day engine, default horizon 30, P10/P50/P90 quantiles, alerts (e.g. BAL trigger 0.15, NAG 0.4, BHA 0.2), five action-card types, synchronous what-if |
| Backtest / validation | Rolling-origin backtests (7-day horizon, 7-day steps), rain bands (dry <8 mm, wet <35 mm, very wet), 4 spatial block folds + `FOLD-HIDDEN`, ablations E0–E6, 20% drill hold-out, ~25 model refits cached on first validation request |
| Governance data | 11 registered models (`m1`…`m11`, `mn50`), 15 data sources, 10 audit events, 4 flow runs |

`orenex/engine.py` is the facade that aggregates every subsystem into JSON; it lazily imports the heavy layers (`reserves`, `prospectivity`, `operations`, `models`), which is why the first such API request takes about a minute. `to_jsonable()` converts typed arrays to lists, drops callables, maps NaN/±Inf to `null`, and stringifies keys so every response is strict JSON — the smoke test asserts this with `allow_nan=False`.

### End-to-end data flow

The browser engine follows the same pipeline (module names in `frontend/src/core/`):

1. **District generation** — `rng.ts` + `noise.ts` with fixed seeds → `geo.ts` AOI → `geology.ts` terrain (seed `20241017`), 16 lithology polygons (seed `31337`), 26 structures (seed `8675309`), 3 mines and occurrences (seed `6161`, 1,400 m minimum separation).
2. **Operations truth** — `operations.ts` builds 1,096 days of weather and shifts, 75 machines (seed `551133`) and a 366-day blast register (seed `778899`); `stageModel.ts` defines the shared capacity physics (mine output = slowest of drill/blast/muck/haul/hoist).
3. **Calibration** — `backtest.ts` fits rain-band-specific two-component residual mixtures (nominal log-normal + disrupted normal) against historical model capacity and actual shift tonnes. `asOf` truncates the fit window for honest rolling-origin tests.
4. **Forecast, alerts and actions** — `forecast.ts` combines stage physics, calibrated uncertainty, plan, weather and overrides into `ForecastDay[]` (P10/P50/P90), shortfall probabilities, alerts and ranked action cards. Rain bands are dry <8 mm, wet 8–35 mm, very wet >35 mm; default backtest options are 7-day horizon, 280-day window, 7-day step and 0.45 alert threshold.
5. **Exploration targets** — `prospectivity.ts` scores the 132×118 grid from 12 weighted features, applies PU learning and isotonic calibration, then selects up to 26 ranked targets (seed `5150`). `manganeseIndia.ts` + `manganeseModel.ts` supply the `mn50` grade/premium head used in target grade estimation.
6. **Reserves and continuity** — `reserves.ts` builds 433 drillholes, assays, a variogram (nugget 26.5, sill 214, range 420 m) and kriged block estimates with measured/indicated/inferred classes; `reconciliation.ts` derives F1/F2/F3 factors and the Ore Continuity Index (green ≥9, amber ≥6).
7. **Validation and governance** — `validation.ts` recomputes spatial folds, hidden-district tests, 20% drill hold-outs, rolling forecast backtests, cause attribution, action A/B tests and E0–E6 ablations (~25 model refits, cached). `models.ts` records the registry, sources, audit trail and flows.
8. **Assistant / backend boundary** — `assistant.ts` answers from local computed state; `api.ts` optionally mirrors operations through the Python service, with `useBackendStatus.ts` exposing connectivity to React.

All datasets are built once at module load from fixed seeds, and both `format.ts` (`NOW`) and `clock.ts` capture a single session timestamp so forecasts and audit records stay internally consistent.

---

## AI and machine learning

- **National dataset** — `manganeseIndia.ts` / `manganese_india.py` hold the top 50 Indian manganese mines (19 `high`, 9 `medium`, 26 `low` confidence). Each record carries `confidence` and `source`; derived stats include state count, capacity, reserves, mean grade and underground share.
- **From-scratch trainer** — `trainer.ts` / `trainer.py` implement full-batch ridge regression and logistic regression with gradient descent, standardization, metrics (MAE/RMSE/R², accuracy/precision/recall/F1/AUC) and deterministic `kFold` splits. No ML framework is used. Defaults: 900 epochs, learning rate 0.08, L2 0.06 (logistic uses 2× the learning rate and clamps the sigmoid input to ±30).
- **Deployed predictor** — `MANGANESE_PREDICTOR` (`manganeseModel.ts`) / `predict_manganese_grade()` (`manganese_model.py`) is the `mn50` model (version `mn50-v1.0.0`) refit on all 50 mines with 5-fold cross-validation. Its 19 features are 6 numeric/binary inputs, 4 ore-type dummies and 9 state dummies. Inputs are transformed as `log(capacityKt)`, `log(reserveMt)`, `ageYears = 2026 - commissioned`, `phosphorusPct = phosphorusP * 100`, and an underground flag. Grade ≥ 28% Mn defines the high-grade class. Partial inputs are median-filled from the inventory (defaults: underground, gondite, Madhya Pradesh), so greenfield ground can be scored from a predicted depth alone.
- **Prospectivity integration** — the predictor is called per target; its grade estimate is blended 50/50 with the belt prior into `expectedGradeMn`. Every target records `aiGradeMn`, `aiPremiumProb` and `aiModelId`. In the verified port, all 26 targets matched the bundled frontend engine to 0.0 absolute difference on those fields.
- **Copilot** — `assistant.ts` / `assistant.py` recognize intents including `target-explanation`, `depth`, `validation`, `production-risk`, `compare`, `reserve`, `oci`, `data`, `model` and `national-ai`. Production-risk questions call `forecast_mine(..., 7)` and `build_alerts()` on demand; national-AI questions come from `MANGANESE_TRAINING`. The backend returns the same `Answer` shape as the frontend, so callers can swap engines without changing rendering.

---

## Backend API reference

Base URL: `http://127.0.0.1:8000`. All responses are JSON; CORS allows any origin; `OPTIONS` is supported.

### GET endpoints

| Endpoint | Query parameters | Description |
|----------|------------------|-------------|
| `/`, `/index` | — | Service metadata: `service`, engine version, endpoint list |
| `/health` | — | Health check |
| `/overview` | — | Dashboard overview |
| `/geology` | — | Geology layer |
| `/geology/terrain` | `step` (default `4`) | Terrain grid |
| `/prospectivity` | — | Prospectivity summary |
| `/prospectivity/grid` | `step` (default `4`) | Prospectivity grid |
| `/targets` | — | Ranked prospectivity targets |
| `/reserves` | — | Reserve estimates |
| `/operations` | — | Operations summary |
| `/forecast` | `mine` (default `MNE-BAL`), `horizon` (default `30`) | Production forecast |
| `/alerts` | — | Generated alerts |
| `/backtest` | `mine` (default `MNE-BAL`) | Mine backtest |
| `/backtest/portfolio` | — | Portfolio backtest |
| `/reconciliation` | — | Reconciliation summary |
| `/validation` | — | Validation/QA summary |
| `/models` | — | Model registry |
| `/manganese` | — | National manganese dataset |
| `/manganese/model` | — | Trained manganese model info |
| `/assistant/suggestions` | — | Copilot prompt suggestions |

### POST endpoints

| Endpoint | Body | Description |
|----------|------|-------------|
| `/assistant` | `{ "q": "...", "mineId": null, "targetId": null, "cutOff": 0 }` | Ask the Copilot; `question` is accepted as an alias for `q`. |

### Examples

```powershell
# Health
Invoke-RestMethod http://127.0.0.1:8000/health

# Seven-day forecast for a mine
Invoke-RestMethod "http://127.0.0.1:8000/forecast?mine=MNE-BAL&horizon=7"

# Copilot question
Invoke-RestMethod -Method Post http://127.0.0.1:8000/assistant `
  -ContentType "application/json" `
  -Body '{"q":"What is the production risk?"}'
```

Errors are JSON: `404` for unknown routes, `400` for invalid JSON bodies, `500` with exception type/message for engine faults.

### Frontend client timeouts

`frontend/src/core/api.ts` wraps every endpoint with a fail-soft call (unreachable backend → `BackendUnavailable` → local engine). Timeouts reflect the cost of lazy layer construction:

| Wrapper(s) | Endpoint | Timeout |
|------------|----------|---------|
| `backendHealth` / `pingBackend` | `/health` | 4 s |
| Default `request` | most endpoints | 12 s |
| `backendBacktest` | `/backtest?mine=…` | 60 s |
| `backendBacktestPortfolio` | `/backtest/portfolio` | 120 s |
| `backendProspectivity`, `backendProspectivityGrid`, `backendReserves` | prospectivity/reserves | 60 s |
| `backendValidation`, `backendAsk` | `/validation`, `/assistant` | 180 s |

---

## Verification and testing

```powershell
# Frontend: static checks
cd frontend
npm run typecheck
npm run build

# Backend: end-to-end smoke test
cd ..\backend
python -m tests.smoke
```

`tests/smoke.py` is a 20-test `unittest` suite that exercises every engine facade: health, overview, geology, terrain grid, prospectivity summary/grid, targets, reserves, operations, forecast (30 days for `MNE-BAL`), alerts, backtest (mine and portfolio), reconciliation, validation, model registry, manganese dataset/model, assistant, JSON serialization of typed arrays/NaN/Inf, and the HTTP router (including 404 and `POST /assistant`). Every response is checked with strict `json.dumps(..., allow_nan=False)`, so no non-finite values can leak to the frontend. The full suite takes a minute or two because heavy layers build lazily on first use.

---

## Cross-engine parity

| Aspect | Guarantee |
|--------|-----------|
| PRNG | `rng.ts` and `rng.py` implement `mulberry32` bit-for-bit; helpers for Gaussian samples, choices and quantiles mirror each other |
| Noise | Perlin / fBm / ridged noise ported with identical sampling and field interpolation |
| Time | A single frozen "now" is captured at import/module load so dates are stable across a session |
| Field names | Data records are plain dicts/objects with the same camelCase keys (`depthTopM`, `pShort30`, `cellWidthM`, …) |
| Numeric arrays | Python uses `array.array` typecodes `f`/`d`/`B`/`H`/`I`/`i`; the facade converts them to JSON arrays |
| AI predictor | 26/26 prospectivity targets matched to 0.0 absolute difference on `aiGradeMn`, `aiPremiumProb`, `aiModelId` |
| Assistant | `POST /assistant` returns the same `Answer` shape as the frontend `ask()`; `q` and `question` are both accepted |

Porting rules are documented in `backend/PORTING.md`: standard library only, one Python module per TypeScript source, snake_case identifiers with camelCase data keys, plain dicts for records, relative imports, and no silently dropped exports. Verification is per-module `python -m py_compile` plus the smoke suite. Note that `engine.endpoints()` lists 19 routes and omits `/assistant/suggestions`, which is still served by the router.

---

## Data provenance and disclaimer

Figures in `manganese_india` are compiled from public sources:

- IBM Indian Minerals Yearbook
- GSI memoirs
- MOIL / SMIORE and State DMG disclosures

Values are **indicative**, not survey-grade. Every record includes `confidence` and `source`. The geological belt, deposits and operational series are synthetic, generated from the seeded engine. This software is a **decision-support prototype**, not an operational, regulatory or investment-grade system.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Header shows **Local engine** (amber) or **Probing…** | Backend not running or `VITE_ORENEX_API` points elsewhere. The app still works fully offline; **Python engine live** (green) confirms the API is reachable. |
| Backend first request is slow | Heavy reserves/prospectivity layers build lazily on first request (~1 min). |
| `npm run dev` fails | Install dependencies with `npm install`; use Node 18+. |
| `python run.py` port in use | Pass `--port` with a free port and update `VITE_ORENEX_API` accordingly. |
| CORS errors from another origin | API sends `Access-Control-Allow-Origin: *` and handles `OPTIONS`; check the base URL and protocol. |
| TypeScript build errors | Run `npm run typecheck`; ensure `node_modules` is installed and types match the lockfile. |

---

## Prototype limitations

As a hackathon prototype, some UI affordances are intentionally or incidentally non-functional:

- The `⌘K` badge in the header is decorative; no global keyboard shortcut is wired.
- The Control Room copilot input and mine briefing cards are presentational (not connected to the drawer or click handlers).
- Prospectivity "Export" only confirms locally; it does not download a file.
- Actions approvals/what-if scenarios are session-local, and "Save Scenario" uses a browser alert.
- `ProspectivityTab` and `ActionsTab` do not consume the global `selectedMineId` prop.
- Forecast history and reconciliation trends contain deterministic synthetic series.
- Copilot answers render flattened text; `sources` and `followUps` from the answer model are not displayed.

These are UI/prototyping gaps, not engine defects; the underlying computations remain deterministic and auditable.

## Further reading

- [`frontend/README.md`](frontend/README.md) — frontend module map and engine→AI integration details
- [`backend/README.md`](backend/README.md) — Python engine layout, parity notes, API summary
- [`backend/PORTING.md`](backend/PORTING.md) — TypeScript → Python porting conventions
