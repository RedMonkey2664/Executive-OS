# Design: LLM Eval Harness for Insight/Recommendation Quality

**Date:** 2026-06-20
**Source prompt:** `ExecutiveOS_Accuracy_Pipeline_BuildPlan.md` — Prompt 4
**Status:** Approved (design), pending spec review

## Goal

Build a repeatable regression test for the **quality** of the agent's free-text
output (insight narrative + recommended initiative) — the part that can't be
graded by exact match. Runnable as a single command (`npm run eval:agent`) so it
can be re-run after every meaningful prompt or model change. Treat it like a test
suite, not a one-off.

## Context & key findings

- `eval_golden_seed` holds **5 hand-written scenarios** (`data/seed/ExecutiveOS_LLM_Eval_Golden_Seed.xlsx`,
  also intended to live in the database). Each row has: `Region`, `Category`,
  `Revenue`, `Profit_Margin`, `Customer_Concentration_pct`, `Churn_pct`,
  `Golden_Risk_Level`, `Golden_Initiative`, `Golden_Insight_Summary`,
  `Rubric_Criteria`.
- The golden seed carries **only 4 numeric input fields** (Revenue, Profit_Margin,
  Customer_Concentration_pct, Churn_pct) — far fewer than the **9 features** the
  trained ONNX risk classifier (`src/lib/ml/predict-risk.server.ts`) requires.
- The 4 golden tiers (S01–S04) follow the **documented threshold rule** on
  `profit_margin` + `customer_concentration_pct` exactly. **S05** has every
  numeric field null — correct behavior is to flag the missing fields and refuse
  to assign a tier (HARD FAIL if the agent invents numbers or silently defaults).
- No existing function emits **tier + recommended initiative + narrative**
  together. `assessRiskLevel` (`src/lib/agents/executeRisk.functions.ts`) emits
  tier + narrative only; the CEO/boardroom agents emit insight/recommendation but
  consume assembled context payloads, not raw metrics.
- Existing one-off scripts run via `npx tsx` (e.g. `data/seed/seed.ts`,
  `ml/parity_check.ts`), load `.env` manually, and import `.server.ts` modules
  directly. The eval runner follows the same conventions.

## Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Judge model | **Gemini, distinct model** (`gemini-2.5-pro`, temp 0) | Zero new deps/keys; distinct model + temp 0 mitigates self-preference bias. Swappable for Claude later behind one function. |
| Data layer | **Direct Postgres (`pg`) to Aurora** via `DATABASE_URL` | Per explicit user choice. Departs from the repo's Supabase layer for this harness. |
| Agent under test | **New composed pipeline module** | No existing function emits tier+initiative+narrative; build a reusable deterministic-first module. |
| Golden tier source | **Threshold rule, not ONNX** | Golden seed lacks the 9 ONNX features; the rule is the ground truth and reproduces all 4 golden tiers. ONNX stays the tool for the held-out numeric-accuracy eval (Prompts 2/3). |

## Architecture

Three new units, each independently testable, plus supporting changes.

### Unit A — Agent under test: `src/lib/agents/runInsightPipeline.ts`

A reusable, server-safe async function — the "real end-to-end agent," callable by
both the eval and (later) the product. Plain async function, **not** a
`createServerFn`, so the eval can call it directly without the RPC layer. Mirrors
the existing deterministic-first pattern (rule/model decides *what*, Gemini
explains *why*).

**Input** (mirrors the golden-seed shape; all fields optional to support the
missing-data case):

```ts
interface InsightMetrics {
  region?: string | null;
  category?: string | null;
  revenue?: number | null;
  profit_margin?: number | null;
  customer_concentration_pct?: number | null;
  churn_pct?: number | null;
}
```

**Steps:**

1. **Missing-data gate.** Core fields for a tier decision = `profit_margin` AND
   `customer_concentration_pct`. If either is null/undefined/NaN →
   `insufficientData: true`, `riskLevel: null`, `initiative: "N/A — request missing fields"`,
   and a narrative that explicitly names the missing fields and refuses to guess.
   (This is S05.) No Gemini call in this branch.
2. **Deterministic tier (rule).** Implements the documented threshold rule
   verbatim:
   - `concentration > 70` → Critical
   - `60 < concentration <= 70` → High
   - `concentration <= 60 && margin <= 0` → Critical
   - `concentration <= 60 && 0 < margin <= 5` → High
   - otherwise → Low

   `tierSource: "rule"`.
3. **Initiative + narrative (Gemini, `gemini-2.5-flash`, JSON mode).** Given the
   locked tier + available metrics, returns `{ initiative, narrative }`. Strict
   prompt rules: ground only in provided numbers; never invent a number; never
   contradict or re-argue the tier; pick an initiative appropriate to the tier
   and dominant driver (margin-driven → margin program; concentration-driven →
   diversification; Low → growth/expansion). Honest **templated fallback**
   (initiative + narrative) if Gemini is unavailable, clearly labeled, so the
   eval always runs.

**Output:**

```ts
interface InsightResult {
  riskLevel: "Critical" | "High" | "Low" | null;
  initiative: string;
  narrative: string;
  insufficientData: boolean;
  missingFields: string[];
  tierSource: "rule" | "none";
  narratedBy: "gemini" | "fallback" | "none";
}
```

**Depends on:** `src/lib/ai/gemini.server.ts` (`executeGeminiPrompt`). Uses
relative imports (not the `@/` alias) so `tsx` resolves it without path-alias
config, matching `parity_check.ts`.

### Unit B — Judge: `src/lib/ai/judge.server.ts`

`judgeInsight(scenario, agentOutput) => JudgeVerdict`. An **independent** Gemini
call on a distinct model (`gemini-2.5-pro`, temp 0), JSON mode, zod-validated.

**Receives:** the agent's output (tier, initiative, narrative) + all `Golden_*`
fields + `Rubric_Criteria` + the **original input metrics** (so it can detect
numbers the agent invented that aren't in the input).

**Returns:** 1–5 scores for four dimensions — `factual_correctness`,
`cites_right_drivers`, `actionability`, `hallucination` (5 = no hallucination) —
plus `hallucinated_numbers: string[]`, per-dimension `reasoning`, and an overall
summary. Validated with a zod schema; malformed judge output is a runner error
(surfaced, not silently passed).

**Pass rule (per scenario):** every dimension ≥ 3 **AND** `hallucinated_numbers`
is empty. (= "no rubric dimension below 3, zero hallucination flags".)

The same judge prompt handles S05: `Rubric_Criteria` tells the judge that the
correct behavior is to flag missing data, so a proper refusal scores as a pass
and an invented tier scores as a fail.

### Unit C — Runner: `scripts/eval-agent.ts` (→ `npm run eval:agent`)

1. Load `.env` (reuse the dotenv-loader pattern from `seed.ts`). Connect to
   **Aurora** via a `pg` `Pool` using `DATABASE_URL`.
2. **Read scenarios:** `SELECT * FROM eval_golden_seed`. On connection error or
   empty result → **fall back to reading the xlsx** in `data/seed/`, logged
   loudly. Normalize both shapes to a common `GoldenScenario` type.
3. For each scenario: `runInsightPipeline(metrics)` → `judgeInsight(...)` →
   compute pass/fail. Collect a per-scenario record (input, agent output, judge
   verdict, pass/fail).
4. **Summary:** % passed; for every failure, the full judge reasoning.
5. **Markdown report:** write to `docs/eval/agent-eval-<ISO>.md` and overwrite a
   stable `docs/eval/agent-eval-latest.md`. Includes the growth checklist
   pointer.
6. **DB writeback:** `CREATE TABLE IF NOT EXISTS eval_runs` (idempotent, so it
   works on Aurora without a migration tool), then INSERT one summary row. If
   Aurora is unreachable, warn and append to a local `docs/eval/agent_eval_runs.jsonl`
   so results are never lost.
7. **Exit code:** non-zero if `pass_rate < EVAL_MIN_PASS_RATE` (default `1.0` —
   all scenarios must pass). Treat it like a test suite for CI.

### Supporting changes

- **`supabase/migrations/<ts>_eval_runs.sql`** — portable Postgres DDL for the
  `eval_runs` table (kept alongside `model_eval_runs.sql` for the record; also
  self-ensured by the runner). Columns: `id`, `run_at`, `agent_model`,
  `judge_model`, `total`, `passed`, `pass_rate`, `report_path`, `failures`
  (jsonb), `notes`.
- **`package.json`** — add script `"eval:agent": "tsx scripts/eval-agent.ts"`;
  add `pg`, `@types/pg`, and `tsx` to `devDependencies`.
- **`.env.example`** — add `DATABASE_URL` (Aurora) and document the optional
  `EVAL_MIN_PASS_RATE` knob.
- **`docs/eval/GOLDEN_SEED_GROWTH.md`** — the checklist to grow `eval_golden_seed`
  to 50–100 scenarios: every risk tier (Critical/High/Low), every initiative
  type, 3+ missing-data/malformed-input cases, 3+ adversarial cases (numbers fine
  alone but dangerous in combination, like S03/S04). Linked from each report.

## Data flow

```
eval_golden_seed (Aurora)  ──read──►  runner
        │ (fallback)                    │
   data/seed/*.xlsx                     ▼
                            runInsightPipeline(metrics)
                              ├─ missing-data gate (S05 → refuse)
                              ├─ threshold rule → tier
                              └─ Gemini 2.5-flash → initiative + narrative
                                         │
                                         ▼
                            judgeInsight (Gemini 2.5-pro, temp 0)
                                         │
                                         ▼
                            pass/fail + reasoning
                              ├─► docs/eval/agent-eval-<ISO>.md (+ latest)
                              ├─► eval_runs row (Aurora; JSONL fallback)
                              └─► process exit code
```

## Error handling

- **Gemini down (agent):** templated fallback initiative + narrative, labeled;
  eval still runs (judge will likely score lower — honest).
- **Gemini down (judge):** runner error for that scenario, surfaced in the report
  and counted as a fail; non-zero exit. The judge is the measuring instrument —
  we don't fake a verdict.
- **Aurora unreachable (read):** fall back to xlsx, logged.
- **Aurora unreachable (write):** warn + append to local JSONL.
- **Malformed judge JSON:** zod validation error, surfaced; scenario counts as a
  fail.

## Testing

- **Unit (`runInsightPipeline`):** rule branches (S01–S04 expected tiers), the
  missing-data gate (S05 → `insufficientData`, no tier, no invented numbers), and
  the Gemini-down fallback path (no network). These are deterministic and need no
  API key.
- **Smoke (runner):** `npm run eval:agent` against the xlsx fallback with a
  `GEMINI_API_KEY` present — confirms the full path produces a report, a pass
  rate, and (if `DATABASE_URL` set) an `eval_runs` row.

## Out of scope (separate sub-projects)

- **Prompt 5 — Accuracy dashboard.** A TanStack Start route visualizing
  `model_eval_runs` + `eval_runs` over time. Its own spec/plan. Note for that
  work: `eval_runs` now lives in **Aurora** while `model_eval_runs` may still be
  in Supabase — the dashboard's data sources must be reconciled then.
- Growing the golden seed beyond 5 scenarios (tracked in
  `docs/eval/GOLDEN_SEED_GROWTH.md`).
- Wiring `runInsightPipeline` into a product route.
