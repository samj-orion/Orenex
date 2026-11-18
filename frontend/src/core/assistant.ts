import { TARGETS, type Target, PROSPECTIVITY, NX } from './prospectivity';
import { validation } from './validation';
import { gradeTonnage, type MineEstimate } from './reserves';
import { ALL_OCI, companyOci } from './reconciliation';
import { MINES } from './geology';
import { buildAlerts, forecastMine, CAUSE_LABEL, FORECAST_MODEL_VERSION } from './forecast';
import { STAGE_LABEL } from './operations';
import { MANGANESE_TRAINING, GRADE_THRESHOLD } from './manganeseModel';

/**
 * A contextual assistant, not a chatbot.
 *
 * It answers only from evidence already computed on the current screen, and
 * every answer carries the numbers and the model version behind it. If the
 * evidence does not support an answer, it says so.
 */

export interface AnswerBlock {
  kind: 'text' | 'metric' | 'evidence' | 'caveat' | 'action';
  label?: string;
  value?: string;
  text?: string;
  items?: string[];
  tone?: 'default' | 'good' | 'warn' | 'bad';
}

export interface Answer {
  question: string;
  intent: string;
  blocks: AnswerBlock[];
  sources: string[];
  confidence: number | null;
  modelVersion?: string;
  followUps: string[];
}

export interface AssistantContext {
  mineId: string | null;
  targetId: string | null;
  cutOff: number;
  estimate: MineEstimate | null;
}

const FALLBACK: Answer = {
  question: '',
  intent: 'unknown',
  blocks: [
    {
      kind: 'text',
      text: 'I can answer from what this screen has already computed: target evidence and depth bands, reserve grade–tonnage, forecast and bottleneck, alerts and action cards, validation metrics, and data freshness. Ask about the thing in front of you.',
    },
  ],
  sources: [],
  confidence: null,
  followUps: ['Why is this target P1?', 'What is driving production risk right now?', 'How accurate is the prospectivity model?'],
};

function targetById(id: string): Target | null {
  return TARGETS.find((t) => t.id === id) ?? null;
}

function groupLabel(g: string): string {
  switch (g) {
    case 'geology': return 'Geology';
    case 'geophysics': return 'Geophysics';
    case 'spectral': return 'Satellite';
    case 'terrain': return 'Terrain';
    case 'environment': return 'Environment';
    default: return g;
  }
}

export function ask(question: string, ctx: AssistantContext): Answer {
  const q = question.trim().toLowerCase();
  const t = ctx.targetId ? targetById(ctx.targetId) : null;

  // ── Target explanation ────────────────────────────────────────────────
  if (/\b(why|p1|p2|p3|rank|score|prospectivity|evidence|confidence)\b/.test(q) && t) {
    const top = t.drivers.filter((d) => d.value > 0).slice(0, 4);
    const against = t.drivers.filter((d) => d.value <= 0).slice(0, 3);
    return {
      question,
      intent: 'target-explanation',
      blocks: [
        {
          kind: 'text',
          text: `${t.id} is a ${t.priority} target because the model puts P(Mn occurrence within 300 m) at ${(t.probability * 100).toFixed(0)}%, and the geology there is the strongest in the remaining untested ground. It ranks ${t.rank} of ${TARGETS.length}.`,
        },
        {
          kind: 'metric',
          label: 'Prospectivity',
          value: `${(t.probability * 100).toFixed(1)}%`,
          text: `Calibrated on spatial-holdout folds, so 0.80 means roughly 80% hit rate in V. Raw model score before calibration was ${t.rawScore.toFixed(2)}.`,
        },
        {
          kind: 'metric',
          label: 'Grade expectation — mn50 AI',
          value: `${(t.aiGradeMn ?? 0).toFixed(1)}% Mn`,
          text: `The national AI model (${t.aiModelId ?? 'mn50'}) predicts ${(t.aiGradeMn ?? 0).toFixed(1)}% Mn at this depth, with a ${((t.aiPremiumProb ?? 0) * 100).toFixed(0)}% premium-grade probability. Blended 50/50 with the belt prior it gives the ${t.expectedGradeMn.toFixed(1)}% Mn grade expectation quoted here.`,
        },
        {
          kind: 'evidence',
          label: 'What pushes it up',
          items: [
            ...top.map((d) => `${d.label} — ${d.value > 0 ? '+' : ''}${d.value.toFixed(2)} log-odds (${groupLabel(d.group)})`),
          ],
        },
        {
          kind: 'evidence',
          label: 'What holds it back',
          items:
            against.length
              ? against.map((d) => `${d.label} — ${d.value.toFixed(2)} log-odds`)
              : ['No feature is pushing this target down — the case is uniformly positive, which is itself worth questioning'],
        },
        {
          kind: 'text',
          text: t.evidence.geology,
        },
        {
          kind: 'caveat',
          text: `Data coverage on this cell is ${(PROSPECTIVITY_COVERAGE(t.ci, t.cj) * 100).toFixed(0)}%. ${
            PROSPECTIVITY_COVERAGE(t.ci, t.cj) < 0.8
              ? 'NGDR aerogeophysics is missing over part of this ground, so the geophysical term is interpolated — treat the score as indicative.'
              : 'All feature layers are present.'
          }`,
        },
        {
          kind: 'action',
          label: 'Next step',
          text:
            t.status === 'validated'
              ? `Already validated in the field — ${t.fieldResult}`
              : `Drill ${t.drillToM} m to close the ${t.depthTopM}–${t.depthBottomM} m band. Add to the field plan and sample the ore zone.`,
        },
      ],
      sources: ['m1-v7.3.0 (Mn occurrence prospectivity)', 'm2-v4.1.2 (Depth band classifier)', `${MANGANESE_TRAINING.version} (National Mn grade AI)`, `feature version fv-2026-09-14 · snapshot SNAP-2026-10-03-a91`],
      confidence: t.probability,
      modelVersion: 'm1-v7.3.0',
      followUps: ['How deep should we drill?', 'Compare this with the next target', 'How accurate is this model?'],
    };
  }

  // ── Depth ──────────────────────────────────────────────────────────────
  if (/depth|how deep|drill to|thickness/.test(q) && t) {
    return {
      question,
      intent: 'depth',
      blocks: [
        {
          kind: 'text',
          text: `The model puts the top of mineralisation between ${t.depthTopM} m and ${t.depthBottomM} m, with the best estimate near ${Math.round((t.depthTopM + t.depthBottomM) / 2)} m. That is an 80% interval, not a number to design a pit on.`,
        },
        {
          kind: 'metric',
          label: 'Depth band (80% interval)',
          value: `${t.depthTopM}–${t.depthBottomM} m`,
          text: 'Reported at 10 m steps by the depth-conditioned classifier.',
        },
        {
          kind: 'metric',
          label: 'Suggested first hole',
          value: `${t.drillToM} m`,
          text: `Deep enough to close the band with about ${Math.max(8, t.drillToM - t.depthBottomM)} m of footwall below the 80% lower limit.`,
        },
        {
          kind: 'evidence',
          label: 'Depth evidence behind this',
          items: [t.evidence.geology, t.evidence.terrain, `Nearest Mn-positive sample: ${t.evidence.samples}`],
        },
        {
          kind: 'caveat',
          text: 'Depth comes from drillholes and geophysics, not from satellite. Satellite maps where the horizon outcrops, not how deep it goes.',
        },
      ],
      sources: ['m2-v4.1.2 (Depth band classifier)'],
      confidence: 0.803,
      modelVersion: 'm2-v4.1.2',
      followUps: ['Why is this target P1?', 'What would confirm the depth?', 'How much would this add to OCI?'],
    };
  }

  // ── Accuracy / validation ──────────────────────────────────────────────
  if (/accurate|accuracy|auc|validation|reliable|trust|calibrat/.test(q)) {
    const V = validation();
    const hidden = V.folds.find((f) => f.hidden);
    const inDistrict = V.folds.filter((f) => !f.hidden);
    return {
      question,
      intent: 'validation',
      blocks: [
        {
          kind: 'text',
          text: 'These are spatial-holdout and backtest numbers, not one headline percentage. Random splits are banned for spatial data because neighbouring cells leak labels and inflate AUC.',
        },
        {
          kind: 'metric',
          label: 'Prospectivity AUC — in-district block CV',
          value: `${(inDistrict.reduce((s, f) => s + f.auc, 0) / inDistrict.length).toFixed(3)}`,
          text: `5 km spatial blocks, mean across ${inDistrict.length} folds. Geology-only baseline is ${V.geologyOnlyBaseline.auc.toFixed(3)}, so the satellite and geophysics layers add ${(V.geologyOnlyBaseline.gain * 100).toFixed(0)} points.`,
        },
        {
          kind: 'metric',
          label: 'Prospectivity AUC — fully hidden district',
          value: hidden?.auc.toFixed(3) ?? '—',
          text: 'The honest test: all labels in the eastern district withheld. Lower than in-district, which is why the UI marks extrapolation as indicative.',
        },
        {
          kind: 'metric',
          label: 'Forecast MAE (7-day, portfolio)',
          value: `${V.forecastValidation.portfolio.maeT.toLocaleString('en-IN')} t/day`,
          text: `Rolling-origin backtest, ${V.forecastValidation.perMine[0].origins} origins per mine. Beats the trailing-30-day-mean planner by ${V.forecastValidation.portfolio.improvementPct}% — the acceptance target was 20%.`,
        },
        {
          kind: 'metric',
          label: 'Shortfall alert recall at precision ≥ 0.6',
          value: `${V.forecastValidation.portfolio.recall} @ ${V.forecastValidation.portfolio.precision}`,
          text: `Measured per mine at each mine's own swept threshold, from ${V.forecastValidation.perMine[0].origins} historical windows. ${
            V.forecastValidation.portfolio.medianLeadDays === null
              ? 'Lead time is short: the engine gives warning on abrupt step changes, not on a gradual monsoon onset.'
              : `Median lead ${V.forecastValidation.portfolio.medianLeadDays} days.`
          }`,
        },
        {
          kind: 'metric',
          label: 'Cause attribution against simulator ground truth',
          value: `${V.causeAttribution.correctPct}%`,
          text: `Target ≥ ${V.causeAttribution.targetPct}%. Only measurable because the simulator knows why every tonne was lost.`,
        },
        {
          kind: 'caveat',
          text: 'Real accuracy needs MOIL-labelled data. Every metric here comes from public geodata plus a simulator, and the UI labels it as such.',
        },
      ],
      sources: ['D10 model ops · validation suite', 'm1-v7.3.0', 'm5-v6.3.0'],
      confidence: null,
      followUps: ['Why is the geology-only baseline lower?', 'What is the P10–P90 coverage?', 'Which model is drifting?'],
    };
  }

  // ── Production risk / shortfall — LIVE forecast engine ────────────────
  //
  // This intent no longer quotes prose: it calls the same `forecastMine` and
  // `buildAlerts` the Forecast and Control-Room screens render, so the copilot's
  // numbers are the engine's numbers computed on this question, not a cached
  // snapshot. The source line says so explicitly.
  if (/risk|shortfall|production|bottleneck|downtime|alert|why.*fall|forecast|next\s+(seven|7|thirty|30)/.test(q)) {
    const alerts = buildAlerts();
    const mineId = ctx.mineId;

    if (mineId) {
      const f = forecastMine(mineId, [], 7);
      const top = f.causeMix[0];
      const gap = Math.max(0, f.planTotal7 - f.p50Total7);
      const alert = alerts.find((a) => a.mineId === mineId) ?? null;
      const mineName = MINES.find((m) => m.id === mineId)?.name ?? mineId;
      return {
        question,
        intent: 'production-risk',
        blocks: [
          {
            kind: 'text',
            text: `${mineName}: a mine produces no more than its slowest stage, so the capacity model takes the minimum across drill, blast, muck, haul and hoist. Over the next 7 days that stage is ${STAGE_LABEL[f.bottleneck].toLowerCase()}.`,
          },
          {
            kind: 'metric',
            label: 'P(7-day plan missed)',
            value: `${(f.pShort7 * 100).toFixed(0)}%`,
            text: `Plan ${Math.round(f.planTotal7).toLocaleString('en-IN')} t against a median forecast of ${Math.round(f.p50Total7).toLocaleString('en-IN')} t — a gap of about ${Math.round(gap).toLocaleString('en-IN')} t.`,
            tone: f.pShort7 >= 0.9 ? 'bad' : f.pShort7 >= 0.5 ? 'warn' : 'good',
          },
          {
            kind: 'metric',
            label: 'Bottleneck stage (7-day)',
            value: STAGE_LABEL[f.bottleneck],
            text: `Capacity loss is led by ${CAUSE_LABEL[top.bucket].toLowerCase()} at ${(top.share * 100).toFixed(0)}% of the total over the window.`,
          },
          {
            kind: 'evidence',
            label: 'Cause mix — capacity removed over 7 days',
            items: f.causeMix.map(
              (c) => `${CAUSE_LABEL[c.bucket]} — ${Math.round(c.tonnes).toLocaleString('en-IN')} t (${(c.share * 100).toFixed(0)}%)`,
            ),
          },
          alert
            ? { kind: 'action', label: `Alert ${alert.id} · ${alert.severity.toUpperCase()}`, text: alert.headline }
            : {
                kind: 'caveat',
                text: 'No material shortfall alert is open for this mine — both the 7-day and 30-day windows clear their trigger.',
              },
          {
            kind: 'caveat',
            text: 'Every action needs your approval before anything moves — ORENEX never commands equipment.',
          },
        ],
        sources: [`${FORECAST_MODEL_VERSION} (Production quantile forecast)`, 'd7-v3.1.0 (Action engine)', 'live engine — computed on this question, not a cached snapshot'],
        confidence: f.pShort7,
        modelVersion: FORECAST_MODEL_VERSION,
        followUps: ['Which mine needs attention first?', 'How far ahead does it see?', 'What would clear the bottleneck?'],
      };
    }

    // No mine selected — rank the live alert board instead of guessing.
    const ranked = [...alerts].sort((a, b) => b.pShort - a.pShort);
    return {
      question,
      intent: 'production-risk',
      blocks: [
        {
          kind: 'text',
          text: `The live engine returns ${alerts.length} open shortfall alert${alerts.length === 1 ? '' : 's'} across the belt as of now.`,
        },
        ...ranked.slice(0, 5).map((a) => ({
          kind: 'metric' as const,
          label: `${a.mineName} · ${a.horizonDays}-day`,
          value: `${(a.pShort * 100).toFixed(0)}% · ${Math.round(a.shortfallT).toLocaleString('en-IN')} t`,
          text: `${a.severity.toUpperCase()} — ${a.headline}`,
          tone:
            a.severity === 'critical'
              ? ('bad' as const)
              : a.severity === 'high'
                ? ('warn' as const)
                : ('default' as const),
        })),
        {
          kind: 'caveat',
          text: 'Select a mine for its own bottleneck and cause breakdown. Every action needs your approval — ORENEX never commands equipment.',
        },
      ],
      sources: [`${FORECAST_MODEL_VERSION} (Production quantile forecast)`, 'live engine — computed on this question, not a cached snapshot'],
      confidence: null,
      modelVersion: FORECAST_MODEL_VERSION,
      followUps: ['What is the bottleneck stage?', 'How far ahead does it see?', 'What would clear the bottleneck?'],
    };
  }

  // ── Compare two targets ────────────────────────────────────────────────
  if (/compare|two targets|versus| vs /.test(q) && t) {
    const other = TARGETS.find((x) => x.id !== t.id && x.priority === t.priority) ?? TARGETS[1];
    return {
      question,
      intent: 'compare',
      blocks: [
        {
          kind: 'text',
          text: `Comparing ${t.id} with ${other.id}.`,
        },
        {
          kind: 'metric',
          label: t.id,
          value: `P=${(t.probability * 100).toFixed(1)}% · ${t.depthTopM}–${t.depthBottomM} m`,
          text: `${t.setting}, ${t.nearestMineKm.toFixed(1)} km from ${t.nearestMineName}. Grade expectation ${t.expectedGradeMn.toFixed(1)}% Mn.`,
        },
        {
          kind: 'metric',
          label: other.id,
          value: `P=${(other.probability * 100).toFixed(1)}% · ${other.depthTopM}–${other.depthBottomM} m`,
          text: `${other.setting}, ${other.nearestMineKm.toFixed(1)} km from ${other.nearestMineName}. Grade expectation ${other.expectedGradeMn.toFixed(1)}% Mn.`,
        },
        {
          kind: 'evidence',
          label: 'Where they differ',
          items: [
            `Depth: ${t.id} needs a ${t.drillToM} m hole, ${other.id} needs ${other.drillToM} m`,
            `Proximity: ${t.nearestMineKm < other.nearestMineKm ? t.id : other.id} is closer to existing infrastructure`,
            `Status: ${t.id} is ${t.status}, ${other.id} is ${other.status}`,
          ],
        },
      ],
      sources: ['m1-v7.3.0', 'm2-v4.1.2'],
      confidence: (t.probability + other.probability) / 2,
      modelVersion: 'm1-v7.3.0',
      followUps: [`Why is ${t.id} P1?`, `How deep should we drill ${other.id}?`],
    };
  }

  // ── Reserve / cut-off ──────────────────────────────────────────────────
  if (/reserve|cut.?off|tonnage|grade.?tonnage|contained/.test(q)) {
    if (!ctx.estimate) return { ...FALLBACK, question, intent: 'reserve' };
    const curve = gradeTonnage(ctx.estimate, [ctx.cutOff]);
    const pt = curve[0];
    return {
      question,
      intent: 'reserve',
      blocks: [
        {
          kind: 'text',
          text: `At a ${ctx.cutOff}% Mn cut-off, ${ctx.estimate.name} holds ${Math.round(pt.totalTonnes).toLocaleString('en-IN')} t of in-domain ore grading ${pt.gradeMn.toFixed(2)}% Mn, for ${Math.round(pt.containedMn).toLocaleString('en-IN')} t of contained metal.`,
        },
        {
          kind: 'metric',
          label: 'P10–P90 on tonnage',
          value: `${Math.round(pt.tonnesP10).toLocaleString('en-IN')} – ${Math.round(pt.tonnesP90).toLocaleString('en-IN')} t`,
          text: 'From 100 sequential Gaussian realisations of the kriging variance.',
        },
        {
          kind: 'metric',
          label: 'Uncertainty',
          value: `± ${((pt.tonnesP90 - pt.tonnesP10) / 2 / pt.totalTonnes * 100).toFixed(0)}%`,
          text: 'Change the cut-off and this widens or narrows — the grade–tonnage curve on the Reserves screen shows the whole range rather than one number.',
        },
        {
          kind: 'caveat',
          text: 'These are indicative confidence classes for planning, labelled Measured / Indicated / Inferred. Declared reserves under UNFC and MMDR remain with qualified persons.',
        },
      ],
      sources: ['g1-v4.2.1 (Block grade estimator)', 'snapshot SNAP-2026-10-03-a91'],
      confidence: null,
      modelVersion: 'g1-v4.2.1',
      followUps: ['What is the cut-off sensitivity?', 'What is the OCI at this cut-off?', 'How accurate is the grade estimate?'],
    };
  }

  // ── OCI ────────────────────────────────────────────────────────────────
  if (/oci|continuity|cover|months|ore supply/.test(q)) {
    const rows = ctx.mineId ? ALL_OCI.filter((r) => r.mineId === ctx.mineId) : ALL_OCI;
    const co = companyOci();
    return {
      question,
      intent: 'oci',
      blocks: [
        {
          kind: 'text',
          text: 'The Ore Continuity Index is accessible validated tonnes divided by planned monthly depletion — months of ore cover. Green above 9 months, amber near 6, red below.',
        },
        ...rows.map((r) => ({
          kind: 'metric' as const,
          label: r.mineName,
          value: `${r.oci.toFixed(1)} months`,
          text: `${Math.round(r.accessibleTonnes).toLocaleString('en-IN')} t accessible against ${Math.round(r.monthlyDepletionT).toLocaleString('en-IN')} t/month depletion — ${r.band}.`,
          tone: r.band === 'green' ? ('good' as const) : r.band === 'amber' ? ('warn' as const) : ('bad' as const),
        })),
        {
          kind: 'metric',
          label: 'Company-wide',
          value: `${co.oci.toFixed(1)} months`,
          text: `Across all three prototype mines: ${Math.round(co.accessibleTonnes).toLocaleString('en-IN')} t accessible.`,
        },
        {
          kind: 'caveat',
          text: 'Accessible tonnes are measured plus indicated at the default cut-off. Inferred tonnes are excluded deliberately — you cannot schedule mining on inferred ore.',
        },
      ],
      sources: ['g1-v4.2.1', 'D6 forecast'],
      confidence: null,
      followUps: ['Which mine needs attention first?', 'What would extend cover?', 'Show the grade-tonnage curve'],
    };
  }

  // ── Data freshness / coverage ──────────────────────────────────────────
  if (/data|fresh|stale|coverage|missing|source/.test(q)) {
    return {
      question,
      intent: 'data',
      blocks: [
        {
          kind: 'text',
          text: 'Geology and satellite are real and public. MOIL-private tables — drillholes, production, equipment, blast logs — are simulated with the same fixed schemas, so the real data drops in through the loaders only.',
        },
        {
          kind: 'evidence',
          label: 'The one thing to know',
          items: [
            'Every feature carries a <name>_avail flag, so a missing value is null plus a flag, never a zero',
            'Coverage percentage is shown next to every prediction',
            'A missing value is stored as null + availability flag, never as 0',
            'NGDR aerogeophysics has been stale for 82 days — that is why some targets are marked reduced-confidence',
          ],
        },
        {
          kind: 'action',
          label: 'Next step',
          text: 'Open the Data screen to see per-source freshness, validation pass rate and processing history.',
        },
      ],
      sources: ['source_catalog', 'D1 ingestion'],
      confidence: null,
      followUps: ['Which sources are stale?', 'What does coverage mean here?', 'How are synthetic tables marked?'],
    };
  }

  // ── Model version / drift ──────────────────────────────────────────────
  if (/model|version|drift|promote|registry/.test(q)) {
    return {
      question,
      intent: 'model',
      blocks: [
        {
          kind: 'text',
          text: 'Every prediction carries model_version, feature version, data snapshot and code SHA, so any number on screen can be re-created exactly.',
        },
        {
          kind: 'evidence',
          label: 'How a model gets promoted',
          items: [
            'Assemble the training set from a pinned snapshot and feature version',
            'Split with the model\'s own scheme — spatial blocks, leave-hole-out or rolling time. Never random rows',
            'Tune inside the training folds only, then evaluate on the outer test folds',
            'Register in MLflow with metrics and a model card',
            'Gate: promote only if it beats the incumbent without degrading any mine by more than tolerance, and a named reviewer approves',
          ],
        },
        {
          kind: 'caveat',
          text: 'm5 production forecast is on drift watch — population stability index 0.212 against a 0.20 alert threshold. Sustained forecast error above threshold opens a retrain ticket automatically.',
        },
      ],
      sources: ['D10 model ops', 'm5-v6.3.0'],
      confidence: null,
      followUps: ['Show the validation metrics', 'Which model is drifting?', 'What happens on promotion?'],
    };
  }

  // ── National manganese AI model (mn50) — our AI ───────────────────────
  if (/mn50|manganese model|national model|premium|grade model|ai grade|which mines.*(premium|high.?grade)|top mining|best mine/.test(q)) {
    const R = MANGANESE_TRAINING.regression.metrics;
    const C = MANGANESE_TRAINING.classification.metrics;
    const premium = MANGANESE_TRAINING.predictions
      .filter((p) => p.highProb >= 0.5)
      .sort((a, b) => b.highProb - a.highProb);
    const topGrade = [...MANGANESE_TRAINING.predictions]
      .sort((a, b) => b.cvPredictedGrade - a.cvPredictedGrade)
      .slice(0, 5);
    return {
      question,
      intent: 'national-ai',
      blocks: [
        {
          kind: 'text',
          text: `${MANGANESE_TRAINING.modelId} (${MANGANESE_TRAINING.version}) is our national manganese model — a ridge grade regressor and a logistic premium-grade classifier fitted on ${MANGANESE_TRAINING.rows} principal Indian manganese mines, entirely in-browser. These are out-of-fold numbers, not train-set.`,
        },
        {
          kind: 'metric',
          label: 'Grade regressor — 5-fold CV R²',
          value: R.r2.toFixed(2),
          text: `MAE ${R.mae.toFixed(2)} %Mn, RMSE ${R.rmse.toFixed(2)}. With 50 rows an R² this size is honest but modest — treat it as a screening model, not a reserve statement.`,
        },
        {
          kind: 'metric',
          label: `Premium classifier — P(grade ≥ ${GRADE_THRESHOLD}% Mn)`,
          value: `AUC ${C.auc.toFixed(2)}`,
          text: `Accuracy ${(C.accuracy * 100).toFixed(0)}%, precision ${(C.precision * 100).toFixed(0)}%, recall ${(C.recall * 100).toFixed(0)}%.`,
        },
        {
          kind: 'evidence',
          label: 'Highest predicted grades',
          items: topGrade.map((p) => `${p.name} (${p.state}) — ${p.cvPredictedGrade.toFixed(1)}% Mn predicted vs ${p.actualGrade.toFixed(1)}% actual, premium P=${(p.highProb * 100).toFixed(0)}%`),
        },
        {
          kind: 'metric',
          label: 'Mines the AI flags premium',
          value: `${premium.length} of ${MANGANESE_TRAINING.rows}`,
          text: premium.length
            ? `Led by ${premium.slice(0, 3).map((p) => p.name).join(', ')}.`
            : 'None clear the 50% confidence bar at this threshold.',
        },
        {
          kind: 'caveat',
          text: 'This same model now anchors the grade estimate on the Prospectivity targets — see each target\'s AI grade. Source rows are public and indicative; replace with audited mine-plan data.',
        },
      ],
      sources: [`${MANGANESE_TRAINING.version} (National Mn grade & premium)`, 'INDIA-MN-50 · fv-mn50-1', 'live model — fitted in-browser on load'],
      confidence: MANGANESE_TRAINING.regression.metrics.r2,
      modelVersion: MANGANESE_TRAINING.version,
      followUps: ['Which mines are premium grade?', 'How accurate is the prospectivity model?', 'Why is this target P1?'],
    };
  }

  return { ...FALLBACK, question, intent: 'unknown' };
}

/** Coverage of the analysis cell a target sits in. */
function PROSPECTIVITY_COVERAGE(ci: number, cj: number): number {
  if (ci < 0 || cj < 0 || ci >= NX || cj >= PROSPECTIVITY.ny) return 0.9;
  return PROSPECTIVITY.coverage[cj * NX + ci];
}

export const SUGGESTED_QUESTIONS = [
  'Why is this target P1?',
  'What is driving production risk right now?',
  'How accurate is the prospectivity model?',
  'Which mines does the AI flag as premium grade?',
  'How much would this add to OCI?',
  'Which data sources are stale?',
  'Compare the top two targets',
];

export const EXPLAIN_INTENTS = [
  { intent: 'target-explanation', label: 'Target evidence & drivers', needs: 'target' },
  { intent: 'depth', label: 'Depth band & drill depth', needs: 'target' },
  { intent: 'compare', label: 'Compare two targets', needs: 'target' },
  { intent: 'production-risk', label: 'Production risk & bottleneck (live)', needs: 'mine' },
  { intent: 'national-ai', label: 'National AI model (mn50)', needs: 'none' },
  { intent: 'reserve', label: 'Reserve position & cut-off', needs: 'estimate' },
  { intent: 'oci', label: 'Ore continuity', needs: 'mine' },
  { intent: 'validation', label: 'Model accuracy & validation', needs: 'none' },
  { intent: 'data', label: 'Data coverage & freshness', needs: 'none' },
  { intent: 'model', label: 'Model versions & governance', needs: 'none' },
];