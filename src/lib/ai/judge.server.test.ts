import { describe, it, expect } from "vitest";
import { JudgeVerdictSchema, isPass, type JudgeVerdict } from "./judge.server";

const base: JudgeVerdict = {
  factual_correctness: 5,
  cites_right_drivers: 5,
  actionability: 5,
  hallucination: 5,
  hallucinated_numbers: [],
  reasoning: {
    factual_correctness: "ok",
    cites_right_drivers: "ok",
    actionability: "ok",
    hallucination: "none",
  },
  overall: "strong",
};

describe("JudgeVerdictSchema", () => {
  it("accepts a well-formed verdict", () => {
    expect(JudgeVerdictSchema.safeParse(base).success).toBe(true);
  });
  it("rejects scores out of the 1-5 range", () => {
    expect(JudgeVerdictSchema.safeParse({ ...base, actionability: 7 }).success).toBe(false);
  });
  it("rejects a missing dimension", () => {
    const { hallucination, ...partial } = base;
    expect(JudgeVerdictSchema.safeParse(partial).success).toBe(false);
  });
});

describe("isPass", () => {
  it("passes when all dimensions ≥ 3 and no hallucinated numbers", () => {
    expect(isPass({ ...base, factual_correctness: 3 })).toBe(true);
  });
  it("fails when any dimension < 3", () => {
    expect(isPass({ ...base, actionability: 2 })).toBe(false);
  });
  it("fails when hallucinated numbers are present, even with high scores", () => {
    expect(isPass({ ...base, hallucinated_numbers: ["$2.3M"] })).toBe(false);
  });
});
