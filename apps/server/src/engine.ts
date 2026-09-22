import { createHash, randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { cpus, freemem, totalmem, loadavg } from "node:os";
import type { Config, AgentConfig } from "../../../packages/core/src/config.js";
import {
  assertOwner, DomainError, eligible, finished, humanRoles, ownerKey,
  type CreateWork, type HumanRole, type Owner, type Usage, type Work, type WorkStore,
} from "../../../packages/core/src/model.js";
import type { User } from "./accounts.js";
import { Events, type ProviderEvent } from "./events.js";
import type { AgentView, Execution, Runtime } from "./runtime.js";
import { checkMergePolicy, type GitHub } from "./github.js";
import { LocalLocks, type Locks } from "./locks.js";

interface Slot {
  config: AgentConfig;
  view: AgentView;
  owner?: Owner;
  execution?: Execution;
  credential?: string;
  stopping: boolean;
  tools: Map<string, number>;
  initialPrompt?: string;
  pendingAnswer?: string;
  recovering: boolean;
  retiring: boolean;
  reserving: boolean;
  launchedAt: number;
  terminalFrames: { sequence: number; data: string }[];
  terminalSequence: number;
  usageIds: Set<string>;
}
const now = () => new Date().toISOString();
function rankingRevision(work: Work[]): string {
  return createHash("sha256").update(JSON.stringify(work
    .filter((item) => !item.data.parent && ["delivery", "epic"].includes(item.data.kind))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => [item.id, item.data.rank]))).digest("hex");
}
function combineUsage(items: Usage[]): Usage | null {
  if (!items.length) return null;
  const knownSum = (key: "inputTokens" | "outputTokens" | "nanoAiu") => {
    const values = items.map((item) => item[key]).filter((value) => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  return {
    requests: items.reduce((sum, item) => sum + item.requests, 0),
    inputTokens: knownSum("inputTokens"), outputTokens: knownSum("outputTokens"), nanoAiu: knownSum("nanoAiu"),
    unpricedRequests: items.reduce((sum, item) => sum + item.unpricedRequests, 0),
  };
}
export class Engine {
  readonly events = new Events();
  private slots = new Map<string, Slot>();
  private ticking = false;
  private timer?: NodeJS.Timeout;
  private lastGitHubPoll = 0;
  private mode: "running" | "paused" | "draining" | "stopped" = "paused";
  private lastError?: string;
  private subscribers = new Set<Promise<unknown>>();
  private providerLocks = new LocalLocks();

  constructor(
    readonly config: Config,
    readonly store: WorkStore,
    private runtime: Runtime,
    private github: GitHub,
    private locks: Locks,
    private checkPolicy: () => Promise<void> = async () => {},
  ) {
    for (const agent of config.agents) this.slots.set(agent.id, {
      config: agent, stopping: false, tools: new Map(), recovering: false, retiring: false, reserving: false, launchedAt: 0,
      terminalFrames: [], terminalSequence: 0,
      usageIds: new Set(),
      view: { id: agent.id, name: agent.name, role: agent.role, provider: agent.provider,
        state: agent.enabled ? "idle" : "stopped", ready: false, busy: false, usage: null },
    });
  }
  private report(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.events.publish({ type: "error", message: this.lastError });
  }
  private background(operation: Promise<unknown>): void {
    this.subscribers.add(operation);
    void operation.catch((error) => this.report(error)).finally(() => this.subscribers.delete(operation));
  }
  async start(): Promise<void> {
    if (this.timer) throw new Error("This engine is already started.");
    await this.store.health();
    await this.runtime.preflight();
    const existing = await this.store.list();
    const activeRoles = new Map<string, string>();
    for (const work of existing.filter((item) => item.owner?.instance === this.config.instance
      && ["working", "waiting", "blocked", "changes_requested"].includes(item.data.phase))) {
      const agent = work.owner!.agent;
      if (!this.slots.has(agent)) throw new Error(`Work ${work.id} belongs to removed agent ${agent}. Restore the roster entry or explicitly reassign its work.`);
      if (activeRoles.has(agent)) throw new Error(`Agent ${agent} owns multiple executable packages (${activeRoles.get(agent)}, ${work.id}). Resolve the assignments before starting.`);
      const slot = this.slots.get(agent)!;
      if (slot.config.role !== work.data.role) throw new Error(`Agent ${agent}'s role changed while it owns ${work.id}. Resolve the assignment before changing its role.`);
      slot.owner = work.owner;
      slot.view.workId = work.id;
      if (work.data.phase === "blocked") { slot.view.state = "blocked"; slot.view.error = work.data.error; }
      activeRoles.set(agent, work.id);
    }
    this.mode = "running";
    await this.tick();
    this.timer = setInterval(() => this.background(this.tick()), this.config.pollMs);
  }
  async stop(): Promise<void> {
    this.mode = "stopped";
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled(this.subscribers);
    const failures: unknown[] = [];
    for (const slot of this.slots.values()) {
      slot.stopping = true;
      try {
        await slot.execution?.stop();
        slot.execution = undefined;
      } catch (error) { failures.push(error); this.report(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Some local executions could not be stopped.");
  }
  async control(action: "resume" | "pause" | "drain" | "stop"): Promise<void> {
    if (action === "stop") {
      this.mode = "stopped";
      for (const slot of this.slots.values()) {
        slot.stopping = true;
        await slot.execution?.stop();
        slot.execution = undefined;
        slot.view.state = "stopped";
      }
    } else this.mode = action === "resume" ? "running" : action === "pause" ? "paused" : "draining";
    this.events.publish({ type: "state" });
  }
  async snapshot() {
    const work = await this.store.list();
    const local = work.filter((item) => item.owner?.instance === this.config.instance
      && item.data.phase !== "cancelled" && !finished(item));
    const durations = work.filter((item) => item.data.kind === "delivery" && finished(item)
      && item.data.startedAt && item.data.finishedAt)
      .map((item) => Date.parse(item.data.finishedAt!) - Date.parse(item.data.startedAt!));
    const attentionByRole: Record<HumanRole, number> = { product: 0, ux: 0, ui: 0, architect: 0, developer: 0, qa: 0 };
    for (const role of humanRoles) {
      attentionByRole[role] = local.reduce((sum, item) =>
        sum + item.data.questions.filter((question) => question.role === role && !question.answer).length, 0);
    }
    return {
      instance: this.config.instance, project: this.config.project.id, mode: this.mode,
      agents: [...this.slots.values()].map((slot) => ({ ...slot.view })),
      work,
      rankingRevision: rankingRevision(work),
      checkpoints: this.config.project.checkpoints,
      questions: local.flatMap((item) => item.data.questions.filter((question) => !question.answer)
        .map((question) => ({ ...question, workId: item.id, title: item.title }))),
      metrics: {
        cpuCount: cpus().length, loadAverage: loadavg(), memoryTotal: totalmem(), memoryFree: freemem(),
        completed: work.filter((item) => item.data.kind === "delivery" && finished(item)).length,
        waiting: local.filter((item) => item.data.phase === "waiting").length,
        retries: work.reduce((sum, item) => sum + item.data.recoveries, 0),
        humanWaitMs: work.reduce((sum, item) => sum + item.data.waitMs, 0),
        reviewRework: work.reduce((sum, item) => sum + item.data.reviewRework, 0),
        cycleTimeMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
        attentionByRole,
        usage: combineUsage(work.flatMap((item) => item.data.usage ? [item.data.usage] : [])),
      },
      error: this.lastError,
    };
  }
  async tick(): Promise<void> {
    if (this.ticking || this.mode === "stopped") return;
    this.ticking = true;
    try {
      this.lastError = undefined;
      await this.checkPolicy();
      const all = await this.store.list();
      for (const item of all.filter((work) => work.data.phase === "decomposed" && work.owner?.instance === this.config.instance)) {
        const children = item.data.children.map((id) => all.find((work) => work.id === id));
        for (const child of children) {
          if (child && child.data.phase === "backlog") {
            await this.store.change(child.id, "", (work) => {
              work.data.phase = "ready"; return work;
            });
          }
        }
        if (children.length && children.every((child) => child && finished(child))) {
          await this.store.change(item.id, item.assignee!, (work) => {
            work.data.phase = "done"; work.data.finishedAt = now(); return work;
          });
        }
      }
      // Store outage throws before scheduling, recovery, or controlled external actions.
      for (const slot of this.slots.values()) {
        if (!["running", "paused", "draining"].includes(this.mode)) break;
        if (!slot.config.enabled || slot.recovering || slot.reserving) continue;
        if (slot.retiring) {
          await this.retireExecution(slot);
        }
        if (slot.execution && slot.view.workId && slot.owner) {
          const current = all.find((item) => item.id === slot.view.workId);
          if (!current || current.assignee !== ownerKey(slot.owner)) {
            await this.retireExecution(slot);
            this.report(new DomainError("stale_owner", `${slot.config.name}: ownership changed; old execution stopped.`));
            continue;
          }
          if (!["working", "waiting", "changes_requested", "blocked"].includes(current.data.phase)) {
            await this.retireExecution(slot);
            continue;
          }
          await this.deliverPending(slot);
          if (!slot.view.ready && Date.now() - (slot.view.lastActivity ?? Date.now()) > 120_000) {
            slot.view.error = "Provider bridge did not become ready. Use the terminal to finish login/trust setup, then retry.";
            slot.view.state = "blocked";
            await this.store.change(current.id, current.assignee!, (item) => {
              item.data.phase = "blocked"; item.data.error = slot.view.error; return item;
            });
          } else if (current.data.phase !== "waiting" && current.data.phase !== "blocked" &&
              [...slot.tools.values()].some((started) => Date.now() - started > this.config.toolTimeoutMs)) {
            await this.recover(slot, "A tool exceeded the configured long-command timeout.");
          } else if (current.data.phase !== "waiting" && current.data.phase !== "blocked" && slot.view.busy && !slot.tools.size &&
              Date.now() - (slot.view.lastActivity ?? Date.now()) > this.config.stuckMs) {
            await this.recover(slot, "Agent made no observable progress before the stuck timeout.");
          }
          continue;
        }
        if (this.mode === "paused") continue;
        const owned = all.find((item) => item.owner?.instance === this.config.instance
          && item.owner.agent === slot.config.id && ["working", "waiting", "changes_requested", "blocked"].includes(item.data.phase));
        if (owned) {
          if (owned.data.phase === "blocked") {
            slot.owner = owned.owner;
            slot.view = { ...slot.view, state: "blocked", workId: owned.id, error: owned.data.error };
          } else if (!slot.view.error) await this.launch(slot, owned, owned.data.phase !== "changes_requested");
          continue;
        }
            if (slot.view.state === "blocked") continue;
        const candidates = all.filter((work) => eligible(work, all, slot.config.role)
          && (this.mode === "running" || work.data.kind === "review" || Boolean(work.data.parent)))
          .sort((a, b) => a.data.rank! - b.data.rank! || a.data.subtaskOrder - b.data.subtaskOrder || a.id.localeCompare(b.id));
        slot.reserving = true;
        try {
          for (const candidate of candidates) {
            const owner: Owner = { instance: this.config.instance, agent: slot.config.id, token: randomUUID() };
            const claimed = await this.store.claim(candidate.id, owner);
            if (!claimed) continue;
            await this.launch(slot, claimed, false);
            break;
          }
        } finally { slot.reserving = false; }
      }
      if (["running", "draining"].includes(this.mode) && Date.now() - this.lastGitHubPoll >= this.config.githubPollMs) {
        this.lastGitHubPoll = Date.now();
        await this.pollGitHub();
      }
    } catch (error) { this.report(error); }
    finally {
      this.ticking = false;
      this.events.publish({ type: "state" });
    }
  }
  private async launch(slot: Slot, work: Work, recovery: boolean): Promise<void> {
    if (this.mode === "stopped") return;
    if (!work.owner) throw new DomainError("owner", "Cannot launch unassigned work.");
    const session = randomUUID();
    slot.owner = work.owner;
    slot.stopping = false;
    slot.tools.clear();
    slot.launchedAt = Date.now();
    slot.pendingAnswer = undefined;
    slot.terminalFrames = [];
    slot.terminalSequence = 0;
    slot.usageIds.clear();
    slot.credential = randomBytes(32).toString("base64url");
    slot.view = { ...slot.view, state: "starting", workId: work.id, session,
      ready: false, busy: false, error: undefined, lastActivity: Date.now(), terminalController: undefined,
      usage: work.data.usage ?? null };
    const updated = await this.store.change(work.id, ownerKey(work.owner), (item) => {
      if (recovery) {
        if (item.data.attempts >= this.config.maxRecoveryAttempts) {
          item.data.phase = "blocked";
          item.data.error = "Automatic recovery limit reached. Human action required.";
          return item;
        }
        item.data.attempts++;
        item.data.recoveries++;
      }
      item.data.session = session;
      if (item.data.phase === "changes_requested") {
        item.data.phase = "working";
        item.data.attempts = 0;
        item.data.error = undefined;
      }
      if (item.data.questions.some((question) => !question.answer)) item.data.phase = "waiting";
      if (slot.config.role === "implementer") item.data.authorSession = session;
      item.data.branch ??= `cerebra/${work.id}`;
      item.data.progressAt = now();
      return item;
    });
    if (updated.data.phase === "blocked") {
      slot.view.state = "blocked";
      slot.view.error = updated.data.error;
      return;
    }
    slot.initialPrompt = this.prompt(slot.config, updated);
    try {
      slot.execution = await this.runtime.launch({
        agent: slot.config, work: updated, session, credential: slot.credential,
        onTerminal: (data) => {
          if (slot.view.session !== session) return;
          const frame = { sequence: ++slot.terminalSequence, data };
          slot.terminalFrames.push(frame);
          while (slot.terminalFrames.reduce((sum, entry) => sum + entry.data.length, 0) > 256_000 && slot.terminalFrames.length > 1) {
            slot.terminalFrames.shift();
          }
          this.events.publish({ type: "terminal", agent: slot.config.id, ...frame });
        },
        onExit: (code) => {
          if (!slot.stopping && !slot.retiring && slot.view.session === session) {
            this.background(this.recover(slot, `Provider exited (${code ?? "signal"}).`));
          }
        },
        onError: (error) => {
          if (!slot.stopping && !slot.retiring && slot.view.session === session) this.background(this.recover(slot, error.message));
        },
      });
      if (!["running", "paused", "draining"].includes(this.mode)) {
        slot.stopping = true;
        await slot.execution.stop();
        slot.execution = undefined;
        return;
      }
      slot.view.state = updated.data.phase === "waiting" ? "waiting" : "working";
      // Provider-ready callbacks can arrive before launch() returns.
      if (slot.view.ready) await this.sendInitial(slot);
    } catch (error) {
      slot.stopping = true;
      if (slot.execution) {
        try { await slot.execution.stop(); }
        catch (cleanupError) { this.report(cleanupError); }
      }
      slot.execution = undefined;
      slot.view.error = error instanceof Error ? error.message : String(error);
      await this.store.change(work.id, ownerKey(work.owner), (item) => {
        item.data.error = slot.view.error;
        item.data.phase = "blocked";
        return item;
      });
      slot.view.state = "blocked";
      this.report(error);
    }
  }
  private prompt(agent: AgentConfig, work: Work): string {
    return [
      `You are ${agent.name}, a Cerebra ${agent.role}. ${agent.instructions}`,
      `Project policy:\n${this.config.project.policy}`,
      `Work ${work.id}: ${work.title}\n${work.description}\nAcceptance criteria:\n${work.acceptance}`,
      `Durable context:\n${JSON.stringify(work.data)}`,
      "Use cerebra work to read current state; cerebra checkpoint TEXT to record recovery context.",
      "Use cerebra ask ROLE QUESTION for human decisions; wait for its answer, retaining this session.",
      "Humans control UX, priority, and deployment except explicitly pre-authorized small decisions.",
      "Use TDD where it adds value. Never approve your own changes. GitHub operations use gh.",
      "After implementing and opening a PR, run cerebra submit PR_NUMBER. Do not merge directly.",
      "As reviewer, inspect the exact PR head and run cerebra review approved SUMMARY or cerebra review changes_requested SUMMARY.",
      "Use cerebra propose JSON to suggest unranked work. Do not invent priority or deployment permission.",
      "Use cerebra refine WORK_ID JSON to clarify unassigned work, or cerebra decompose JSON_ARRAY to split your current ranked package into dependent subtasks.",
      "Declare data.paths as repository-relative file/directory prefixes when proposing or decomposing work. Use '*' for whole-repository work; do not use glob patterns. These scopes prevent known overlapping assignments.",
      "When a direct conversation is complete, use cerebra complete SUMMARY to save its outcome and free the slot.",
      "Use cerebra progress TEXT for meaningful progress during long non-tool waits.",
      `Additional required checkpoints: ${JSON.stringify(this.config.project.checkpoints)}. After a PR is submitted, record agent-eligible evidence using cerebra gate GATE_ID PR_HEAD_SHA EVIDENCE; human-role gates are decided in the web UI.`,
      "If waiting questions are present, do not continue affected work until they have answers.",
    ].join("\n\n");
  }
  private async sendInitial(slot: Slot): Promise<void> {
    if (!slot.initialPrompt || !slot.execution) return;
    const text = slot.initialPrompt;
    this.writePrompt(slot, text);
    slot.initialPrompt = undefined;
  }
  private writePrompt(slot: Slot, text: string): void {
    if (!slot.execution) throw new DomainError("offline", "The agent is not running.");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
      throw new DomainError("input", "Chat messages cannot contain terminal control characters.", 400);
    }
    slot.execution.write(`\u001b[200~${text}\u001b[201~\r`);
    slot.view.busy = true;
    slot.view.lastActivity = Date.now();
  }
  private async recover(slot: Slot, reason: string): Promise<void> {
    if (slot.recovering || slot.stopping || slot.retiring || !slot.view.workId || !slot.owner) return;
    slot.recovering = true;
    try {
      slot.stopping = true;
      await slot.execution?.stop();
      slot.execution = undefined;
      slot.view.ready = false;
      slot.view.busy = false;
      const current = await this.store.get(slot.view.workId);
      assertOwner(current, slot.owner);
      if (!["working", "waiting", "changes_requested"].includes(current.data.phase)) {
        if (current.data.phase === "blocked") {
          slot.view.state = "blocked";
          slot.view.error = current.data.error;
        } else await this.retireExecution(slot);
        return;
      }
      const work = await this.store.change(slot.view.workId, ownerKey(slot.owner), (item) => {
        item.data.error = reason;
        return item;
      });
      this.events.publish({ type: "error", message: `${slot.config.name}: ${reason}` });
      if (this.mode === "running" || this.mode === "draining") await this.launch(slot, work, true);
    } finally { slot.recovering = false; }
  }
  private slot(id: string): Slot {
    const slot = this.slots.get(id);
    if (!slot) throw new DomainError("not_found", "Agent is not local to this instance.", 404);
    return slot;
  }
  terminalSnapshot(id: string) {
    const slot = this.slot(id);
    return { session: slot.view.session, frames: slot.terminalFrames, sequence: slot.terminalSequence };
  }
  authenticateExecution(id: string, credential: string): void {
    const slot = this.slot(id);
    const expected = Buffer.from(slot.credential ?? "");
    const actual = Buffer.from(credential);
    if (!expected.length || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new DomainError("unauthorized", "Invalid execution credential.", 401);
    }
    if (!slot.owner || !slot.view.workId) throw new DomainError("unassigned", "Agent has no assignment.");
  }
  async authorizedAgent(id: string, credential: string): Promise<Work> {
    this.authenticateExecution(id, credential);
    await this.checkPolicy();
    const slot = this.slot(id);
    if (!slot.owner || !slot.view.workId) throw new DomainError("unassigned", "Agent has no assignment.");
    const work = await this.store.get(slot.view.workId);
    if (slot.credential !== credential) throw new DomainError("unauthorized", "Execution changed while authenticating.", 401);
    assertOwner(work, slot.owner);
    if (!["working", "waiting", "changes_requested", "blocked"].includes(work.data.phase)) {
      throw new DomainError("inactive", "This assignment is no longer accepting agent actions.");
    }
    return work;
  }
  async providerEvent(id: string, event: ProviderEvent, credential?: string): Promise<void> {
    const session = this.slot(id).view.session;
    return this.providerLocks.run(id, () => {
      const slot = this.slot(id);
      if (slot.view.session !== session || (credential !== undefined && slot.credential !== credential)) {
        throw new DomainError("session", "The provider execution changed before this event could be applied.");
      }
      return this.applyProviderEvent(id, event);
    });
  }
  private async applyProviderEvent(id: string, event: ProviderEvent): Promise<void> {
    const slot = this.slot(id);
    slot.view.lastActivity = Date.now();
    if (event.type === "ready") {
      if (event.session !== slot.view.session) throw new DomainError("session", "Provider session does not match execution.");
      slot.view.ready = true;
      await this.sendInitial(slot);
    } else if (event.type === "user" || event.type === "busy") slot.view.busy = true;
    else if (event.type === "idle") {
      slot.view.busy = false;
      slot.tools.clear();
      await this.deliverPending(slot);
    } else if (event.type === "tool_start") slot.tools.set(event.id, Date.now());
    else if (event.type === "tool_end") slot.tools.delete(event.id);
    else if (event.type === "usage" && slot.owner && slot.view.workId && !slot.usageIds.has(event.id)) {
      const updated = await this.store.change(slot.view.workId, ownerKey(slot.owner), (work) => {
        work.data.usage = combineUsage([
          ...(work.data.usage ? [work.data.usage] : []),
          { requests: 1, inputTokens: event.inputTokens ?? null, outputTokens: event.outputTokens ?? null,
            nanoAiu: event.nanoAiu ?? null, unpricedRequests: event.nanoAiu === undefined ? 1 : 0 },
        ])!;
        return work;
      });
      slot.usageIds.add(event.id);
      slot.view.usage = updated.data.usage!;
    }
    else if (event.type === "error") {
      slot.view.error = event.message;
      if (event.recoverable) await this.recover(slot, event.message);
      else if (slot.owner && slot.view.workId) {
        await this.store.change(slot.view.workId, ownerKey(slot.owner), (item) => {
          item.data.phase = "blocked"; item.data.error = event.message; return item;
        });
        slot.view.state = "blocked";
      }
    }
    this.events.publish({ type: "provider", agent: id, event });
  }
  async chat(id: string, text: string, expectedSession?: string): Promise<void> {
    const slot = this.slot(id);
    if (expectedSession && expectedSession !== slot.view.session) throw new DomainError("session", "The agent session changed. Refresh before sending.");
    if (!slot.view.ready) throw new DomainError("not_ready", "Provider structured bridge is not ready.");
    if (slot.view.terminalController) throw new DomainError("terminal_control", "Release terminal control before sending chat.");
    if (slot.view.busy) throw new DomainError("busy", "Wait for the current agent turn before sending another message.");
    if (!slot.owner || !slot.view.workId) throw new DomainError("unassigned", "Agent has no work.");
    assertOwner(await this.store.get(slot.view.workId), slot.owner);
    this.writePrompt(slot, text);
  }
  async terminal(id: string, controller: string, action: "acquire" | "release" | "input" | "resize",
    data?: string, cols = 100, rows = 30): Promise<void> {
    const slot = this.slot(id);
    if (!slot.owner || !slot.view.workId) throw new DomainError("unassigned", "Agent has no work.");
    assertOwner(await this.store.get(slot.view.workId), slot.owner);
    if (action === "acquire") {
      if (slot.view.terminalController && slot.view.terminalController !== controller) {
        throw new DomainError("controlled", "Another browser controls this terminal.");
      }
      slot.view.terminalController = controller;
    } else {
      if (slot.view.terminalController !== controller) throw new DomainError("control", "Acquire terminal control first.", 403);
      if (action === "release") {
        slot.view.terminalController = undefined;
        await this.deliverPending(slot);
      } else if (action === "input") slot.execution?.write(data ?? "");
      else await slot.execution?.resize(cols, rows);
    }
    this.events.publish({ type: "state" });
  }
  releaseController(controller: string): void {
    for (const slot of this.slots.values()) {
      if (slot.view.terminalController === controller) {
        slot.view.terminalController = undefined;
        this.background(this.deliverPending(slot));
      }
    }
    this.events.publish({ type: "state" });
  }
  private async deliverPending(slot: Slot): Promise<void> {
    if (!slot.pendingAnswer || !slot.execution || !slot.view.ready || slot.view.busy ||
        slot.view.terminalController || !slot.owner || !slot.view.workId) return;
    assertOwner(await this.store.get(slot.view.workId), slot.owner);
    if (slot.pendingAnswer && !slot.view.busy && !slot.view.terminalController) {
      this.writePrompt(slot, slot.pendingAnswer);
      slot.pendingAnswer = undefined;
    }
  }
  async create(input: CreateWork): Promise<Work> {
    await this.validateDependencies("", input.data?.dependencies ?? []);
    return this.store.create({ ...input, data: { ...input.data, rank: null, phase: "backlog" } });
  }
  private async validateDependencies(id: string, dependencies: string[]): Promise<void> {
    if (!dependencies.length) return;
    const all = await this.store.list();
    const byId = new Map(all.map((work) => [work.id, work]));
    const visit = (current: string, ancestors: Set<string>) => {
      if (current === id || ancestors.has(current)) throw new DomainError("dependency", "Dependencies must not form a cycle.", 400);
      const work = byId.get(current);
      if (!work) throw new DomainError("dependency", `Dependency ${current} does not exist.`, 400);
      const path = new Set(ancestors); path.add(current);
      for (const dependency of work.data.dependencies) visit(dependency, path);
    };
    for (const dependency of dependencies) visit(dependency, new Set());
  }
  async editWork(id: string, input: CreateWork): Promise<Work> {
    return this.locks.run(`graph:${this.config.project.id}`, async () => {
      await this.validateDependencies(id, input.data?.dependencies ?? []);
      return this.store.change(id, "", (work) => {
        work.title = input.title;
        work.description = input.description;
        work.acceptance = input.acceptance;
        if (input.data?.role) work.data.role = input.data.role;
        if (input.data?.paths) work.data.paths = input.data.paths;
        if (input.data?.dependencies) work.data.dependencies = input.data.dependencies;
        return work;
      });
    });
  }
  async decompose(id: string, inputs: (CreateWork & { after: number[] })[]): Promise<Work[]> {
    const slot = this.slot(id);
    if (!slot.owner || !slot.view.workId) throw new DomainError("unassigned", "Agent has no work.");
    const parent = await this.store.get(slot.view.workId);
    assertOwner(parent, slot.owner);
    if (parent.data.phase === "decomposed") return Promise.all(parent.data.children.map((child) => this.store.get(child)));
    if (parent.data.kind !== "delivery" || parent.data.pr || parent.data.questions.some((q) => !q.answer)) {
      throw new DomainError("decompose", "Only an unsubmitted delivery package without pending questions can be decomposed.");
    }
    for (const [index, input] of inputs.entries()) {
      if (input.after.some((dependency) => dependency < 0 || dependency >= index)) {
        throw new DomainError("dependency", "Subtasks may depend only on earlier entries in the decomposition.", 400);
      }
    }
    const children: Work[] = [];
    for (const [index, input] of inputs.entries()) {
      const child = await this.store.create({
        ...input,
        data: { ...input.data, kind: "delivery", parent: parent.id, subtaskOrder: index,
          phase: "backlog", rank: parent.data.rank, source: `child:${parent.id}:${index}`,
          dependencies: [...parent.data.dependencies, ...input.after.map((n) => children[n]!.id)] },
      });
      children.push(child);
    }
    // Children remain unschedulable until the parent records the complete split.
    await this.store.change(parent.id, parent.assignee!, (work) => {
      work.data.kind = "epic"; work.data.phase = "decomposed";
      work.data.children = children.map((child) => child.id);
      work.data.checkpoint = `Split into ${children.map((child) => child.id).join(", ")}.`;
      return work;
    });
    for (const child of children) {
      await this.store.change(child.id, "", (work) => { work.data.phase = "ready"; return work; });
    }
    await this.finishExecution(slot);
    return children;
  }
  async conversation(id: string, text: string, user: User): Promise<Work> {
    if (this.mode !== "running") throw new DomainError("paused", "Resume the fleet before starting a conversation.");
    const slot = this.slot(id);
    if (slot.execution || slot.view.workId || !slot.config.enabled || slot.reserving) {
      throw new DomainError("busy", "Choose an enabled, idle agent for this conversation.");
    }
    slot.reserving = true;
    try {
      const work = await this.store.create({
      title: `Conversation with ${slot.config.name}`,
      description: text,
      acceptance: "Clarify the human's request, record decisions, and propose unranked delivery work as appropriate.",
      data: { kind: "conversation", role: slot.config.role, phase: "ready", rank: 0,
        affinity: { instance: this.config.instance, agent: id },
        decisions: [{ by: user.id, text: "Human requested this direct conversation.", at: now() }] },
    });
      const owner = { instance: this.config.instance, agent: id, token: randomUUID() };
      const claimed = await this.store.claim(work.id, owner);
      if (!claimed) throw new DomainError("claimed", "The conversation was claimed concurrently; refresh the fleet.");
      await this.launch(slot, claimed, false);
      return claimed;
    } finally { slot.reserving = false; }
  }
  async complete(id: string, summary: string): Promise<Work> {
    const slot = this.slot(id);
    if (!slot.owner || !slot.view.workId) throw new DomainError("unassigned", "No work assigned.");
    const result = await this.store.change(slot.view.workId, ownerKey(slot.owner), (item) => {
      if (item.data.kind !== "conversation") {
        throw new DomainError("workflow", "Delivery work must pass implementation, review, and merge checkpoints.");
      }
      if (item.data.questions.some((q) => !q.answer)) throw new DomainError("waiting", "Resolve pending questions first.");
      item.data.phase = "done"; item.data.checkpoint = summary; item.data.finishedAt = now();
      return item;
    });
    await this.finishExecution(slot);
    return result;
  }
  async rank(ids: string[], user: User, revision?: string): Promise<void> {
    if (!user.roles.includes("product")) throw new DomainError("role", "A product role is required to rank work.", 403);
    if (new Set(ids).size !== ids.length) throw new DomainError("rank", "Ranking contains duplicate IDs.", 400);
    await this.locks.run(`ranking:${this.config.project.id}`, async () => {
      const all = await this.store.list();
      if (revision && revision !== rankingRevision(all)) {
        throw new DomainError("ranking_conflict", "The backlog changed since you viewed it. Refresh and resolve the priority change with the other humans.");
      }
      for (const id of ids) {
        const item = all.find((work) => work.id === id);
        if (!item || item.data.parent || !["delivery", "epic"].includes(item.data.kind)) {
          throw new DomainError("ranking", "Rank existing top-level delivery work; agents order its subtasks.", 400);
        }
      }
      if (all.some((item) => item.data.rank !== null && !item.data.parent
          && ["delivery", "epic"].includes(item.data.kind) && !ids.includes(item.id))) {
        throw new DomainError("ranking", "Submit the complete ordered list of already-ranked top-level work.", 400);
      }
      for (const [rank, id] of ids.entries()) {
        const item = await this.store.get(id);
        await this.store.change(id, item.assignee ?? "", (work) => {
          work.data.rank = rank;
          if (work.data.phase === "backlog") work.data.phase = "ready";
          return work;
        });
        for (const child of all.filter((work) => work.data.parent === id)) {
          await this.store.change(child.id, child.assignee ?? "", (work) => {
            work.data.rank = rank; return work;
          });
        }
      }
    });
    this.events.publish({ type: "state" });
  }
  async ask(id: string, role: HumanRole, text: string): Promise<Work> {
    const slot = this.slot(id);
    if (!slot.owner || !slot.view.workId) throw new DomainError("unassigned", "Agent has no work.");
    const result = await this.store.change(slot.view.workId, ownerKey(slot.owner), (work) => {
      if (work.data.questions.every((question) => question.answer)) work.data.waitStartedAt = now();
      work.data.questions.push({ id: randomUUID(), role, text, askedAt: now() });
      work.data.phase = "waiting";
      return work;
    });
    slot.view.state = "waiting";
    this.events.publish({ type: "state" });
    return result;
  }
  async answer(workId: string, questionId: string, text: string, user: User): Promise<Work> {
    const work = await this.store.get(workId);
    if (work.owner?.instance !== this.config.instance) {
      throw new DomainError("remote_question", "Answer this question through its owning machine's UI.", 403);
    }
    const slot = this.slot(work.owner.agent);
    if (slot.view.workId && slot.view.workId !== workId) {
      throw new DomainError("assignment", "The configured agent is executing a different package. Resolve the assignment before answering.");
    }
    const result = await this.store.change(workId, work.assignee!, (item) => {
      const question = item.data.questions.find((entry) => entry.id === questionId);
      if (!question) throw new DomainError("not_found", "Question not found.", 404);
      if (question.answer) throw new DomainError("answered", "Another human already answered this question.");
      if (!user.roles.includes(question.role)) throw new DomainError("role", "You are not assigned to the requested role.", 403);
      question.answer = text; question.answeredBy = user.id; question.answeredAt = now();
      item.data.decisions.push({ by: user.id, text, at: now() });
      if (item.data.questions.every((entry) => entry.answer)) {
        item.data.waitMs += Date.now() - Date.parse(item.data.waitStartedAt ?? question.askedAt);
        item.data.waitStartedAt = undefined;
        item.data.phase = "working";
      }
      return item;
    });
    slot.view.state = result.data.phase === "waiting" ? "waiting" : "working";
    const response = `Human ${user.id} answered question ${questionId}: ${text}\nUse cerebra work to read all current decisions.`;
    slot.pendingAnswer = slot.pendingAnswer ? `${slot.pendingAnswer}\n\n${response}` : response;
    await this.deliverPending(slot);
    this.events.publish({ type: "state" });
    return result;
  }
  async checkpoint(id: string, text: string): Promise<Work> {
    const slot = this.slot(id);
    if (!slot.owner || !slot.view.workId) throw new DomainError("unassigned", "No work assigned.");
    slot.view.lastActivity = Date.now();
    return this.store.change(slot.view.workId, ownerKey(slot.owner), (work) => {
      if (text !== work.data.checkpoint && Date.now() - slot.launchedAt >= this.config.recoveryStableMs) {
        work.data.attempts = 0;
        work.data.error = undefined;
      }
      work.data.checkpoint = text;
      work.data.progressAt = now();
      return work;
    });
  }
  async submit(id: string, prNumber: number): Promise<Work> {
    const slot = this.slot(id);
    if (!slot.owner || !slot.view.workId || slot.config.role !== "implementer") {
      throw new DomainError("role", "Only the assigned implementer can submit a change.");
    }
    const pr = await this.github.pullRequest(prNumber);
    const work = await this.store.change(slot.view.workId, ownerKey(slot.owner), (item) => {
      if (item.data.questions.some((question) => !question.answer)) throw new DomainError("waiting", "Resolve pending questions first.");
      if (pr.baseRefName !== this.config.project.defaultBranch || pr.state !== "OPEN") throw new DomainError("pr", "PR must be open against the default branch.");
      item.data.pr = prNumber; item.data.head = pr.headRefOid; item.data.phase = "review";
      item.data.review = undefined;
      return item;
    });
    await this.store.create({
      title: `Review: ${work.title}`, description: `Independently review ${pr.url} at ${pr.headRefOid}.\n${work.description}`,
      acceptance: work.acceptance,
      data: { phase: "ready", rank: work.data.rank, role: "reviewer",
        reviewOf: work.id, pr: prNumber, head: pr.headRefOid,
        kind: "review", source: `review:${work.id}:${pr.headRefOid}` },
    });
    await this.finishExecution(slot);
    return work;
  }
  private async finishExecution(slot: Slot): Promise<void> {
    // Let the in-container API call receive its durable acknowledgement before shutdown.
    slot.retiring = true;
  }
  private async retireExecution(slot: Slot): Promise<void> {
    slot.stopping = true;
    await slot.execution?.stop();
    slot.execution = undefined;
    slot.credential = undefined;
    slot.owner = undefined;
    slot.retiring = false;
    slot.view = { ...slot.view, state: "idle", workId: undefined, session: undefined,
      ready: false, busy: false, terminalController: undefined };
    this.events.publish({ type: "state" });
  }
  async review(id: string, result: "approved" | "changes_requested", summary: string): Promise<Work> {
    const slot = this.slot(id);
    if (!slot.owner || !slot.view.workId || slot.config.role !== "reviewer") throw new DomainError("role", "Only a reviewer can record this result.");
    const reviewWork = await this.store.get(slot.view.workId);
    assertOwner(reviewWork, slot.owner);
    if (!reviewWork.data.reviewOf || !reviewWork.data.pr) throw new DomainError("review", "Not a review assignment.");
    const parent = await this.store.get(reviewWork.data.reviewOf);
    if (!parent.data.authorSession || parent.data.authorSession === slot.view.session) {
      throw new DomainError("independence", "Review requires a separate session from the author.");
    }
    const pr = await this.github.pullRequest(reviewWork.data.pr);
    if (pr.headRefOid !== reviewWork.data.head) throw new DomainError("stale_review", "The PR head changed during review.");
    const url = await this.github.review(pr.number, pr.headRefOid, `${result}\n\n${summary}`, reviewWork.id);
    const updated = await this.store.change(parent.id, parent.assignee ?? "", (item) => {
      if (item.data.phase !== "review") throw new DomainError("phase", "The implementation is no longer awaiting this review.");
      if (item.data.head !== pr.headRefOid) throw new DomainError("stale_review", "Implementation changed.");
      item.data.review = { head: pr.headRefOid, authorSession: item.data.authorSession!,
        reviewerSession: slot.view.session!, result, summary, githubUrl: url, humanApproved: false };
      item.data.phase = result === "approved" ? "verified" : "changes_requested";
      if (result === "changes_requested") item.data.reviewRework++;
      return item;
    });
    await this.store.change(reviewWork.id, ownerKey(slot.owner), (item) => {
      item.data.phase = "done"; item.data.finishedAt = now(); return item;
    });
    await this.finishExecution(slot);
    return updated;
  }
  async gate(workId: string, gateId: string, head: string, passed: boolean, evidence: string,
    actor: User | { agent: string }): Promise<Work> {
    const gate = this.config.project.checkpoints.find((entry) => entry.id === gateId);
    if (!gate) throw new DomainError("checkpoint", "Unknown project checkpoint.", 404);
    const human = "id" in actor;
    if (gate.humanRole && (!human || !actor.roles.includes(gate.humanRole))) {
      throw new DomainError("role", `Checkpoint ${gateId} requires the ${gate.humanRole} human role.`, 403);
    }
    return this.locks.run(`effects:${this.config.project.id}`, async () => {
      const work = await this.store.get(workId);
      if (!work.data.pr || !["review", "verified"].includes(work.data.phase)) {
        throw new DomainError("phase", "Checkpoints apply to submitted, unmerged delivery changes.");
      }
      const pr = await this.github.pullRequest(work.data.pr);
      if (head !== work.data.head || pr.headRefOid !== head) throw new DomainError("stale_gate", "Checkpoint evidence must describe the current PR head.");
      return this.store.change(workId, work.assignee ?? "", (item) => {
        item.data.gates[gateId] = { head, by: human ? actor.id : actor.agent, human, passed, evidence, at: now() };
        return item;
      });
    });
  }
  async agentGate(agentId: string, gateId: string, head: string, evidence: string): Promise<Work> {
    const slot = this.slot(agentId);
    if (!slot.view.workId || !slot.owner) throw new DomainError("unassigned", "No work assigned.");
    const work = await this.store.get(slot.view.workId);
    assertOwner(work, slot.owner);
    return this.gate(work.data.reviewOf ?? work.id, gateId, head, true, evidence, { agent: ownerKey(slot.owner) });
  }
  async verify(workId: string, approved: boolean, note: string, user: User, expectedHead?: string): Promise<Work> {
    if (!user.roles.some((role) => ["qa", "product", "developer"].includes(role))) {
      throw new DomainError("role", "QA, product, or developer role is required.", 403);
    }
    return this.locks.run(`effects:${this.config.project.id}`, async () => {
      const work = await this.store.get(workId);
      if (expectedHead && expectedHead !== work.data.head) {
        throw new DomainError("stale_verification", "The reviewed change has changed since you viewed it. Verify the new head before deciding.");
      }
      if (!approved && ["merged", "deployed", "deploying"].includes(work.data.phase)) {
        return this.store.create({ title: `Urgent verification failure: ${work.title}`,
          description: note, acceptance: "Reported regression is corrected and verified by a human.",
          data: { source: `verification:${work.id}:${work.data.head}:${createHash("sha256").update(note).digest("hex").slice(0, 16)}`,
            checkpoint: "Urgent: human triage and ranking required." } });
      }
      return this.store.change(workId, work.assignee ?? "", (item) => {
        if (!["verified", "merged", "deployed"].includes(item.data.phase)
            || !item.data.review || item.data.review.result !== "approved") {
          throw new DomainError("review", "Independent review must finish first.");
        }
        item.data.review.humanApproved = approved;
        item.data.decisions.push({ by: user.id, at: now(), text: `Verification ${approved ? "approved" : "rejected"}: ${note}` });
        if (!approved) { item.data.phase = "changes_requested"; item.data.reviewRework++; }
        return item;
      });
    });
  }
  async reassign(workId: string, user: User): Promise<Work> {
    return this.locks.run(`effects:${this.config.project.id}`, async () => {
      const item = await this.store.get(workId);
      if (!item.assignee) throw new DomainError("unassigned", "Work is already available.");
      if (finished(item) || ["deploying", "cancelled", "decomposed"].includes(item.data.phase)) {
        throw new DomainError("phase", "This package cannot be reassigned for execution.");
      }
      const changed = await this.store.change(workId, item.assignee, (work) => {
        work.data.phase = "ready"; work.data.attempts = 0; work.data.error = undefined;
        work.data.affinity = undefined;
        work.data.review = undefined;
        work.data.decisions.push({ by: user.id, at: now(), text: "Explicitly released original machine assignment." });
        return work;
      });
      for (const review of (await this.store.list()).filter((work) => work.data.reviewOf === workId && !finished(work))) {
        await this.store.change(review.id, review.assignee ?? "", (work) => {
          work.data.phase = "cancelled";
          work.data.source = `${work.data.source}:superseded:${randomUUID()}`;
          return work;
        });
      }
      return this.store.release(workId, changed.assignee!);
    });
  }
  async reconcileDeployment(workId: string, note: string, user: User): Promise<Work> {
    if (!user.roles.some((role) => this.config.project.deploymentRoles.includes(role))) {
      throw new DomainError("role", "A deployment role is required.", 403);
    }
    return this.locks.run(`effects:${this.config.project.id}`, async () => {
      const work = await this.store.get(workId);
      const deployment = work.data.deployment;
      if (!deployment || !["dispatching", "uncertain"].includes(deployment.state)) {
        throw new DomainError("deployment", "Only an ambiguous dispatch can be reconciled as absent.");
      }
      const run = await this.github.findRun(deployment.workflow, deployment.requestId);
      if (run) throw new DomainError("deployment", `A matching run exists: ${run.url}. Let Cerebra observe its outcome.`);
      return this.store.change(workId, work.assignee ?? "", (item) => {
        item.data.deployment!.state = "failed";
        item.data.phase = "merged";
        item.data.error = "Human confirmed no deployment was started. A new deployment requires fresh authorization.";
        item.data.decisions.push({ by: user.id, at: now(), text: `Reconciled absent dispatch ${deployment.requestId}: ${note}` });
        return item;
      });
    });
  }
  async cancel(workId: string, note: string, user: User): Promise<Work> {
    if (!user.roles.includes("product")) throw new DomainError("role", "A product role is required to cancel work.", 403);
    return this.locks.run(`effects:${this.config.project.id}`, async () => {
      const item = await this.store.get(workId);
      if (finished(item) || item.data.phase === "deploying") {
        throw new DomainError("phase", "Completed or deploying work cannot be cancelled through the backlog.");
      }
      const all = await this.store.list();
      const affected = new Set([workId]);
      for (let changed = true; changed;) {
        changed = false;
        for (const work of all) {
          if (!affected.has(work.id) && (affected.has(work.data.parent ?? "") || affected.has(work.data.reviewOf ?? ""))) {
            affected.add(work.id); changed = true;
          }
        }
      }
      for (const id of [...affected].reverse()) {
        const current = await this.store.get(id);
        if (finished(current) || current.data.phase === "deploying") continue;
        await this.store.change(id, current.assignee ?? "", (work) => {
          work.data.phase = "cancelled";
          work.data.decisions.push({ by: user.id, at: now(), text: `Cancelled with ${workId}: ${note}` });
          return work;
        });
      }
      return this.store.get(workId);
    });
  }
  async retry(id: string): Promise<void> {
    const slot = this.slot(id);
    if (!slot.view.workId || !slot.owner) throw new DomainError("unassigned", "Agent has no recoverable assignment.");
    await this.store.change(slot.view.workId, ownerKey(slot.owner), (work) => {
      if (!["working", "waiting", "changes_requested", "blocked"].includes(work.data.phase)) {
        throw new DomainError("phase", "This work is no longer eligible for execution recovery.");
      }
      work.data.attempts = 0; work.data.error = undefined;
      work.data.phase = work.data.questions.some((q) => !q.answer) ? "waiting" : "working";
      return work;
    });
    slot.stopping = true;
    await slot.execution?.stop();
    slot.execution = undefined;
    slot.view.error = undefined;
    slot.view.state = "idle";
  }
  async deploy(workId: string, user: User, expectedHead?: string): Promise<Work> {
    if (!user.roles.some((role) => this.config.project.deploymentRoles.includes(role))) {
      throw new DomainError("role", "You are not assigned a deployment role.", 403);
    }
    const workflow = this.config.project.deploymentWorkflow;
    if (!workflow) throw new DomainError("workflow", "Configure a project deployment workflow first.");
    return this.locks.run(`effects:${this.config.project.id}`, async () => {
      const work = await this.store.get(workId);
      if (expectedHead && expectedHead !== work.data.head) {
        throw new DomainError("stale_deployment", "The selected change changed since you viewed it. Reconfirm deployment.");
      }
      if (!["merged", "deployed"].includes(work.data.phase) || !work.data.pr) throw new DomainError("phase", "Merge the change before requesting deployment.");
      const pr = await this.github.pullRequest(work.data.pr);
      if (pr.state !== "MERGED" || !pr.mergeCommit?.oid) throw new DomainError("merge", "GitHub has not confirmed a merge commit.");
      return this.store.change(workId, work.assignee ?? "", (item) => {
        if (item.data.deployment && !["succeeded", "failed"].includes(item.data.deployment.state)) {
          throw new DomainError("deployment", "A deployment request is already outstanding.");
        }
        item.data.phase = "deploying";
        item.data.deployment = { requestedBy: user.id, requestId: randomUUID(),
          ref: pr.mergeCommit!.oid, workflow, state: "requested" };
        return item;
      });
    });
  }
  private async pollGitHub(): Promise<void> {
    for (const issue of await this.github.issues()) {
      await this.store.create({ title: issue.title, description: `${issue.body}\n\nSource: ${issue.url}`,
        acceptance: "", data: { source: issue.url } });
    }
    for (const work of await this.store.list()) {
      if (work.owner?.instance !== this.config.instance) continue;
      try {
        if (work.data.phase === "verified") await this.mergeWork(work);
        if (work.data.deployment && ["requested", "dispatching", "running", "uncertain"].includes(work.data.deployment.state)) {
          await this.deploymentWork(work);
        }
      } catch (error) {
        await this.store.change(work.id, work.assignee!, (item) => {
          item.data.error = error instanceof Error ? error.message : String(error); return item;
        });
        this.report(error);
      }
    }
  }
  private async mergeWork(work: Work): Promise<void> {
    await this.locks.run(`effects:${this.config.project.id}`, async () => {
      await this.checkPolicy();
      const current = await this.store.get(work.id);
      if (current.assignee !== work.assignee) throw new DomainError("stale_owner", "Ownership changed.");
      if (current.data.phase !== "verified") return;
      const review = current.data.review;
      if (!current.data.pr || !review || review.result !== "approved") return;
      if (this.config.project.requireVerification && !review.humanApproved) return;
      for (const gate of this.config.project.checkpoints) {
        const evidence = current.data.gates[gate.id];
        if (!evidence?.passed || evidence.head !== review.head || (gate.humanRole && !evidence.human)) return;
      }
      if (current.data.questions.some((q) => !q.answer)) return;
      const pr = await this.github.pullRequest(current.data.pr);
      if (pr.headRefOid !== review.head) {
        await this.store.change(current.id, current.assignee!, (item) => {
          item.data.phase = "changes_requested";
          item.data.reviewRework++;
          item.data.error = "The PR head changed after review. Recheck and submit for a new independent review.";
          return item;
        });
        return;
      }
      if (pr.state !== "MERGED") {
        checkMergePolicy(pr, this.config.project, review.head);
        await this.github.merge(pr.number, review.head);
      }
      await this.store.change(current.id, current.assignee!, (item) => {
        item.data.phase = "merged"; item.data.finishedAt = now(); item.data.error = undefined;
        return item;
      });
    });
  }
  private async deploymentWork(work: Work): Promise<void> {
    await this.locks.run(`effects:${this.config.project.id}`, async () => {
      await this.checkPolicy();
      const current = await this.store.get(work.id);
      if (current.assignee !== work.assignee) throw new DomainError("stale_owner", "Ownership changed.");
      const deployment = current.data.deployment!;
      if (deployment.state === "requested") {
        await this.store.change(work.id, work.assignee!, (item) => {
          item.data.deployment!.state = "dispatching"; return item;
        });
        try {
          await this.github.dispatch(deployment.workflow, deployment.ref, deployment.requestId);
        } catch (error) {
          await this.store.change(work.id, work.assignee!, (item) => {
            item.data.deployment!.state = "uncertain";
            item.data.error = "Dispatch outcome uncertain. Reconcile the GitHub run; do not blindly retry.";
            return item;
          });
          throw error;
        }
      }
      const run = await this.github.findRun(deployment.workflow, deployment.requestId);
      if (!run) return;
      await this.store.change(work.id, work.assignee!, (item) => {
        item.data.deployment!.runId = run.id;
        item.data.deployment!.url = run.url;
        item.data.deployment!.state = run.status === "completed"
          ? run.conclusion === "success" ? "succeeded" : "failed" : "running";
        if (run.status === "completed") {
          item.data.phase = run.conclusion === "success" ? "deployed" : "merged";
          item.data.error = run.conclusion === "success" ? undefined : `Deployment ended with ${run.conclusion ?? "unknown outcome"}: ${run.url}`;
        }
        return item;
      });
    });
  }
}
