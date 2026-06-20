import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Upload, MessageSquareText, Users, Crown, Brain, ArrowRight, Signal,
  GitBranch, Activity, ListChecks, FileBarChart, ScrollText, Briefcase, SlidersHorizontal,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/guide")({
  head: () => ({
    meta: [
      { title: "Guide, ExecutiveOS" },
      { name: "description", content: "How to use your AI executive team, and a walkthrough of every section of ExecutiveOS." },
    ],
  }),
  component: GuidePage,
});

const STEPS = [
  { n: "1", title: "Upload your data", icon: Upload, body: "Drop a CSV or Excel file on the Dashboard. ExecutiveOS infers the schema, identifies metrics and dimensions, and assembles your first brief automatically. Manage and switch datasets any time from the panel at the bottom left." },
  { n: "2", title: "Read the brief", icon: Crown, body: "The Dashboard opens with your Executive Brief: a plain-language summary, the key numbers, and a single recommended action. Everything else expands on demand, so you are never overwhelmed." },
  { n: "3", title: "Ask the team", icon: MessageSquareText, body: "Use AI Chat to talk to any agent directly, or open the AI Boardroom to have your full C-suite debate a strategic question and land a single board decision grounded in your numbers." },
  { n: "4", title: "Decide and execute", icon: ListChecks, body: "Decisions Requiring Attention surfaces what needs your call. Send a decision to the Boardroom to deliberate, then to the Execution Center to plan and track it." },
];

const SECTIONS = [
  { title: "Dashboard, Strategic Signals", icon: Signal, body: "The conclusions worth your attention: best-performing segments, top opportunity, top risk, and the recommended action. Expand for KPIs, trend, forecast, schema and anomalies." },
  { title: "Dashboard, Decisions Requiring Attention", icon: GitBranch, body: "Risks and anomalies escalated into clear decisions, each with a route to deliberate in the Boardroom or plan in the Execution Center." },
  { title: "Dashboard, Executive Team Activity", icon: Activity, body: "Your AI C-suite and what each officer is working on right now, with status, current task, confidence and recent output." },
  { title: "AI Chat", icon: MessageSquareText, body: "A direct line to any agent on your executive team for ad-hoc questions." },
  { title: "CEO Brief", icon: ScrollText, body: "A one-page executive view from your Chief Strategy Officer: health, risks, opportunities and priority moves." },
  { title: "Consultant Report", icon: Briefcase, body: "Professional consulting analysis and recommendations on demand." },
  { title: "AI Boardroom", icon: Users, body: "Your virtual leadership team debates a question and produces a board decision, consensus score and next actions." },
  { title: "Mission Control", icon: SlidersHorizontal, body: "Workflow orchestration and execution pipelines for running initiatives end to end." },
  { title: "Execution Center", icon: ListChecks, body: "Track initiatives, tasks and execution progress." },
  { title: "Executive Memory", icon: Brain, body: "The knowledge graph, history and institutional context the board reasons against." },
  { title: "Reports", icon: FileBarChart, body: "Generated executive deliverables in PDF, deck and spreadsheet." },
];

// Relocated from the AI Boardroom (Executive Debate Flow).
const DEBATE_FLOW = [
  { id: "Question", label: "Question", note: "You pose a strategic question." },
  { id: "CEO", label: "CEO", note: "Frames strategy and the narrative." },
  { id: "CFO", label: "CFO", note: "Tests the financial case." },
  { id: "CMO", label: "CMO", note: "Weighs market and demand." },
  { id: "COO", label: "COO", note: "Checks operational feasibility." },
  { id: "CRO", label: "CRO", note: "Surfaces risk and downside." },
  { id: "Consensus", label: "Consensus", note: "Positions converge into a score." },
  { id: "Decision", label: "Decision", note: "A single board decision is recorded." },
];

function GuidePage() {
  return (
    <>
      <PageHeader
        eyebrow="Guide"
        title="Getting started"
        description="How to use your AI executive team, and a walkthrough of every section of ExecutiveOS."
      />

      {/* How to use the AI agent */}
      <section className="mb-16">
        <h2 className="font-display text-3xl tracking-tight mb-8">How to use your AI executive team</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {STEPS.map((s) => (
            <div key={s.n} className="executive-card rounded-3xl p-8 flex gap-5">
              <div className="grid place-items-center h-12 w-12 shrink-0 rounded-2xl bg-[var(--color-rose)]/12 text-[var(--color-rose)]">
                <s.icon className="h-6 w-6" />
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.24em] text-secondary">Step {s.n}</p>
                <h3 className="font-display text-2xl mt-1">{s.title}</h3>
                <p className="text-[15px] text-muted-foreground mt-3 leading-relaxed">{s.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Executive Debate Flow (relocated from the Boardroom) */}
      <section className="mb-16">
        <h2 className="font-display text-3xl tracking-tight mb-2">Executive Debate Flow</h2>
        <p className="text-[15px] text-muted-foreground mb-8 max-w-2xl leading-relaxed">
          When you run a Boardroom debate, your question flows through every executive officer before converging into one decision. Here is what happens at each stage.
        </p>
        <div className="executive-card-elevated rounded-3xl p-8">
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            {DEBATE_FLOW.map((stage, i) => (
              <div key={stage.id} className="relative">
                <div className="surface-inset rounded-2xl p-4 h-full">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    {i === 0 ? "Input" : i === DEBATE_FLOW.length - 1 ? "Output" : `Stage ${i}`}
                  </p>
                  <p className="font-display text-lg mt-1 leading-tight">{stage.label}</p>
                  <p className="text-[12px] text-muted-foreground mt-1.5 leading-snug">{stage.note}</p>
                </div>
                {i < DEBATE_FLOW.length - 1 && (
                  <ArrowRight className="hidden lg:block absolute top-1/2 -right-2.5 -translate-y-1/2 h-4 w-4 text-muted-foreground/40 z-10" />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Section walkthrough */}
      <section>
        <h2 className="font-display text-3xl tracking-tight mb-8">Every section, explained</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {SECTIONS.map((s) => (
            <div key={s.title} className="executive-card rounded-3xl p-7">
              <div className="grid place-items-center h-10 w-10 rounded-xl bg-foreground/5 text-foreground/70">
                <s.icon className="h-5 w-5" />
              </div>
              <h3 className="font-display text-xl mt-4 leading-tight">{s.title}</h3>
              <p className="text-sm text-muted-foreground mt-2.5 leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="mt-16 flex items-center gap-5">
        <Link to="/" className="inline-flex items-center gap-2 text-sm font-medium text-foreground border-b border-foreground/25 pb-0.5 hover:border-foreground transition-colors">
          Go to the Dashboard <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </>
  );
}
