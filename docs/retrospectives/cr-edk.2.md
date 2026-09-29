# cr-edk.2 — retrospective

- **Implementer:** Wolverine
- **Date:** 2026-09-29
- **PR:** #36

## Engine calls passed against a stub socket and failed against real Podman with `ECONNRESET`

**What happened.** Every `podman-engine.test.ts` case passed against a stub HTTP server on a Unix socket. Then the opt-in contract suite ran against rootless Podman 6.1.2:
`CEREBRA_TEST_PODMAN_SOCKET=… pnpm exec vitest run packages/backend/src/engine-contract.test.ts`.
The test that followed a slow `podman rm` failed with `socket hang up` (`ECONNRESET`).
**Why.** Node's global HTTP agent keeps sockets alive and reuses them. The Podman service had already closed its end of the pooled socket, so the next request written to it was reset. The stub server never closes idle connections, so it could not show this. The fix is `agent: false`, a fresh connection per call, and a unit test now counts one connection per call.
**Cost.** One extra red/green loop, about five minutes. It was caught before the PR.
**Prevent by.** Any change to `packages/backend/src/podman-engine.ts` runs the engine contract against real Podman: set `CEREBRA_TEST_PODMAN_SOCKET` as in the PR's *Validation*. Roadmap step 7's real-Podman CI job should include `engine-contract.test.ts`, not only the end-to-end stub agent.
**Seen before.** None found.
