import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Account", { exact: true }).fill("operator");
  await page.getByLabel("Password", { exact: true }).fill("browser-fixture-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});
test("shared backlog creation and ranking through the web UI", async ({ page }) => {
  await page.getByRole("button", { name: "Backlog", exact: true }).click();
  await page.getByText("Propose new work", { exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Export project summary");
  await page.getByLabel("Description", { exact: true }).fill("Provide a readable summary.");
  await page.getByLabel("Acceptance criteria", { exact: true }).fill("Summary contains current work.");
  await page.getByRole("button", { name: "Create unranked work" }).click();
  await expect(page.getByRole("button", { name: "Export project summary", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Raise Export project summary" }).click();
  await page.getByRole("button", { name: "Export project summary", exact: true }).click();
  await expect(page.getByRole("region", { name: "Work details" })).toContainText("Summary contains current work.");
});
test("human decision and streaming chat preserve one live session", async ({ page }) => {
  await page.getByRole("button", { name: /Human inbox/ }).click();
  await expect(page.getByText("Which label should the primary action use?")).toBeVisible();
  await page.getByLabel("Your decision").fill("Use Sign in.");
  await page.getByRole("button", { name: "Answer as ux" }).click();
  await expect(page.getByText("No questions awaiting attention.")).toBeVisible();
  await page.getByRole("button", { name: "Fleet", exact: true }).click();
  await page.getByRole("button", { name: /Builder 0/ }).click();
  await page.getByLabel("Message", { exact: true }).fill("Confirm the decision.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Fixture response: same live session.").last()).toBeVisible();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "Take terminal control" }).click();
  await expect(page.getByRole("button", { name: "Release terminal control" })).toBeVisible();
  await page.getByRole("button", { name: "Release terminal control" }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByText("Fixture response: same live session.").last()).toBeVisible();
});
test("operator can pause and resume without losing work", async ({ page }) => {
  await page.getByRole("button", { name: "pause", exact: true }).click();
  await expect(page.getByText("paused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "resume", exact: true }).click();
  await expect(page.getByText("running", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});
