import { z } from "zod";
import type { Config } from "../../../packages/core/src/config.js";
import { DomainError } from "../../../packages/core/src/model.js";
import { runCommand, type RunCommand } from "./command.js";

const prSchema = z.object({
  number: z.number(),
  state: z.string(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  reviewDecision: z.string().nullable().optional(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  url: z.string(),
  mergeCommit: z.object({ oid: z.string() }).nullable().optional(),
  statusCheckRollup: z.array(z.object({
    status: z.string().optional(),
    conclusion: z.string().optional(),
    state: z.string().optional(),
  })).nullable().optional(),
  behindBy: z.number().int().nonnegative().default(0),
});
export type PullRequest = z.infer<typeof prSchema>;
export interface GitHub {
  issues(): Promise<{ number: number; title: string; body: string; url: string }[]>;
  pullRequest(number: number): Promise<PullRequest>;
  review(number: number, head: string, summary: string, marker: string): Promise<string>;
  merge(number: number, expectedHead: string): Promise<void>;
  dispatch(workflow: string, ref: string, requestId: string): Promise<void>;
  findRun(workflow: string, requestId: string): Promise<WorkflowRun | null>;
}
export interface WorkflowRun {
  id: number; url: string; status: string; conclusion: string | null;
}
export class GhClient implements GitHub {
  constructor(private project: Config["project"], private run: RunCommand = runCommand) {}
  private gh(args: string[], input?: unknown): Promise<string> {
    return this.run("gh", args, {
      cwd: this.project.checkout,
      input: input === undefined ? undefined : JSON.stringify(input),
      env: { GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
    });
  }
  async issues(): Promise<{ number: number; title: string; body: string; url: string }[]> {
    const pages: unknown = JSON.parse(await this.gh([
      "api", "--paginate", "--slurp", `repos/${this.project.repository}/issues?state=open&per_page=100`,
    ]));
    const schema = z.array(z.array(z.object({
      number: z.number(), title: z.string(), body: z.string().nullable(),
      html_url: z.string(), pull_request: z.unknown().optional(),
    })));
    return schema.parse(pages).flat().filter((issue) => !issue.pull_request)
      .map((issue) => ({ number: issue.number, title: issue.title, body: issue.body ?? "", url: issue.html_url }));
  }
  async pullRequest(number: number): Promise<PullRequest> {
    const pr = prSchema.parse(JSON.parse(await this.gh([
      "pr", "view", String(number), "--repo", this.project.repository, "--json",
      "number,state,headRefOid,baseRefName,headRefName,reviewDecision,mergeable,mergeStateStatus,url,mergeCommit,statusCheckRollup",
    ])));
    if (this.project.requireRebase && pr.state === "OPEN") {
      const comparison = z.object({ behind_by: z.number().int().nonnegative() }).parse(JSON.parse(
        await this.gh(["api", `repos/${this.project.repository}/compare/${encodeURIComponent(this.project.defaultBranch)}...${pr.headRefOid}`])));
      pr.behindBy = comparison.behind_by;
    }
    return pr;
  }
  async review(number: number, head: string, summary: string, marker: string): Promise<string> {
    const markerText = `<!-- cerebra-review:${marker}:${head} -->`;
    const endpoint = `repos/${this.project.repository}/issues/${number}/comments`;
    const pages = z.array(z.array(z.object({ body: z.string(), html_url: z.string() })))
      .parse(JSON.parse(await this.gh(["api", "--paginate", "--slurp", endpoint])));
    const existing = pages.flat().find((comment) => comment.body.includes(markerText));
    if (existing) return existing.html_url;
    const result = z.object({ html_url: z.string() }).parse(JSON.parse(await this.gh([
      "api", endpoint, "--method", "POST", "--input", "-",
    ], { body: `${markerText}\n## Cerebra independent agent review\n\nCommit: \`${head}\`\n\n${summary}` })));
    return result.html_url;
  }
  async merge(number: number, expectedHead: string): Promise<void> {
    await this.gh(["pr", "merge", String(number), "--repo", this.project.repository,
      "--squash", "--match-head-commit", expectedHead]);
  }
  async dispatch(workflow: string, ref: string, requestId: string): Promise<void> {
    await this.gh(["workflow", "run", workflow, "--repo", this.project.repository,
      "--ref", this.project.defaultBranch, "-f", `cerebra_request_id=${requestId}`, "-f", `cerebra_commit=${ref}`]);
  }
  async findRun(workflow: string, requestId: string): Promise<WorkflowRun | null> {
    const runs = z.array(z.object({
      databaseId: z.number(), displayTitle: z.string(), url: z.string(),
      status: z.string(), conclusion: z.string().nullable(),
    })).parse(JSON.parse(await this.gh(["run", "list", "--repo", this.project.repository,
      "--workflow", workflow, "--event", "workflow_dispatch", "--limit", "100",
      "--json", "databaseId,displayTitle,url,status,conclusion"])));
    const run = runs.find((item) => item.displayTitle.includes(requestId));
    return run ? { id: run.databaseId, url: run.url, status: run.status, conclusion: run.conclusion } : null;
  }
}
export function checkMergePolicy(pr: PullRequest, project: Config["project"], reviewedHead: string): void {
  if (pr.state !== "OPEN") throw new DomainError("pr_state", "The pull request is not open.");
  if (pr.headRefOid !== reviewedHead) throw new DomainError("stale_review", "The PR changed after review; independent review must run again.");
  if (pr.baseRefName !== project.defaultBranch) throw new DomainError("base_branch", "The PR does not target the configured default branch.");
  if (pr.mergeable !== "MERGEABLE") throw new DomainError("merge_conflict", "GitHub has not confirmed the PR is mergeable.");
  if (["BLOCKED", "DIRTY", "DRAFT", "UNKNOWN"].includes(pr.mergeStateStatus)) {
    throw new DomainError("github_gate", `GitHub merge state is ${pr.mergeStateStatus}.`);
  }
  if (project.requireRebase && (pr.behindBy > 0 || pr.mergeStateStatus === "BEHIND")) {
    throw new DomainError("rebase_required", "Update the branch against main before merging.");
  }
  if (project.requireHumanReview && pr.reviewDecision !== "APPROVED") {
    throw new DomainError("human_review", "GitHub human review approval is required.");
  }
  if (project.requireCI) {
    const checks = pr.statusCheckRollup ?? [];
    if (!checks.length || checks.some((check) => check.state
      ? check.state !== "SUCCESS"
      : check.status !== "COMPLETED" || !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? ""))) {
      throw new DomainError("ci", "All configured GitHub checks must finish successfully.");
    }
  }
}
