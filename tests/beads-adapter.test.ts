import { describe, expect, it, vi } from "vitest";
import { BeadsStore } from "../apps/server/src/beads.js";
import { LocalLocks } from "../apps/server/src/locks.js";
import { CommandError, type RunCommand } from "../apps/server/src/command.js";
import { ownerKey } from "../packages/core/src/model.js";
import { randomUUID } from "node:crypto";

describe("Beads adapter preconditions", () => {
  it("rejects embedded databases rather than silently offering local-only claims", async () => {
    const run = vi.fn<RunCommand>().mockResolvedValue(JSON.stringify({
      backend: "dolt", dolt_mode: "embedded", database: "work", project_id: "id",
    }));
    const store = new BeadsStore("/fixture", "project", new LocalLocks(), {}, run);
    await expect(store.identity()).rejects.toThrow("shared Dolt server mode");
  });
  it("requires atomic guarded updates instead of weakening fencing", async () => {
    const run = vi.fn<RunCommand>().mockResolvedValue("bd update --claim");
    await expect(new BeadsStore("/fixture", "project", new LocalLocks(), {}, run).health())
      .rejects.toThrow("atomic --if-assignee");
  });
  it("preserves a concurrent stale-owner failure returned by bd", async () => {
    const owner = { instance: "machine", agent: "builder", token: randomUUID() };
    const bead = { id: "work-1", title: "Task", assignee: ownerKey(owner), metadata: {} };
    const run = vi.fn<RunCommand>().mockImplementation(async (_file, args) => {
      if (args.includes("show")) return JSON.stringify([bead]);
      if (args.includes("update")) throw new CommandError("bd", 13, "assignee mismatch");
      throw new Error(`Unexpected command ${args.join(" ")}`);
    });
    const store = new BeadsStore("/fixture", "project", new LocalLocks(), {}, run);
    await expect(store.change("work-1", ownerKey(owner), (item) => item)).rejects.toThrow("update was rejected");
  });
  it("surfaces malformed work metadata rather than inventing a default state", async () => {
    const run = vi.fn<RunCommand>().mockResolvedValue(JSON.stringify([{
      id: "work-1", title: "Task", metadata: { cerebra: "not-json" },
    }]));
    await expect(new BeadsStore("/fixture", "project", new LocalLocks(), {}, run).list()).rejects.toThrow();
  });
});
