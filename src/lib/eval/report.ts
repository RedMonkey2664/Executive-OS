// Pure markdown report builder for an eval run. No I/O — the runner writes the
// returned string to disk.
import type { GoldenScenario, JudgeVerdict } from "../ai/judge.server";
import type { InsightResult } from "../agents/runInsightPipeline";
import type { RunSummary } from "./persistence";

export interface ScenarioRun {
  scenario: GoldenScenario;
  agent: InsightResult;
  verdict: JudgeVerdict | null;
  judgeError?: string;
  pass: boolean;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function scoreCell(v: JudgeVerdict | null): string {
  if (!v) return "—";
  return `${v.factual_correctness}/${v.cites_right_drivers}/${v.actionability}/${v.hallucination}`;
}

export function buildMarkdownReport(runs: ScenarioRun[], summary: RunSummary): string {
  const lines: string[] = [];
  lines.push(`# Agent Eval Report — ${summary.runAt}`);
  lines.push("");
  lines.push(`**Pass rate:** ${pct(summary.passRate)} (${summary.passed}/${summary.total})`);
  lines.push(`**Agent model:** ${summary.agentModel} · **Judge model:** ${summary.judgeModel}`);
  lines.push(`**Notes:** ${summary.notes}`);
  lines.push("");
  lines.push("Scores are factual / drivers / actionability / hallucination (1-5). Pass = all ≥ 3 and no hallucinated numbers.");
  lines.push("");
  lines.push("| Scenario | Result | Tier (agent → golden) | Scores |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of runs) {
    const result = r.pass ? "✅ PASS" : "❌ FAIL";
    const tier = `${r.agent.riskLevel ?? "—"} → ${r.scenario.golden_risk_level ?? "—"}`;
    lines.push(`| ${r.scenario.scenario_id} | ${result} | ${tier} | ${scoreCell(r.verdict)} |`);
  }
  lines.push("");

  const failures = runs.filter((r) => !r.pass);
  if (failures.length) {
    lines.push("## Failures — full judge reasoning");
    lines.push("");
    for (const r of failures) {
      lines.push(`### ${r.scenario.scenario_id}`);
      lines.push("");
      lines.push(`- **Agent tier:** ${r.agent.riskLevel ?? "—"} · **Golden:** ${r.scenario.golden_risk_level ?? "—"}`);
      lines.push(`- **Agent initiative:** ${r.agent.initiative}`);
      lines.push(`- **Agent narrative:** ${r.agent.narrative}`);
      if (r.judgeError) {
        lines.push(`- **Judge error:** ${r.judgeError}`);
      } else if (r.verdict) {
        const v = r.verdict;
        lines.push(`- **Scores:** factual ${v.factual_correctness}, drivers ${v.cites_right_drivers}, actionability ${v.actionability}, hallucination ${v.hallucination}`);
        if (v.hallucinated_numbers.length) lines.push(`- **Hallucinated numbers:** ${v.hallucinated_numbers.join(", ")}`);
        lines.push(`- **Reasoning — factual:** ${v.reasoning.factual_correctness}`);
        lines.push(`- **Reasoning — drivers:** ${v.reasoning.cites_right_drivers}`);
        lines.push(`- **Reasoning — actionability:** ${v.reasoning.actionability}`);
        lines.push(`- **Reasoning — hallucination:** ${v.reasoning.hallucination}`);
        lines.push(`- **Overall:** ${v.overall}`);
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push("> Grow the golden seed: see [GOLDEN_SEED_GROWTH.md](./GOLDEN_SEED_GROWTH.md).");
  lines.push("");
  return lines.join("\n");
}
