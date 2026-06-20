import { describe, it, expect } from "vitest";
import { buildMarkdownReport, type ScenarioRun } from "./report";
import type { RunSummary } from "./persistence";

const passingRun: ScenarioRun = {
  scenario: {
    scenario_id: "S01", region: "Europe", category: "Electronics",
    revenue: 1240000, profit_margin: 4.2, customer_concentration_pct: 58, churn_pct: 9.5,
    golden_risk_level: "High", golden_initiative: "Margin Defense Program",
    golden_insight_summary: "…", rubric_criteria: "…",
  },
  agent: {
    riskLevel: "High", initiative: "Margin Defense Program", narrative: "…",
    insufficientData: false, missingFields: [], tierSource: "rule", narratedBy: "gemini",
  },
  verdict: {
    factual_correctness: 5, cites_right_drivers: 5, actionability: 4, hallucination: 5,
    hallucinated_numbers: [], reasoning: { factual_correctness: "a", cites_right_drivers: "b", actionability: "c", hallucination: "d" },
    overall: "good",
  },
  pass: true,
};

const failingRun: ScenarioRun = {
  ...passingRun,
  scenario: { ...passingRun.scenario, scenario_id: "S03" },
  verdict: { ...passingRun.verdict!, actionability: 2, overall: "weak initiative" },
  pass: false,
};

const summary: RunSummary = {
  runAt: "2026-06-20T00:00:00.000Z", agentModel: "gemini-2.5-flash", judgeModel: "gemini-2.5-pro",
  total: 2, passed: 1, passRate: 0.5, reportPath: "docs/eval/agent-eval-x.md",
  failures: [{ scenario_id: "S03", verdict: failingRun.verdict, judgeError: undefined }],
  notes: "source=xlsx",
};

describe("buildMarkdownReport", () => {
  const md = buildMarkdownReport([passingRun, failingRun], summary);
  it("shows the pass rate", () => {
    expect(md).toContain("50%");
    expect(md).toContain("1/2");
  });
  it("includes a row per scenario", () => {
    expect(md).toContain("S01");
    expect(md).toContain("S03");
  });
  it("includes full judge reasoning for failures only", () => {
    expect(md).toContain("weak initiative");
  });
  it("links the growth checklist", () => {
    expect(md).toContain("GOLDEN_SEED_GROWTH.md");
  });
});
