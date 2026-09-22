import { describe, expect, it, vi } from "vitest";
import { checkMergePolicy, GhClient } from "../apps/server/src/github.js";
import { FakeGitHub, head, testConfig } from "./helpers.js";
import type { RunCommand } from "../apps/server/src/command.js";

describe("GitHub policy and idempotency boundaries", () => {
  it("requires review for the current head, up-to-date branches, and configured gates", () => {
    const config = testConfig();
    const pr = new FakeGitHub().pr;
    expect(() => checkMergePolicy(pr, config.project, head)).not.toThrow();
    expect(() => checkMergePolicy(pr, config.project, "c".repeat(40))).toThrow("changed after review");
    expect(() => checkMergePolicy({ ...pr, behindBy: 1 }, config.project, head)).toThrow("Update the branch");
    config.project.requireRebase = false;
    expect(() => checkMergePolicy({ ...pr, behindBy: 1 }, config.project, head)).not.toThrow();
    config.project.requireCI = true;
    expect(() => checkMergePolicy({ ...pr, statusCheckRollup: [] }, config.project, head)).toThrow("checks");
    config.project.requireHumanReview = true;
    expect(() => checkMergePolicy({ ...pr, reviewDecision: "REVIEW_REQUIRED" }, config.project, head)).toThrow("human review");
  });
  it("dispatches a branch-based workflow with the exact authorized deployment commit as input", async () => {
    const run = vi.fn<RunCommand>().mockResolvedValue("");
    await new GhClient(testConfig().project, run).dispatch("deploy.yml", head, "request-123");
    expect(run.mock.calls[0]?.[1]).toEqual([
      "workflow", "run", "deploy.yml", "--repo", "example/fixture", "--ref", "main",
      "-f", "cerebra_request_id=request-123", "-f", `cerebra_commit=${head}`,
    ]);
  });
  it("reuses a published review marker after ambiguous completion", async () => {
    const run = vi.fn<RunCommand>().mockResolvedValue(JSON.stringify([[{
      body: `<!-- cerebra-review:review-1:${head} -->`, html_url: "https://github.com/example/fixture/pull/1#comment",
    }]]));
    const url = await new GhClient(testConfig().project, run).review(1, head, "Review", "review-1");
    expect(url).toContain("#comment");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
