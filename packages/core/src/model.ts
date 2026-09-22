import { z } from "zod";

export const humanRoles = ["product", "ux", "ui", "architect", "developer", "qa"] as const;
export const agentRoles = ["planner", "implementer", "reviewer", "ux", "release"] as const;
export const phases = [
  "backlog", "ready", "working", "waiting", "review", "changes_requested",
  "verified", "merged", "deploying", "deployed", "blocked", "cancelled", "done", "decomposed",
] as const;
export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
export const textSchema = z.string().trim().min(1).max(50_000);
export const pathScopeSchema = z.string().min(1).max(500).refine((path) =>
  path === "*" || (!path.startsWith("/") && !/[\\*?[\]]/.test(path)
    && path.split("/").every((part, index, all) => (part !== "" || index === all.length - 1) && part !== "." && part !== "..")),
{ message: "Use repository-relative file/directory prefixes, or '*' for the whole repository; glob patterns are not supported." });
export const roleSchema = z.enum(humanRoles);
export const phaseSchema = z.enum(phases);
export type HumanRole = z.infer<typeof roleSchema>;
export type Phase = z.infer<typeof phaseSchema>;
export type AgentRole = typeof agentRoles[number];

export const ownerSchema = z.object({
  instance: idSchema,
  agent: idSchema,
  token: z.string().uuid(),
});
export type Owner = z.infer<typeof ownerSchema>;
export const ownerKey = (owner: Owner): string =>
  `cerebra/${owner.instance}/${owner.agent}/${owner.token}`;
export function parseOwner(value?: string): Owner | undefined {
  if (!value?.startsWith("cerebra/")) return undefined;
  const [, instance, agent, token] = value.split("/");
  const parsed = ownerSchema.safeParse({ instance, agent, token });
  if (!parsed.success || value.split("/").length !== 4) {
    throw new DomainError("corrupt_owner", "A Cerebra work assignment has an invalid owner token.", 500);
  }
  return parsed.data;
}

export const questionSchema = z.object({
  id: z.string().uuid(),
  role: roleSchema,
  text: textSchema,
  askedAt: z.string().datetime(),
  answer: textSchema.optional(),
  answeredBy: idSchema.optional(),
  answeredAt: z.string().datetime().optional(),
});
export type Question = z.infer<typeof questionSchema>;
export const evidenceSchema = z.object({
  head: z.string().regex(/^[a-f0-9]{40}$/),
  authorSession: z.string().uuid(),
  reviewerSession: z.string().uuid(),
  result: z.enum(["approved", "changes_requested"]),
  summary: textSchema,
  githubUrl: z.url(),
  humanApproved: z.boolean().default(false),
});
export type ReviewEvidence = z.infer<typeof evidenceSchema>;
export const usageSchema = z.object({
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative().nullable(),
  outputTokens: z.number().nonnegative().nullable(),
  nanoAiu: z.number().nonnegative().nullable(),
  unpricedRequests: z.number().int().nonnegative(),
});
export type Usage = z.infer<typeof usageSchema>;
export const workDataSchema = z.object({
  version: z.literal(1).default(1),
  kind: z.enum(["delivery", "conversation", "review", "epic"]).default("delivery"),
  parent: idSchema.optional(),
  children: z.array(idSchema).default([]),
  subtaskOrder: z.number().int().nonnegative().default(0),
  affinity: z.object({ instance: idSchema, agent: idSchema }).optional(),
  phase: phaseSchema.default("backlog"),
  role: z.enum(agentRoles).default("implementer"),
  rank: z.number().int().nonnegative().nullable().default(null),
  paths: z.array(pathScopeSchema).default([]),
  dependencies: z.array(idSchema).default([]),
  checkpoint: z.string().max(50_000).default(""),
  questions: z.array(questionSchema).default([]),
  decisions: z.array(z.object({
    by: z.string(), text: textSchema, at: z.string().datetime(),
  })).default([]),
  session: z.string().uuid().optional(),
  authorSession: z.string().uuid().optional(),
  branch: z.string().optional(),
  pr: z.number().int().positive().optional(),
  head: z.string().optional(),
  review: evidenceSchema.optional(),
  gates: z.record(z.string(), z.object({
    head: z.string().regex(/^[a-f0-9]{40}$/),
    by: z.string(),
    human: z.boolean(),
    passed: z.boolean(),
    evidence: textSchema,
    at: z.string().datetime(),
  })).default({}),
  reviewOf: idSchema.optional(),
  attempts: z.number().int().nonnegative().default(0),
  recoveries: z.number().int().nonnegative().default(0),
  reviewRework: z.number().int().nonnegative().default(0),
  waitMs: z.number().nonnegative().default(0),
  waitStartedAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  progressAt: z.string().datetime().optional(),
  usage: usageSchema.optional(),
  error: z.string().optional(),
  source: z.string().optional(),
  deployment: z.object({
    requestedBy: idSchema,
    requestId: z.string().uuid(),
    ref: z.string(),
    state: z.enum(["requested", "dispatching", "running", "succeeded", "failed", "uncertain"]),
    workflow: z.string(),
    runId: z.number().optional(),
    url: z.string().optional(),
  }).optional(),
});
export type WorkData = z.infer<typeof workDataSchema>;
export interface Work {
  id: string;
  title: string;
  description: string;
  acceptance: string;
  assignee?: string;
  owner?: Owner;
  data: WorkData;
}
export interface CreateWork {
  title: string;
  description: string;
  acceptance: string;
  data?: Partial<WorkData>;
}
export const createWorkSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(50_000).default(""),
  acceptance: z.string().max(50_000).default(""),
  data: workDataSchema.pick({ role: true, paths: true, dependencies: true }).partial().optional(),
});
export interface WorkStore {
  list(): Promise<Work[]>;
  get(id: string): Promise<Work>;
  create(input: CreateWork): Promise<Work>;
  claim(id: string, owner: Owner): Promise<Work | null>;
  change(id: string, expectedAssignee: string, change: (work: Work) => Work): Promise<Work>;
  release(id: string, expectedAssignee: string): Promise<Work>;
  health(): Promise<void>;
}

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
    this.name = "DomainError";
  }
}
export function assertOwner(work: Work, owner: Owner): void {
  if (work.assignee !== ownerKey(owner)) {
    throw new DomainError("stale_owner", "The work assignment has changed; this execution is no longer authorized.");
  }
}
export function pathsOverlap(a: string[], b: string[]): boolean {
  return a.some((left) => b.some((right) => {
    const x = left.replace(/\/+$/, "");
    const y = right.replace(/\/+$/, "");
    return x === "*" || y === "*" || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  }));
}
export const finished = (work: Work): boolean =>
  ["merged", "deployed", "done"].includes(work.data.phase);

export function eligible(work: Work, all: Work[], role: AgentRole): boolean {
  if (work.assignee || work.data.rank === null || work.data.role !== role) return false;
  if (!["ready", "changes_requested"].includes(work.data.phase)) return false;
  if (!work.acceptance.trim()) return false;
  if (work.data.reviewOf) {
    const parent = all.find((item) => item.id === work.data.reviewOf);
    if (!parent || parent.data.phase !== "review" || parent.data.head !== work.data.head) return false;
  }
  if (work.data.dependencies.some((id) => !all.some((item) => item.id === id && finished(item)))) return false;
  return !all.some((item) => item.id !== work.id && item.assignee && !finished(item)
    && item.data.phase !== "cancelled" && item.data.kind !== "epic"
    && pathsOverlap(work.data.paths, item.data.paths));
}
