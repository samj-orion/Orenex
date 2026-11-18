# ORENEX backend — Python reference engine

A **dependency-free** (standard-library-only) Python port of the ORENEX
simulation engine that powers the frontend, plus a small JSON HTTP API.

It ships its own complete engine, so it is **independently buildable** from the
frontend: the frontend runs its own TypeScript engine and works with no server.
At run time the frontend may optionally call this service — see
`../frontend/src/core/api.ts` — in which case the AI Copilot routes its answers
through this engine. Nothing here is required for the frontend to run.

## Requirements

* CPython **3.11+** (developed and tested on **3.14**).
* No third-party packages — see `requirements.txt`.

## Run the API

```powershell
cd backend
python run.py
# OR specify a port / host:
python run.py --host 127.0.0.1 --port 8000
```

The server is `http.server.ThreadingHTTPServer` with a tiny router; it prints the
listening URL on startup and logs one line per request.

## Run the smoke test / CLI

```powershell
cd backend
python -m tests.smoke
```

## Layout

```
backend/
├── run.py              launcher (argparse → orenex.api.serve)
├── PORTING.md          TypeScript → Python porting conventions
├── requirements.txt    intentionally empty (stdlib only)
├── orenex/
│   ├── rng.py          seeded mulberry32 PRNG (bit-for-bit vs the frontend)
│   ├── noise.py        Perlin / fBm / ridged noise, field sampling
│   ├── geo.py          EPSG:32644 AOI georeferencing, UTM→lon/lat
│   ├── format.py       en-IN number/date formatting
│   ├── clock.py        single session clock
│   ├── geology.py      synthetic belt terrain, units, structures, deposits
│   ├── prospectivity.py mineral prospectivity model
│   ├── reserves.py     resource/reserve estimation
│   ├── operations.py   mine operations simulation
│   ├── stage_model.py  mining-stage progression model
│   ├── forecast.py     production forecasting
│   ├── backtest.py     forecast backtesting
│   ├── reconciliation.py  grade/tonnage reconciliation factors
│   ├── validation.py   data validation / QA rules
│   ├── assistant.py    rule-based Q&A assistant
│   ├── models.py       model registry + data provenance
│   ├── manganese_india.py  India top-50 manganese mine dataset
│   ├── trainer.py      from-scratch gradient-descent ML trainer
│   ├── manganese_model.py  trained manganese grade/premium heads
│   ├── engine.py       facade that aggregates the engine
│   └── api.py          http.server JSON API
└── tests/
    └── smoke.py        end-to-end engine smoke test
```

## Parity

The seeded generator is ported bit-for-bit from `rng.ts` (`mulberry32`), and the
noise functions from `noise.ts`, so a given seed reproduces the same district,
orebody and shortfall as the frontend. Data records use the **same field names**
(camelCase) as the frontend so outputs are directly comparable.

### Recent additions (verified against the TypeScript bundle)

* **AI grade model → prospectivity.** `manganese_model.predict_manganese_grade()`
  is the deployed mn50 predictor (mirrors `MANGANESE_PREDICTOR` in
  `manganeseModel.ts`): a partial input is filled from the inventory median, so
  greenfield ground can be scored from a predicted depth alone. `prospectivity.py`
  blends it 50/50 with the belt prior into `expectedGradeMn`, and every target
  carries `aiGradeMn`, `aiPremiumProb` and `aiModelId`. All 26 targets matched the
  bundled frontend engine to **0.0 absolute difference** on every one of those
  fields.
* **Assistant → live engines.** `assistant.ask()` answers `production-risk`
  questions by calling `forecast_mine(..., 7)` and `build_alerts()` on the spot
  (same numbers as the Forecast screen), and answers `national-ai` questions from
  `MANGANESE_TRAINING`.

`POST /assistant` takes `{ "q": str, "mineId": str|null, "targetId": str|null,
"cutOff": number }` and returns the same `Answer` shape as `ask()` in the
frontend, so a caller can swap engines without changing its rendering.
