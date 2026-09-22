import type { HumanRole, Question, Usage, Work } from "./model.js";
import { z } from "zod";

export interface User { id: string; roles: HumanRole[] }
export interface AgentView {
  id: string;
  name: string;
  role: string;
  provider: string;
  state: "idle" | "starting" | "working" | "waiting" | "blocked" | "stopped";
  workId?: string;
  session?: string;
  ready: boolean;
  busy: boolean;
  terminalController?: string;
  error?: string;
  lastActivity?: number;
  usage: Usage | null;
}
export const providerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), session: z.string().min(1) }),
  z.object({ type: z.literal("user"), id: z.string(), text: z.string() }),
  z.object({ type: z.literal("delta"), id: z.string(), text: z.string(), final: z.boolean().optional() }),
  z.object({ type: z.literal("message"), id: z.string(), text: z.string() }),
  z.object({ type: z.literal("busy") }),
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("progress"), description: z.string().optional() }),
  z.object({ type: z.literal("tool_start"), id: z.string(), description: z.string() }),
  z.object({ type: z.literal("tool_end"), id: z.string() }),
  z.object({ type: z.literal("error"), message: z.string(), recoverable: z.boolean().default(false) }),
  z.object({
    type: z.literal("usage"), id: z.string(),
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    nanoAiu: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
]);
export type ProviderEvent = z.infer<typeof providerEventSchema>;
export type LiveEvent =
  | { type: "terminal"; agent: string; data: string; sequence: number }
  | { type: "provider"; agent: string; event: ProviderEvent }
  | { type: "state" }
  | { type: "error"; message: string };
export interface Snapshot {
  instance: string;
  project: string;
  mode: "running" | "paused" | "draining" | "stopped";
  agents: AgentView[];
  work: Work[];
  rankingRevision: string;
  checkpoints: { id: string; description: string; humanRole?: HumanRole }[];
  questions: (Question & { workId: string; title: string })[];
  metrics: {
    cpuCount: number; loadAverage: number[]; memoryTotal: number; memoryFree: number;
    completed: number; waiting: number; retries: number; humanWaitMs: number; reviewRework: number;
    cycleTimeMs: number | null;
    attentionByRole: Record<HumanRole, number>;
    usage: Usage | null;
  };
  error?: string;
}
