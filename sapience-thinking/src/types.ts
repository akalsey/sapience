import { Type, type Static } from "@sinclair/typebox";

const PrioritySchema = Type.Union([
  Type.Literal(1), Type.Literal(2), Type.Literal(3), Type.Literal(4), Type.Literal(5),
]);

export const ObservationSchema = Type.Object({
  id: Type.String(),
  text: Type.String(),
  evidence: Type.String(),
  priority: PrioritySchema,
  // How solid the evidence is: an unverified pattern-suspicion is a "hunch"
  // and gets gated (and possibly investigated) downstream.
  evidence_grade: Type.Optional(Type.Union([
    Type.Literal("hunch"), Type.Literal("quick_check"), Type.Literal("replicated"),
  ])),
});

export const ProposedActionSchema = Type.Object({
  id: Type.String(),
  text: Type.String(),
  rationale: Type.String(),
  estimated_effort: Type.Union([Type.Literal("small"), Type.Literal("medium"), Type.Literal("large")]),
  priority: PrioritySchema,
});

export const ProposedAuditSchema = Type.Object({
  id: Type.String(),
  domain: Type.String(),
  rationale: Type.String(),
  priority: PrioritySchema,
});

export const OpenQuestionSchema = Type.Object({
  id: Type.String(),
  text: Type.String(),
  blocking_what: Type.String(),
});

export const ProposalSetSchema = Type.Object({
  pass_id: Type.String(),
  timestamp: Type.String(),
  observations: Type.Array(ObservationSchema),
  proposed_actions: Type.Array(ProposedActionSchema),
  proposed_audits: Type.Array(ProposedAuditSchema),
  open_questions: Type.Array(OpenQuestionSchema),
  nothing_to_report: Type.Boolean(),
  summary: Type.String(),
});

export type Observation = Static<typeof ObservationSchema>;
export type ProposedAction = Static<typeof ProposedActionSchema>;
export type ProposedAudit = Static<typeof ProposedAuditSchema>;
export type OpenQuestion = Static<typeof OpenQuestionSchema>;
export type ProposalSet = Static<typeof ProposalSetSchema>;

export type OutcomeState = "pending" | "acted_on" | "accepted" | "rejected" | "acknowledged" | "expired";
export type ProposalType = "observation" | "action" | "audit" | "question";

export interface OutcomeRecord {
  proposal_id: string;
  proposal_type: ProposalType;
  pass_id: string;
  created_at: string;
  resolved_at?: string;
  state: OutcomeState;
  // Proposal text, kept for cross-pass dedup. Absent on pre-upgrade records.
  text?: string;
}

export type OutcomeMap = Record<string, OutcomeRecord>;

export interface SignalReport {
  observations: { reviewed: number; acted_on: number; total: number };
  actions: { acted_on: number; rejected: number; total: number };
  audits: { accepted: number; total: number };
  questions: { answered: number; total: number };
  computed_at: string;
}

export interface ContextBundle {
  recentActivity: string;
  recentPasses: string;
  // Summary of active/decomposing goals from the sapience-goals workspace file,
  // so passes reason against what the user is trying to achieve. Empty when
  // there are no goals (or the goals plugin isn't in use).
  activeGoals?: string;
  // Open cases from the hypothesis ledger, for opportunistic re-testing.
  openHypotheses?: string;
  tokenEstimate: number;
}

export interface PluginConfig {
  schedule: string;
  activeHours: { start: string; end: string; timezone: string };
  context: { lookbackHours: number; maxContextTokens: number };
  output: { logPath: string; proposalsPath: string; trackerPath: string; eventsPath: string };
  delivery: { heartbeatTrigger: boolean; priorityThreshold: number; maxProposalsPerHeartbeat: number };
  learning: { trackOutcomes: boolean; adjustPromptBasedOnSignal: boolean; bootstrapDays: number };
}

export const DEFAULT_CONFIG: PluginConfig = {
  schedule: "*/15 * * * *",
  activeHours: { start: "08:00", end: "20:00", timezone: "America/Los_Angeles" },
  context: { lookbackHours: 2, maxContextTokens: 8000 },
  output: {
    logPath: "proactive-thinking/log.md",
    // Must match the sapience router's proactiveThinking.proposalsPath default.
    proposalsPath: "proactive-thinking/proposals.jsonl",
    trackerPath: "proactive-thinking/outcomes.json",
    eventsPath: "sapience/events.jsonl",
  },
  delivery: { heartbeatTrigger: true, priorityThreshold: 4, maxProposalsPerHeartbeat: 3 },
  learning: { trackOutcomes: true, adjustPromptBasedOnSignal: true, bootstrapDays: 14 },
};
