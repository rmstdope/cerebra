# cr-c4f.6 — the rework-and-merge loop under real Podman in CI

## ubuntu-latest's Podman silently ignored the engine's volume subpaths

**What happened.** The first real-Podman CI run failed the existing engine contract: `/work` was
not writable. ubuntu-latest ships Podman 4.9.3, whose Docker-compatible API accepts
`VolumeOptions.Subpath` and ignores it, so every agent mount became the whole data volume.
podman-static 5.8.7 fixed the contract, but the loop's bind-backed data volume then mounted
`/work` empty. Only 6.1.2, the navigator's version, passed. Installing it also needed Ubuntu's
`podman`, `crun` and `conmon` purged (Podman found `/usr/bin/crun` first) and
`kernel.apparmor_restrict_unprivileged_userns=0` (`failed to reexec: Permission denied`).
**Why.** The engine and its contract suite had only ever run on the navigator's Podman 6.1; no
document named a minimum Podman version, and no check refuses an older one.
**Cost.** Five CI round trips, about 40 minutes.
**Prevent by.** A stated Podman version in `README.md` and architecture §5, and the engine guard
filed as cr-2co; CI's `e2e` job now pins podman-static 6.1.2.
**Seen before.** No; cr-edk.2 ran the contract only against Podman 6.1.2.

## The local Podman machine could not build the agent image

**What happened.** `podman build -f images/agent.Containerfile` was OOM-killed during
`pnpm install` on the 2 GB Podman machine, which the navigator's running instance shares. The loop
was proved locally with a throwaway stub image assembled from the host's build, and the real image
chain was first exercised in CI.
**Why.** The image's install stage needs more than the machine's memory; resizing the machine
would have stopped the navigator's instance.
**Cost.** About 30 minutes building the throwaway image; the real chain was untested until CI.
**Prevent by.** `CEREBRA_E2E_IMAGE` (README, "The loop under real Podman") names a prebuilt image;
the declared gates stay `pnpm run check` (D44).
**Seen before.** No.
