# cr-edk.4 — Translate Claude conversations into the shared runner protocol

## The newest Claude Agent SDK could not be installed

**What happened.** The plan pinned `@anthropic-ai/claude-agent-sdk@0.3.284`, the latest release.
`pnpm install` refused it because it was younger than the workspace's `minimumReleaseAge`. Adding
the SDK to `minimumReleaseAgeExclude` worked, but it weakens a supply-chain rule, so I reverted it
and pinned `0.3.283`.

**Why.** `pnpm-workspace.yaml` sets a minimum release age. The SDK ships almost every day, so its
latest release is usually still inside that window. The plan chose "latest" without checking.

**Cost.** One install-and-revert cycle, and a correction to the plan in the bead's design field.

**Prevent by.** The planning step of `produce-bead` (*Design the build*) should say: pin a new
dependency at the newest release older than the workspace's `minimumReleaseAge`
(`npm view <pkg> time --json`), never at "latest".

**Seen before.** No.

## Node 26 images have no corepack, so `main.Containerfile` did not build

**What happened.** Building the new agent image failed at `corepack enable`. The existing
`images/main.Containerfile` failed the same way, so it was already broken on `main`. Both now run
`npm install -g pnpm@<version>`.

**Why.** Node 25 and later no longer bundle corepack. CI checks no image build, so nothing caught
the break when the base image moved to Node 26.

**Cost.** One failed build and a diagnosis. The main image had been broken since it was written,
and nobody knew.

**Prevent by.** A CI job, or a step in `pnpm run check` when Podman is present, that builds
`images/*.Containerfile`. Roadmap step 7's real-Podman end-to-end coverage is the natural home.

**Seen before.** No.
