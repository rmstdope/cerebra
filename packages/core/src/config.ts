import { z } from "zod";
import { agentRoles, idSchema } from "./model.js";

const agentSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  role: z.enum(agentRoles),
  provider: z.enum(["claude", "copilot"]),
  model: z.string().optional(),
  providerAgent: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).optional(),
  instructions: z.string().min(1),
  enabled: z.boolean().default(true),
}).strict();
export const configSchema = z.object({
  instance: idSchema,
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1024).max(65535).default(4545),
  publicUrl: z.url().default("http://localhost:4545"),
  tls: z.object({ cert: z.string(), key: z.string() }).optional(),
  dataDirectory: z.string().default(".cerebra-local"),
  database: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().default(3307),
    user: z.string().default("cerebra"),
    passwordEnv: z.string().default("CEREBRA_DATABASE_PASSWORD"),
    database: idSchema.default("cerebra"),
  }).strict(),
  project: z.object({
    id: idSchema,
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    checkout: z.string(),
    beadsDirectory: z.string(),
    defaultBranch: z.string().default("main"),
    policy: z.string().min(1),
    requireRebase: z.boolean().default(true),
    requireHumanReview: z.boolean().default(false),
    requireCI: z.boolean().default(false),
    requireVerification: z.boolean().default(false),
    checkpoints: z.array(z.object({
      id: idSchema,
      description: z.string().min(1).max(2000),
      humanRole: z.enum(["product", "ux", "ui", "architect", "developer", "qa"]).optional(),
    }).strict()).default([]),
    deploymentWorkflow: z.string().regex(/^[\w.-]+\.ya?ml$/).optional(),
    deploymentRoles: z.array(z.enum(["product", "ux", "ui", "architect", "developer", "qa"]))
      .min(1).default(["product"]),
  }).strict(),
  sandbox: z.object({
    image: z.string().default("cerebra-agent:local"),
    cpus: z.number().positive().default(2),
    memory: z.string().regex(/^\d+[mg]$/i).default("4g"),
    credentialsDirectory: z.string(),
    engineUrl: z.url().default("http://host.docker.internal:4546"),
    bridgeHost: z.string().default("127.0.0.1"),
    bridgePort: z.number().int().min(1024).max(65535).default(4546),
  }).strict(),
  agents: z.array(agentSchema).min(1).max(100),
  pollMs: z.number().int().min(500).default(5000),
  githubPollMs: z.number().int().min(10_000).default(60_000),
  stuckMs: z.number().int().min(60_000).default(30 * 60_000),
  toolTimeoutMs: z.number().int().min(60_000).default(6 * 60 * 60_000),
  recoveryStableMs: z.number().int().min(1000).default(60_000),
  maxRecoveryAttempts: z.number().int().min(0).max(10).default(3),
}).strict();
export type Config = z.infer<typeof configSchema>;
export type AgentConfig = Config["agents"][number];

export function validateConfig(value: unknown): Config {
  const config = configSchema.parse(value);
  if (new Set(config.agents.map((agent) => agent.id)).size !== config.agents.length) {
    throw new Error("Agent IDs must be unique within an instance.");
  }
  if (new Set(config.project.checkpoints.map((gate) => gate.id)).size !== config.project.checkpoints.length) {
    throw new Error("Checkpoint IDs must be unique within a project.");
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(config.host);
  if (!loopback && (!config.tls || !config.publicUrl.startsWith("https://"))) {
    throw new Error("Network-facing UIs require TLS and an HTTPS publicUrl.");
  }
  if (!["http:", "https:"].includes(new URL(config.publicUrl).protocol)) {
    throw new Error("publicUrl must use HTTP or HTTPS.");
  }
  return config;
}
