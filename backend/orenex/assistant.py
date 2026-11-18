"""Port of ``assistant.ts``.

A contextual assistant, not a chatbot.

It answers only from evidence already computed on the current screen, and every
answer carries the numbers and the model version behind it. If the evidence does
not support an answer, it says so.

Records (dicts) mirror the TypeScript interfaces — payload keys keep their exact
TypeScript (camelCase) spelling:

* ``AnswerBlock``: ``{kind, label?, value?, text?, items?, tone?}`` where
  ``kind`` is ``'text' | 'metric' | 'evidence' | 'caveat' | 'action'`` and
  ``tone`` is ``'default' | 'good' | 'warn' | 'bad'``.
* ``Answer``: ``{question, intent, blocks, sources, confidence,
  modelVersion?, followUps}``.
* ``AssistantContext``: ``{mineId, targetId, cutOff, estimate}``.
"""

from __future__ import annotations

import math
import re

from .format import num
from .prospectivity import NX, PROSPECTIVITY, TARGETS
from .reconciliation import ALL_OCI, company_oci
from .reserves import grade_tonnage
from .validation import validation
from .forecast import CAUSE_LABEL, FORECAST_MODEL_VERSION, build_alerts, forecast_mine
from .geology import MINES
from .manganese_model import GRADE_THRESHOLD, MANGANESE_TRAINING
from .operations import STAGE_LABEL

FALLBACK = {
    "question": "",
    "intent": "unknown",
    "blocks": [
        {
            "kind": "text",
            "text": "I can answer from what this screen has already computed: target evidence and depth bands, reserve grade–tonnage, forecast and bottleneck, alerts and action cards, validation metrics, and data freshness. Ask about the thing in front of you.",
        },
    ],
    "sources": [],
    "confidence": None,
    "followUps": ["Why is this target P1?", "What is driving production risk right now?", "How accurate is the prospectivity model?"],
}


def _target_by_id(target_id: str) -> dict | None:
    for t in TARGETS:
        if t["id"] == target_id:
            return t
    return None


def _group_label(g: str) -> str:
    if g == "geology":
        return "Geology"
    if g == "geophysics":
        return "Geophysics"
    if g == "spectral":
        return "Satellite"
    if g == "terrain":
        return "Terrain"
    if g == "environment":
        return "Environment"
    return g


def ask(question: str, ctx: dict) -> dict:
    q = question.strip().lower()
    t = _target_by_id(ctx["targetId"]) if ctx["targetId"] else None

    # ── Target explanation ────────────────────────────────────────────────
    if re.search(r"\b(why|p1|p2|p3|rank|score|prospectivity|evidence|confidence)\b", q) and t:
        top = [d for d in t["drivers"] if d["value"] > 0][:4]
        against = [d for d in t["drivers"] if d["value"] <= 0][:3]
        return {
            "question": question,
            "intent": "target-explanation",
            "blocks": [
                {
                    "kind": "text",
                    "text": f"{t['id']} is a {t['priority']} target because the model puts P(Mn occurrence within 300 m) at {(t['probability'] * 100):.0f}%, and the geology there is the strongest in the remaining untested ground. It ranks {t['rank']} of {len(TARGETS)}.",
                },
                {
                    "kind": "metric",
                    "label": "Prospectivity",
                    "value": f"{(t['probability'] * 100):.1f}%",
                    "text": f"Calibrated on spatial-holdout folds, so 0.80 means roughly 80% hit rate in V. Raw model score before calibration was {t['rawScore']:.2f}.",
                },
                {
                    "kind": "metric",
                    "label": "Grade expectation — mn50 AI",
                    "value": f"{(t.get('aiGradeMn') or 0):.1f}% Mn",
                    "text": f"The national AI model ({t.get('aiModelId') or 'mn50'}) predicts {(t.get('aiGradeMn') or 0):.1f}% Mn at this depth, with a {((t.get('aiPremiumProb') or 0) * 100):.0f}% premium-grade probability. Blended 50/50 with the belt prior it gives the {t['expectedGradeMn']:.1f}% Mn grade expectation quoted here.",
                },
                {
                    "kind": "evidence",
                    "label": "What pushes it up",
                    "items": [
                        f"{d['label']} — {'+' if d['value'] > 0 else ''}{d['value']:.2f} log-odds ({_group_label(d['group'])})"
                        for d in top
                    ],
                },
                {
                    "kind": "evidence",
                    "label": "What holds it back",
                    "items": (
                        [f"{d['label']} — {d['value']:.2f} log-odds" for d in against]
                        if against
                        else ["No feature is pushing this target down — the case is uniformly positive, which is itself worth questioning"]
                    ),
                },
                {
                    "kind": "text",
                    "text": t["evidence"]["geology"],
                },
                {
                    "kind": "caveat",
                    "text": f"Data coverage on this cell is {(_prospectivity_coverage(t['ci'], t['cj']) * 100):.0f}%. "
                    + (
                        "NGDR aerogeophysics is missing over part of this ground, so the geophysical term is interpolated — treat the score as indicative."
                        if _prospectivity_coverage(t["ci"], t["cj"]) < 0.8
                        else "All feature layers are present."
                    ),
                },
                {
                    "kind": "action",
                    "label": "Next step",
                    "text": (
                        f"Already validated in the field — {t['fieldResult']}"
                        if t["status"] == "validated"
                        else f"Drill {t['drillToM']} m to close the {t['depthTopM']}–{t['depthBottomM']} m band. Add to the field plan and sample the ore zone."
                    ),
                },
            ],
            "sources": ["m1-v7.3.0 (Mn occurrence prospectivity)", "m2-v4.1.2 (Depth band classifier)", f"{MANGANESE_TRAINING['version']} (National Mn grade AI)", "feature version fv-2026-09-14 · snapshot SNAP-2026-10-03-a91"],
            "confidence": t["probability"],
            "modelVersion": "m1-v7.3.0",
            "followUps": ["How deep should we drill?", "Compare this with the next target", "How accurate is this model?"],
        }

    # ── Depth ──────────────────────────────────────────────────────────────
    if re.search(r"depth|how deep|drill to|thickness", q) and t:
        return {
            "question": question,
            "intent": "depth",
            "blocks": [
                {
                    "kind": "text",
                    "text": f"The model puts the top of mineralisation between {t['depthTopM']} m and {t['depthBottomM']} m, with the best estimate near {math.floor((t['depthTopM'] + t['depthBottomM']) / 2 + 0.5)} m. That is an 80% interval, not a number to design a pit on.",
                },
                {
                    "kind": "metric",
                    "label": "Depth band (80% interval)",
                    "value": f"{t['depthTopM']}–{t['depthBottomM']} m",
                    "text": "Reported at 10 m steps by the depth-conditioned classifier.",
                },
                {
                    "kind": "metric",
                    "label": "Suggested first hole",
                    "value": f"{t['drillToM']} m",
                    "text": f"Deep enough to close the band with about {max(8, t['drillToM'] - t['depthBottomM'])} m of footwall below the 80% lower limit.",
                },
                {
                    "kind": "evidence",
                    "label": "Depth evidence behind this",
                    "items": [t["evidence"]["geology"], t["evidence"]["terrain"], f"Nearest Mn-positive sample: {t['evidence']['samples']}"],
                },
                {
                    "kind": "caveat",
                    "text": "Depth comes from drillholes and geophysics, not from satellite. Satellite maps where the horizon outcrops, not how deep it goes.",
                },
            ],
            "sources": ["m2-v4.1.2 (Depth band classifier)"],
            "confidence": 0.803,
            "modelVersion": "m2-v4.1.2",
            "followUps": ["Why is this target P1?", "What would confirm the depth?", "How much would this add to OCI?"],
        }

    # ── Accuracy / validation ──────────────────────────────────────────────
    if re.search(r"accurate|accuracy|auc|validation|reliable|trust|calibrat", q):
        V = validation()
        hidden = next((f for f in V["folds"] if f["hidden"]), None)
        in_district = [f for f in V["folds"] if not f["hidden"]]
        return {
            "question": question,
            "intent": "validation",
            "blocks": [
                {
                    "kind": "text",
                    "text": "These are spatial-holdout and backtest numbers, not one headline percentage. Random splits are banned for spatial data because neighbouring cells leak labels and inflate AUC.",
                },
                {
                    "kind": "metric",
                    "label": "Prospectivity AUC — in-district block CV",
                    "value": f"{(sum(f['auc'] for f in in_district) / len(in_district)):.3f}",
                    "text": f"5 km spatial blocks, mean across {len(in_district)} folds. Geology-only baseline is {V['geologyOnlyBaseline']['auc']:.3f}, so the satellite and geophysics layers add {(V['geologyOnlyBaseline']['gain'] * 100):.0f} points.",
                },
                {
                    "kind": "metric",
                    "label": "Prospectivity AUC — fully hidden district",
                    "value": f"{hidden['auc']:.3f}" if hidden else "—",
                    "text": "The honest test: all labels in the eastern district withheld. Lower than in-district, which is why the UI marks extrapolation as indicative.",
                },
                {
                    "kind": "metric",
                    "label": "Forecast MAE (7-day, portfolio)",
                    "value": f"{num(V['forecastValidation']['portfolio']['maeT'], 0)} t/day",
                    "text": f"Rolling-origin backtest, {V['forecastValidation']['perMine'][0]['origins']} origins per mine. Beats the trailing-30-day-mean planner by {V['forecastValidation']['portfolio']['improvementPct']}% — the acceptance target was 20%.",
                },
                {
                    "kind": "metric",
                    "label": "Shortfall alert recall at precision ≥ 0.6",
                    "value": f"{V['forecastValidation']['portfolio']['recall']} @ {V['forecastValidation']['portfolio']['precision']}",
                    "text": f"Measured per mine at each mine's own swept threshold, from {V['forecastValidation']['perMine'][0]['origins']} historical windows. "
                    + (
                        "Lead time is short: the engine gives warning on abrupt step changes, not on a gradual monsoon onset."
                        if V["forecastValidation"]["portfolio"]["medianLeadDays"] is None
                        else f"Median lead {V['forecastValidation']['portfolio']['medianLeadDays']} days."
                    ),
                },
                {
                    "kind": "metric",
                    "label": "Cause attribution against simulator ground truth",
                    "value": f"{V['causeAttribution']['correctPct']}%",
                    "text": f"Target ≥ {V['causeAttribution']['targetPct']}%. Only measurable because the simulator knows why every tonne was lost.",
                },
                {
                    "kind": "caveat",
                    "text": "Real accuracy needs MOIL-labelled data. Every metric here comes from public geodata plus a simulator, and the UI labels it as such.",
                },
            ],
            "sources": ["D10 model ops · validation suite", "m1-v7.3.0", "m5-v6.3.0"],
            "confidence": None,
            "followUps": ["Why is the geology-only baseline lower?", "What is the P10–P90 coverage?", "Which model is drifting?"],
        }

    # ── Production risk / shortfall — LIVE forecast engine ────────────────
    # This intent no longer quotes prose: it calls the same ``forecast_mine`` and
    # ``build_alerts`` the Forecast and Control-Room screens render, so the
    # copilot's numbers are the engine's numbers computed on this question, not a
    # cached snapshot. The source line says so explicitly.
    if re.search(r"risk|shortfall|production|bottleneck|downtime|alert|why.*fall|forecast|next\s+(seven|7|thirty|30)", q):
        alerts = build_alerts()
        mine_id = ctx["mineId"]

        if mine_id:
            f = forecast_mine(mine_id, [], 7)
            top = f["causeMix"][0]
            gap = max(0.0, f["planTotal7"] - f["p50Total7"])
            alert = next((a for a in alerts if a["mineId"] == mine_id), None)
            mine_name = next((m["name"] for m in MINES if m["id"] == mine_id), mine_id)
            return {
                "question": question,
                "intent": "production-risk",
                "blocks": [
                    {
                        "kind": "text",
                        "text": f"{mine_name}: a mine produces no more than its slowest stage, so the capacity model takes the minimum across drill, blast, muck, haul and hoist. Over the next 7 days that stage is {STAGE_LABEL[f['bottleneck']].lower()}.",
                    },
                    {
                        "kind": "metric",
                        "label": "P(7-day plan missed)",
                        "value": f"{f['pShort7'] * 100:.0f}%",
                        "text": f"Plan {num(f['planTotal7'], 0)} t against a median forecast of {num(f['p50Total7'], 0)} t — a gap of about {num(gap, 0)} t.",
                        "tone": "bad" if f["pShort7"] >= 0.9 else ("warn" if f["pShort7"] >= 0.5 else "good"),
                    },
                    {
                        "kind": "metric",
                        "label": "Bottleneck stage (7-day)",
                        "value": STAGE_LABEL[f["bottleneck"]],
                        "text": f"Capacity loss is led by {CAUSE_LABEL[top['bucket']].lower()} at {top['share'] * 100:.0f}% of the total over the window.",
                    },
                    {
                        "kind": "evidence",
                        "label": "Cause mix — capacity removed over 7 days",
                        "items": [
                            f"{CAUSE_LABEL[c['bucket']]} — {num(c['tonnes'], 0)} t ({c['share'] * 100:.0f}%)"
                            for c in f["causeMix"]
                        ],
                    },
                    (
                        {
                            "kind": "action",
                            "label": f"Alert {alert['id']} · {alert['severity'].upper()}",
                            "text": alert["headline"],
                        }
                        if alert
                        else {
                            "kind": "caveat",
                            "text": "No material shortfall alert is open for this mine — both the 7-day and 30-day windows clear their trigger.",
                        }
                    ),
                    {
                        "kind": "caveat",
                        "text": "Every action needs your approval before anything moves — ORENEX never commands equipment.",
                    },
                ],
                "sources": [
                    f"{FORECAST_MODEL_VERSION} (Production quantile forecast)",
                    "d7-v3.1.0 (Action engine)",
                    "live engine — computed on this question, not a cached snapshot",
                ],
                "confidence": f["pShort7"],
                "modelVersion": FORECAST_MODEL_VERSION,
                "followUps": ["Which mine needs attention first?", "How far ahead does it see?", "What would clear the bottleneck?"],
            }

        # No mine selected — rank the live alert board instead of guessing.
        ranked = sorted(alerts, key=lambda a: -a["pShort"])
        return {
            "question": question,
            "intent": "production-risk",
            "blocks": [
                {
                    "kind": "text",
                    "text": f"The live engine returns {len(alerts)} open shortfall alert{'s' if len(alerts) != 1 else ''} across the belt as of now.",
                },
                *[
                    {
                        "kind": "metric",
                        "label": f"{a['mineName']} · {a['horizonDays']}-day",
                        "value": f"{a['pShort'] * 100:.0f}% · {num(a['shortfallT'], 0)} t",
                        "text": f"{a['severity'].upper()} — {a['headline']}",
                        "tone": "bad" if a["severity"] == "critical" else ("warn" if a["severity"] == "high" else "default"),
                    }
                    for a in ranked[:5]
                ],
                {
                    "kind": "caveat",
                    "text": "Select a mine for its own bottleneck and cause breakdown. Every action needs your approval — ORENEX never commands equipment.",
                },
            ],
            "sources": [
                f"{FORECAST_MODEL_VERSION} (Production quantile forecast)",
                "live engine — computed on this question, not a cached snapshot",
            ],
            "confidence": None,
            "modelVersion": FORECAST_MODEL_VERSION,
            "followUps": ["What is the bottleneck stage?", "How far ahead does it see?", "What would clear the bottleneck?"],
        }

    # ── Compare two targets ────────────────────────────────────────────────
    if re.search(r"compare|two targets|versus| vs ", q) and t:
        other = next((x for x in TARGETS if x["id"] != t["id"] and x["priority"] == t["priority"]), None)
        if other is None:
            other = TARGETS[1]
        return {
            "question": question,
            "intent": "compare",
            "blocks": [
                {
                    "kind": "text",
                    "text": f"Comparing {t['id']} with {other['id']}.",
                },
                {
                    "kind": "metric",
                    "label": t["id"],
                    "value": f"P={(t['probability'] * 100):.1f}% · {t['depthTopM']}–{t['depthBottomM']} m",
                    "text": f"{t['setting']}, {t['nearestMineKm']:.1f} km from {t['nearestMineName']}. Grade expectation {t['expectedGradeMn']:.1f}% Mn.",
                },
                {
                    "kind": "metric",
                    "label": other["id"],
                    "value": f"P={(other['probability'] * 100):.1f}% · {other['depthTopM']}–{other['depthBottomM']} m",
                    "text": f"{other['setting']}, {other['nearestMineKm']:.1f} km from {other['nearestMineName']}. Grade expectation {other['expectedGradeMn']:.1f}% Mn.",
                },
                {
                    "kind": "evidence",
                    "label": "Where they differ",
                    "items": [
                        f"Depth: {t['id']} needs a {t['drillToM']} m hole, {other['id']} needs {other['drillToM']} m",
                        f"Proximity: {t['id'] if t['nearestMineKm'] < other['nearestMineKm'] else other['id']} is closer to existing infrastructure",
                        f"Status: {t['id']} is {t['status']}, {other['id']} is {other['status']}",
                    ],
                },
            ],
            "sources": ["m1-v7.3.0", "m2-v4.1.2"],
            "confidence": (t["probability"] + other["probability"]) / 2,
            "modelVersion": "m1-v7.3.0",
            "followUps": [f"Why is {t['id']} P1?", f"How deep should we drill {other['id']}?"],
        }

    # ── Reserve / cut-off ──────────────────────────────────────────────────
    if re.search(r"reserve|cut.?off|tonnage|grade.?tonnage|contained", q):
        if not ctx["estimate"]:
            return {**FALLBACK, "question": question, "intent": "reserve"}
        curve = grade_tonnage(ctx["estimate"], [ctx["cutOff"]])
        pt = curve[0]
        return {
            "question": question,
            "intent": "reserve",
            "blocks": [
                {
                    "kind": "text",
                    "text": f"At a {ctx['cutOff']}% Mn cut-off, {ctx['estimate']['name']} holds {num(pt['totalTonnes'], 0)} t of in-domain ore grading {pt['gradeMn']:.2f}% Mn, for {num(pt['containedMn'], 0)} t of contained metal.",
                },
                {
                    "kind": "metric",
                    "label": "P10–P90 on tonnage",
                    "value": f"{num(pt['tonnesP10'], 0)} – {num(pt['tonnesP90'], 0)} t",
                    "text": "From 100 sequential Gaussian realisations of the kriging variance.",
                },
                {
                    "kind": "metric",
                    "label": "Uncertainty",
                    "value": f"± {((pt['tonnesP90'] - pt['tonnesP10']) / 2 / pt['totalTonnes'] * 100):.0f}%",
                    "text": "Change the cut-off and this widens or narrows — the grade–tonnage curve on the Reserves screen shows the whole range rather than one number.",
                },
                {
                    "kind": "caveat",
                    "text": "These are indicative confidence classes for planning, labelled Measured / Indicated / Inferred. Declared reserves under UNFC and MMDR remain with qualified persons.",
                },
            ],
            "sources": ["g1-v4.2.1 (Block grade estimator)", "snapshot SNAP-2026-10-03-a91"],
            "confidence": None,
            "modelVersion": "g1-v4.2.1",
            "followUps": ["What is the cut-off sensitivity?", "What is the OCI at this cut-off?", "How accurate is the grade estimate?"],
        }

    # ── OCI ────────────────────────────────────────────────────────────────
    if re.search(r"oci|continuity|cover|months|ore supply", q):
        rows = [r for r in ALL_OCI if r["mineId"] == ctx["mineId"]] if ctx["mineId"] else ALL_OCI
        co = company_oci()
        return {
            "question": question,
            "intent": "oci",
            "blocks": [
                {
                    "kind": "text",
                    "text": "The Ore Continuity Index is accessible validated tonnes divided by planned monthly depletion — months of ore cover. Green above 9 months, amber near 6, red below.",
                },
                *[
                    {
                        "kind": "metric",
                        "label": r["mineName"],
                        "value": f"{r['oci']:.1f} months",
                        "text": f"{num(r['accessibleTonnes'], 0)} t accessible against {num(r['monthlyDepletionT'], 0)} t/month depletion — {r['band']}.",
                        "tone": "good" if r["band"] == "green" else ("warn" if r["band"] == "amber" else "bad"),
                    }
                    for r in rows
                ],
                {
                    "kind": "metric",
                    "label": "Company-wide",
                    "value": f"{co['oci']:.1f} months",
                    "text": f"Across all three prototype mines: {num(co['accessibleTonnes'], 0)} t accessible.",
                },
                {
                    "kind": "caveat",
                    "text": "Accessible tonnes are measured plus indicated at the default cut-off. Inferred tonnes are excluded deliberately — you cannot schedule mining on inferred ore.",
                },
            ],
            "sources": ["g1-v4.2.1", "D6 forecast"],
            "confidence": None,
            "followUps": ["Which mine needs attention first?", "What would extend cover?", "Show the grade-tonnage curve"],
        }

    # ── Data freshness / coverage ──────────────────────────────────────────
    if re.search(r"data|fresh|stale|coverage|missing|source", q):
        return {
            "question": question,
            "intent": "data",
            "blocks": [
                {
                    "kind": "text",
                    "text": "Geology and satellite are real and public. MOIL-private tables — drillholes, production, equipment, blast logs — are simulated with the same fixed schemas, so the real data drops in through the loaders only.",
                },
                {
                    "kind": "evidence",
                    "label": "The one thing to know",
                    "items": [
                        "Every feature carries a <name>_avail flag, so a missing value is null plus a flag, never a zero",
                        "Coverage percentage is shown next to every prediction",
                        "A missing value is stored as null + availability flag, never as 0",
                        "NGDR aerogeophysics has been stale for 82 days — that is why some targets are marked reduced-confidence",
                    ],
                },
                {
                    "kind": "action",
                    "label": "Next step",
                    "text": "Open the Data screen to see per-source freshness, validation pass rate and processing history.",
                },
            ],
            "sources": ["source_catalog", "D1 ingestion"],
            "confidence": None,
            "followUps": ["Which sources are stale?", "What does coverage mean here?", "How are synthetic tables marked?"],
        }

    # ── Model version / drift ──────────────────────────────────────────────
    if re.search(r"model|version|drift|promote|registry", q):
        return {
            "question": question,
            "intent": "model",
            "blocks": [
                {
                    "kind": "text",
                    "text": "Every prediction carries model_version, feature version, data snapshot and code SHA, so any number on screen can be re-created exactly.",
                },
                {
                    "kind": "evidence",
                    "label": "How a model gets promoted",
                    "items": [
                        "Assemble the training set from a pinned snapshot and feature version",
                        "Split with the model's own scheme — spatial blocks, leave-hole-out or rolling time. Never random rows",
                        "Tune inside the training folds only, then evaluate on the outer test folds",
                        "Register in MLflow with metrics and a model card",
                        "Gate: promote only if it beats the incumbent without degrading any mine by more than tolerance, and a named reviewer approves",
                    ],
                },
                {
                    "kind": "caveat",
                    "text": "m5 production forecast is on drift watch — population stability index 0.212 against a 0.20 alert threshold. Sustained forecast error above threshold opens a retrain ticket automatically.",
                },
            ],
            "sources": ["D10 model ops", "m5-v6.3.0"],
            "confidence": None,
            "followUps": ["Show the validation metrics", "Which model is drifting?", "What happens on promotion?"],
        }

    # ── National manganese AI model (mn50) — our AI ───────────────────────
    if re.search(r"mn50|manganese model|national model|premium|grade model|ai grade|which mines.*(premium|high.?grade)|top mining|best mine", q):
        T = MANGANESE_TRAINING
        R = T["regression"]["metrics"]
        C = T["classification"]["metrics"]
        premium = sorted(
            [p for p in T["predictions"] if p["highProb"] >= 0.5],
            key=lambda p: -p["highProb"],
        )
        top_grade = sorted(T["predictions"], key=lambda p: -p["cvPredictedGrade"])[:5]
        return {
            "question": question,
            "intent": "national-ai",
            "blocks": [
                {
                    "kind": "text",
                    "text": f"{T['modelId']} ({T['version']}) is our national manganese model — a ridge grade regressor and a logistic premium-grade classifier fitted on {T['rows']} principal Indian manganese mines, entirely in-browser. These are out-of-fold numbers, not train-set.",
                },
                {
                    "kind": "metric",
                    "label": "Grade regressor — 5-fold CV R²",
                    "value": f"{R['r2']:.2f}",
                    "text": f"MAE {R['mae']:.2f} %Mn, RMSE {R['rmse']:.2f}. With 50 rows an R² this size is honest but modest — treat it as a screening model, not a reserve statement.",
                },
                {
                    "kind": "metric",
                    "label": f"Premium classifier — P(grade ≥ {GRADE_THRESHOLD}% Mn)",
                    "value": f"AUC {C['auc']:.2f}",
                    "text": f"Accuracy {C['accuracy'] * 100:.0f}%, precision {C['precision'] * 100:.0f}%, recall {C['recall'] * 100:.0f}%.",
                },
                {
                    "kind": "evidence",
                    "label": "Highest predicted grades",
                    "items": [
                        f"{p['name']} ({p['state']}) — {p['cvPredictedGrade']:.1f}% Mn predicted vs {p['actualGrade']:.1f}% actual, premium P={p['highProb'] * 100:.0f}%"
                        for p in top_grade
                    ],
                },
                {
                    "kind": "metric",
                    "label": "Mines the AI flags premium",
                    "value": f"{len(premium)} of {T['rows']}",
                    "text": (
                        f"Led by {', '.join(p['name'] for p in premium[:3])}."
                        if premium
                        else "None clear the 50% confidence bar at this threshold."
                    ),
                },
                {
                    "kind": "caveat",
                    "text": "This same model now anchors the grade estimate on the Prospectivity targets — see each target's AI grade. Source rows are public and indicative; replace with audited mine-plan data.",
                },
            ],
            "sources": [
                f"{T['version']} (National Mn grade & premium)",
                "INDIA-MN-50 · fv-mn50-1",
                "live model — fitted on load",
            ],
            "confidence": R["r2"],
            "modelVersion": T["version"],
            "followUps": ["Which mines are premium grade?", "How accurate is the prospectivity model?", "Why is this target P1?"],
        }

    return {**FALLBACK, "question": question, "intent": "unknown"}


def _prospectivity_coverage(ci: int, cj: int) -> float:
    """Coverage of the analysis cell a target sits in."""
    if ci < 0 or cj < 0 or ci >= NX or cj >= PROSPECTIVITY["ny"]:
        return 0.9
    return PROSPECTIVITY["coverage"][cj * NX + ci]


SUGGESTED_QUESTIONS = [
    "Why is this target P1?",
    "What is driving production risk right now?",
    "How accurate is the prospectivity model?",
    "Which mines does the AI flag as premium grade?",
    "How much would this add to OCI?",
    "Which data sources are stale?",
    "Compare the top two targets",
]

EXPLAIN_INTENTS = [
    {"intent": "target-explanation", "label": "Target evidence & drivers", "needs": "target"},
    {"intent": "depth", "label": "Depth band & drill depth", "needs": "target"},
    {"intent": "compare", "label": "Compare two targets", "needs": "target"},
    {"intent": "production-risk", "label": "Production risk & bottleneck (live)", "needs": "mine"},
    {"intent": "national-ai", "label": "National AI model (mn50)", "needs": "none"},
    {"intent": "reserve", "label": "Reserve position & cut-off", "needs": "estimate"},
    {"intent": "oci", "label": "Ore continuity", "needs": "mine"},
    {"intent": "validation", "label": "Model accuracy & validation", "needs": "none"},
    {"intent": "data", "label": "Data coverage & freshness", "needs": "none"},
    {"intent": "model", "label": "Model versions & governance", "needs": "none"},
]
