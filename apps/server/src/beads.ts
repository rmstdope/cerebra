import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  DomainError, eligible, idSchema, ownerKey, parseOwner, workDataSchema,
  type CreateWork, type Owner, type Work, type WorkStore,
} from "../../../packages/core/src/model.js";
import { CommandError, runCommand, type RunCommand } from "./command.js";
import { lockName, type Locks } from "./locks.js";

const beadSchema = z.object({
  id: idSchema,
  status: z.string().default("open"),
  title: z.string(),
  description: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  assignee: z.string().optional(),
  metadata: z.union([z.record(z.string(), z.unknown()), z.string()]).nullish(),
});
type Bead = z.infer<typeof beadSchema>;
function toWork(bead: Bead): Work {
  const metadata = typeof bead.metadata === "string" ? JSON.parse(bead.metadata) as unknown : bead.metadata;
  const object = z.record(z.string(), z.unknown()).parse(metadata ?? {});
  const value: unknown = typeof object.cerebra === "string" ? JSON.parse(object.cerebra) : object.cerebra;
  const data = workDataSchema.parse(value ?? {});
  if (object.cerebra === undefined && bead.status === "closed") data.phase = "done";
  return {
    id: bead.id, title: bead.title, description: bead.description ?? "",
    acceptance: bead.acceptance_criteria ?? "",
    assignee: bead.assignee || undefined,
    owner: parseOwner(bead.assignee),
    data,
  };
}

export class BeadsStore implements WorkStore {
  private lockKey: string;
  constructor(
    private directory: string,
    project: string,
    private locks: Locks,
    private env: NodeJS.ProcessEnv = {},
    private run: RunCommand = runCommand,
  ) { this.lockKey = `work:${project}`; }

  private async bd(args: string[], actor = "cerebra"): Promise<string> {
    return this.run("bd", ["--json", "--actor", actor, ...args], {
      cwd: this.directory,
      env: { ...this.env, BEADS_DIR: resolve(this.directory, ".beads"), BD_NON_INTERACTIVE: "1", NO_COLOR: "1" },
      timeout: 60_000,
    });
  }
  async health(): Promise<void> {
    const help = await this.run("bd", ["update", "--help"], { cwd: this.directory });
    if (!help.includes("--if-assignee") || !help.includes("--if-status")) {
      throw new Error("Beads must support atomic --if-assignee and --if-status guards. Upgrade bd before starting.");
    }
    await this.identity();
    const probe = `authority:${randomUUID()}`;
    await this.locks.run(probe, async () => {
      const rows = z.array(z.object({ acquired: z.union([z.number(), z.string()]).nullable() })).min(1).parse(
        JSON.parse(await this.bd(["sql", `SELECT GET_LOCK('${lockName(probe)}', 0) AS acquired`])));
      if (rows[0]!.acquired === null || Number(rows[0]!.acquired) !== 0) {
        throw new Error("Beads and application coordination must connect to the same Dolt server; the cross-connection authority check failed.");
      }
    });
    await this.list();
  }
  async identity(): Promise<{ projectId: string; database: string; branch: string }> {
    const context = z.object({
      backend: z.string(), dolt_mode: z.string(), database: z.string(), project_id: z.string(),
    }).parse(JSON.parse(await this.bd(["context"])));
    if (context.backend !== "dolt" || context.dolt_mode !== "server") {
      throw new Error("Cerebra requires Beads shared Dolt server mode; embedded or synchronized replicas are not supported.");
    }
    const rows = z.array(z.object({ branch: z.string() })).min(1).parse(
      JSON.parse(await this.bd(["sql", "SELECT active_branch() AS branch"])));
    return { projectId: context.project_id, database: context.database, branch: rows[0]!.branch };
  }
  async list(): Promise<Work[]> {
    const value: unknown = JSON.parse(await this.bd(["list", "--all", "--limit", "0"]));
    return z.array(beadSchema).parse(value ?? []).map(toWork);
  }
  async get(id: string): Promise<Work> {
    const value: unknown = JSON.parse(await this.bd(["show", id]));
    const parsed = z.union([beadSchema, z.array(beadSchema).min(1)]).parse(value);
    const bead = Array.isArray(parsed) ? parsed[0]! : parsed;
    return toWork(bead);
  }
  async create(input: CreateWork): Promise<Work> {
    return this.locks.run(this.lockKey, async () => {
      const data = workDataSchema.parse(input.data ?? {});
      if (data.source) {
        const existing = (await this.list()).find((work) => work.data.source === data.source);
        if (existing) return existing;
      }
      const value: unknown = JSON.parse(await this.bd([
        "create", "--title", input.title, "--description", input.description,
        "--acceptance", input.acceptance, "--metadata", JSON.stringify({ cerebra: data }),
        ...(data.parent ? ["--parent", data.parent] : []),
      ]));
      return toWork(beadSchema.parse(value));
    });
  }
  async claim(id: string, owner: Owner): Promise<Work | null> {
    return this.locks.run(this.lockKey, async () => {
      const all = await this.list();
      const work = all.find((item) => item.id === id);
      if (!work || !eligible(work, all, work.data.role)) return null;
      if (work.data.affinity && (work.data.affinity.instance !== owner.instance || work.data.affinity.agent !== owner.agent)) return null;
      const data = {
        ...work.data, phase: "working", startedAt: work.data.startedAt ?? new Date().toISOString(),
        progressAt: new Date().toISOString(),
      };
      try {
        await this.bd([
          "update", id, "--if-assignee", "", "--if-status", "open",
          "--assignee", ownerKey(owner), "--status", "in_progress",
          "--set-metadata", `cerebra=${JSON.stringify(data)}`,
        ], ownerKey(owner));
      } catch (error) {
        if (error instanceof CommandError && error.exitCode === 13) return null;
        throw error;
      }
      return this.get(id);
    });
  }
  async change(id: string, expectedAssignee: string, change: (work: Work) => Work): Promise<Work> {
    return this.locks.run(this.lockKey, async () => {
      const current = await this.get(id);
      if ((current.assignee ?? "") !== expectedAssignee) {
        throw new DomainError("stale_owner", "Work ownership changed; refresh before retrying.");
      }
      const next = change(structuredClone(current));
      const data = workDataSchema.parse(next.data);
      const status = ["merged", "deployed", "done", "cancelled"].includes(data.phase)
        ? "closed" : expectedAssignee ? "in_progress" : "open";
      try {
        await this.bd([
          "update", id, "--if-assignee", expectedAssignee,
          "--status", status,
          "--title", next.title, "--description", next.description,
          "--acceptance", next.acceptance,
          "--set-metadata", `cerebra=${JSON.stringify(data)}`,
        ], expectedAssignee || "cerebra");
      } catch (error) {
        if (error instanceof CommandError && error.exitCode === 13) {
          throw new DomainError("stale_owner", "Work ownership changed; this update was rejected.");
        }
        throw error;
      }
      return this.get(id);
    });
  }
  async release(id: string, expectedAssignee: string): Promise<Work> {
    if (!expectedAssignee) throw new DomainError("unassigned", "Work is already unassigned.");
    return this.locks.run(this.lockKey, async () => {
      await this.bd(["unclaim", id, "--if-assignee", expectedAssignee], expectedAssignee);
      return this.get(id);
    });
  }
}
