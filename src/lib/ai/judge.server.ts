// Independent LLM-as-judge for the insight agent's free-text quality. Uses a
// DISTINCT Gemini model from the agent (gemini-2.5-pro) at temperature 0, and
// requires structured JSON back. The judge receives the original input metrics
// so it can flag any number the agent invented that is not in the input.
import { z } from "zod";
import { executeGeminiPrompt } from "./gemini.server";

export interface GoldenScenario {
  scenario_id: string;
  region: string | null;
  category: string | null;
  revenue: number | null;
  profit_margin: number | null;
  customer_concentration_pct: number | null;
  churn_pct: number | null;
  golden_risk_level: string | null;
  golden_initiative: string | null;
  golden_insight_summary: string | null;
  rubric_criteria: string | null;
}

export interface AgentOutput {
  riskLevel: string | null;
  initiative: string;
  narrative: string;
}

export const JudgeVerdictSchema = z.object({
  factual_correctness: z.number().int().min(1).max(5),
  cites_right_drivers: z.number().int().min(1).max(5),
  actionability: z.number().int().min(1).max(5),
  hallucination: z.number().int().min(1).max(5), // 5 = no hallucination
  hallucinated_numbers: z.array(z.string()),
  reasoning: z.object({
    factual_correctness: z.string(),
    cites_right_drivers: z.string(),
    actionability: z.string(),
    hallucination: z.string(),
  }),
  overall: z.string(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

// Pass = every rubric dimension ≥ 3 AND zero hallucinated numbers.
export function isPass(v: JudgeVerdict): boolean {
  return (
    v.factual_correctness >= 3 &&
    v.cites_right_drivers >= 3 &&
    v.actionability >= 3 &&
    v.hallucination >= 3 &&
    v.hallucinated_numbers.length === 0
  );
}

export type Judge = (
  scenario: GoldenScenario,
  output: AgentOutput,
) => Promise<JudgeVerdict>;

export const JUDGE_MODEL = "gemini-2.5-pro";

function buildJudgePrompt(s: GoldenScenario, o: AgentOutput) {
  const system = [
    "You are a strict, impartial evaluator of an executive-AI agent's output.",
    "You did NOT write the agent's answer. Grade it against the golden reference and rubric.",
    "Score each dimension 1-5 (integers only):",
    "- factual_correctness: is the assessment correct vs the golden answer?",
    "- cites_right_drivers: does it cite the drivers the rubric requires?",
    "- actionability: is the recommended initiative appropriate and specific?",
    "- hallucination: 5 if it invents NO number absent from the input; lower the more it invents.",
    "List every invented number (not present in INPUT METRICS) in hallucinated_numbers (empty array if none).",
    "If the golden answer is 'Insufficient data', the correct agent behavior is to flag missing fields and refuse;",
    "score an invented tier or invented numbers as failing.",
    "Return ONLY this JSON object:",
    '{ "factual_correctness": int, "cites_right_drivers": int, "actionability": int, "hallucination": int, "hallucinated_numbers": string[], "reasoning": { "factual_correctness": string, "cites_right_drivers": string, "actionability": string, "hallucination": string }, "overall": string }',
  ].join("\n");

  const user = [
    "INPUT METRICS (the ONLY numbers that legitimately exist):",
    JSON.stringify({
      region: s.region,
      category: s.category,
      revenue: s.revenue,
      profit_margin: s.profit_margin,
      customer_concentration_pct: s.customer_concentration_pct,
      churn_pct: s.churn_pct,
    }),
    "",
    "GOLDEN REFERENCE:",
    JSON.stringify({
      golden_risk_level: s.golden_risk_level,
      golden_initiative: s.golden_initiative,
      golden_insight_summary: s.golden_insight_summary,
    }),
    "",
    `RUBRIC CRITERIA: ${s.rubric_criteria ?? "(none)"}`,
    "",
    "AGENT OUTPUT TO GRADE:",
    JSON.stringify({
      riskLevel: o.riskLevel,
      initiative: o.initiative,
      narrative: o.narrative,
    }),
    "",
    "Grade it now. Return only the JSON verdict.",
  ].join("\n");

  return { system, user };
}

export const geminiJudge: Judge = async (scenario, output) => {
  const { system, user } = buildJudgePrompt(scenario, output);
  const res = await executeGeminiPrompt({ system, user, model: JUDGE_MODEL });
  return JudgeVerdictSchema.parse(res.parsed);
};
