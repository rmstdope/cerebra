import {
  DomainError, eligible, ownerKey, workDataSchema,
  type CreateWork, type Owner, type Work, type WorkStore,
} from "../../../packages/core/src/model.js";
import { LocalLocks } from "./locks.js";

/** In-memory test fixture; never selected by production configuration. */
export class MemoryWorkStore implements WorkStore {
  private items = new Map<string, Work>();
  private locks = new LocalLocks();
  private sequence = 0;
  async health(): Promise<void> {}
  async list(): Promise<Work[]> { return structuredClone([...this.items.values()]); }
  async get(id: string): Promise<Work> {
    const work = this.items.get(id);
    if (!work) throw new DomainError("not_found", "Work package not found.", 404);
    return structuredClone(work);
  }
  async create(input: CreateWork): Promise<Work> {
    return this.locks.run("work", async () => {
      if (input.data?.source) {
        const existing = [...this.items.values()].find((work) => work.data.source === input.data?.source);
        if (existing) return structuredClone(existing);
      }
      const work: Work = {
        id: `test-${++this.sequence}`, title: input.title, description: input.description,
        acceptance: input.acceptance, data: workDataSchema.parse(input.data ?? {}),
      };
      this.items.set(work.id, work);
      return structuredClone(work);
    });
  }
  async claim(id: string, owner: Owner): Promise<Work | null> {
    return this.locks.run("work", async () => {
      const work = await this.get(id);
      if (!eligible(work, await this.list(), work.data.role)) return null;
      if (work.data.affinity && (work.data.affinity.instance !== owner.instance || work.data.affinity.agent !== owner.agent)) return null;
      work.owner = owner;
      work.assignee = ownerKey(owner);
      work.data.phase = "working";
      work.data.startedAt ??= new Date().toISOString();
      work.data.progressAt = new Date().toISOString();
      this.items.set(id, structuredClone(work));
      return work;
    });
  }
  async change(id: string, assignee: string, change: (work: Work) => Work): Promise<Work> {
    return this.locks.run("work", async () => {
      const current = await this.get(id);
      if ((current.assignee ?? "") !== assignee) throw new DomainError("stale_owner", "Ownership changed.");
      const next = change(current);
      next.data = workDataSchema.parse(next.data);
      this.items.set(id, structuredClone(next));
      return structuredClone(next);
    });
  }
  async release(id: string, assignee: string): Promise<Work> {
    return this.change(id, assignee, (work) => ({ ...work, assignee: undefined, owner: undefined }));
  }
}
