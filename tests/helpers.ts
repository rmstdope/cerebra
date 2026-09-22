import { validateConfig } from "../packages/core/src/config.js";
import type { GitHub, PullRequest, WorkflowRun } from "../apps/server/src/github.js";
import type { Execution, Launch, Runtime } from "../apps/server/src/runtime.js";

export function testConfig(instance = "machine-a", count = 1) {
  return validateConfig({
    instance, dataDirectory: ".cerebra-local/test",
    database: {},
    project: {
      id: "test", repository: "example/fixture", checkout: "/fixture",
      beadsDirectory: "/fixture", policy: "Humans decide UX, priority, and deployment.",
      deploymentWorkflow: "deploy.yml",
    },
    sandbox: { credentialsDirectory: "/fixture/credentials" },
    agents: Array.from({ length: count }, (_, i) => ({
      id: `builder-${i}`, name: `Builder ${i}`, role: "implementer", provider: "copilot",
      instructions: "Implement work with appropriate tests.",
    })),
    pollMs: 60_000,
  });
}
export const head = "a".repeat(40);
export class FakeGitHub implements GitHub {
  imported: Awaited<ReturnType<GitHub["issues"]>> = [];
  merges: number[] = [];
  dispatches: { workflow: string; ref: string; requestId: string }[] = [];
  reviews: string[] = [];
  failDispatch = false;
  run: WorkflowRun | null = null;
  pr: PullRequest = {
    number: 1, state: "OPEN", headRefOid: head, headRefName: "cerebra/test-1",
    baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    behindBy: 0,
    url: "https://github.com/example/fixture/pull/1", reviewDecision: "APPROVED",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  };
  async issues() { return this.imported; }
  async pullRequest() { return structuredClone(this.pr); }
  async review(_number: number, _head: string, summary: string) {
    this.reviews.push(summary);
    return `${this.pr.url}#issuecomment-1`;
  }
  async merge(number: number) {
    this.merges.push(number);
    this.pr.state = "MERGED"; this.pr.mergeCommit = { oid: "b".repeat(40) };
  }
  async dispatch(workflow: string, ref: string, requestId: string) {
    this.dispatches.push({ workflow, ref, requestId });
    if (this.failDispatch) throw new Error("Response lost after dispatch");
  }
  async findRun() { return this.run; }
}
export class FakeRuntime implements Runtime {
  launches: Launch[] = [];
  inputs: { agent: string; text: string }[] = [];
  stops: string[] = [];
  failLaunch = false;
  async preflight() {}
  async launch(input: Launch): Promise<Execution> {
    if (this.failLaunch) throw new Error("Missing Docker runtime");
    this.launches.push(input);
    return {
      session: input.session,
      write: (text) => { this.inputs.push({ agent: input.agent.id, text }); },
      resize: async () => {},
      stop: async () => { this.stops.push(input.agent.id); input.onExit(0); },
    };
  }
}
