# Installing and operating Cerebra

Cerebra consists of a native Node.js engine/web server on each worker, isolated
Docker agent executions, and one shared Dolt server. Beads owns work packages.
A separate logical database on the same server holds Cerebra accounts and
installation metadata.

The first release is intended for trusted private-network teams. Read
[implementation-notes.md](implementation-notes.md) for assumptions, evidence,
and the authenticated-provider/deployment gates that still need pilot verification.

## Prerequisites

- macOS or Linux, Node.js 22+, and pnpm 11.
- Git, `gh`, and Beads with guarded update support. Linux Beads **1.3.0** was
  exercised; `cerebra doctor` checks the required flags rather than assuming any
  release is compatible.
- A shared Dolt SQL server. The local integration run used **2.3.1**; this does
  not override upstream Beads compatibility guidance or certify all Dolt versions.
  Pin a compatible version; do not automatically follow `latest`.
- Docker with a working Linux runtime. Docker Desktop or a separately configured
  Colima VM is suitable on macOS.
- Supported Claude Code and Copilot subscription accounts, provisioned by the
  installer into dedicated agent homes.
- An existing consumer Git repository with a main/default branch and a GitHub
  remote. The engine's `gh` must be authenticated for issue intake, PR operations,
  and workflow dispatch. Agents also need their own configured `gh` access.

No provider tokens are checked into the repository. No production deployment
secrets are mounted into agent containers.

### Start Docker before building or running agents

Installing the Docker CLI does not start a Docker engine. On macOS, either
launch Docker Desktop and wait until it is ready, or start a Colima VM.
For the Colima setup used during Cerebra's local verification:

```sh
# Only needed if these tools are not already installed:
brew install docker colima

# Creates the named VM on first use, or starts it again after it was stopped.
colima start --profile cerebra-release --cpu 4 --memory 8 --disk 30 --activate=false

# Select this engine for Docker and Cerebra commands in the current shell.
export DOCKER_CONTEXT=colima-cerebra-release
docker info
```

Keep that environment variable set in the shell where you build the image, log
agents in, and run Cerebra. Repeat the export in new shells, or pass
`--context colima-cerebra-release` to individual Docker commands. This avoids
changing the global default Docker context. The 4-CPU/8-GiB VM is a starting
development allocation, not sizing guidance for twenty active agents.

If Docker reports that `/var/run/docker.sock` does not exist, check both the
engine and its selected context:

```sh
colima list
docker context ls
docker --context colima-cerebra-release info
```

The default context can point to `/var/run/docker.sock` even when Colima's engine
is running under another context. A legacy-builder/Buildx deprecation warning is
separate: it is not the cause of a missing Docker socket.

On Linux, start the Docker service using your distribution's installation
instructions, configure non-root access, and confirm `docker info` succeeds.
Do not build or start Cerebra until that check works.

## 1. Build the application and agent image

```sh
pnpm install --frozen-lockfile
pnpm build

docker build -f Dockerfile.agent \
  --build-arg CLAUDE_VERSION=2.1.278 \
  --build-arg COPILOT_VERSION=1.0.86 \
  -t cerebra-agent:local .
```

The version arguments are required deliberately. The image contains the real
provider CLIs, Git, gh, build tools, and the Cerebra bridge. Projects may extend
this image with their own compilers/dependencies. Do not add privileged mode or
mount the Docker socket into an agent.

The trusted engine invokes Docker to supervise containers. Run the engine as a
normal non-root OS user with access to the intended Docker daemon. It respects
the normal `DOCKER_CONTEXT`/Docker client environment. Do not point it at a remote
daemon that cannot mount the same local task paths.

## 2. Prepare the shared work store

Run **one Dolt SQL server** for the installation. It hosts separate logical
databases: `cerebra` for accounts/application state, and `product_work` for this
consumer project's Beads work packages. Both Cerebra instances must reach this
same server, even if they connect through different SSH tunnels. Do not start an
independent database server on every worker.

For initial local use, the server can run on your laptop. For a team, put it on
an always-on machine: sleeping or stopping the database host prevents new claims
and durable updates on every worker.

### 2.1. Install Dolt on the database host

On macOS, if Dolt is not already installed:

```sh
brew install dolt
```

On Linux, install the appropriate release binary using the
[official installation instructions](https://www.dolthub.com/docs/introduction/installation/).
Check the release checksum and put the `dolt` binary on PATH.

```sh
dolt version
```

Use a Dolt version compatible with your Beads release; record that version before
onboarding other workers. Homebrew installs its current version, not necessarily
the version previously tested with Cerebra. Consult the Beads compatibility
guidance before upgrading an existing database.

This is a **native Dolt process**, separate from the Docker containers used for
agents. No DoltHub account or hosted database is required.

### 2.2. Create persistent storage and start the server

Run these commands as the normal OS account that will own the database, not as
root. Keep this data outside the Cerebra and consumer Git repositories:

```sh
mkdir -p "$HOME/.local/share/cerebra-dolt/data" \
  "$HOME/.local/share/cerebra-dolt/config"
chmod 700 "$HOME/.local/share/cerebra-dolt" \
  "$HOME/.local/share/cerebra-dolt/data" \
  "$HOME/.local/share/cerebra-dolt/config"

dolt sql-server \
  --host 127.0.0.1 \
  --port 3307 \
  --data-dir "$HOME/.local/share/cerebra-dolt/data" \
  --doltcfg-dir "$HOME/.local/share/cerebra-dolt/config" \
  --socket "$HOME/.local/share/cerebra-dolt/mysql.sock"
```

The command stays in the foreground. Leave this terminal running and use another
terminal for the next steps. Server startup messages should report a listener on
port 3307; if the command exits or reports an occupied port, resolve that before
continuing. The explicit socket path avoids colliding with another local MySQL
server's `/tmp/mysql.sock`.

The `data` directory holds the databases. The `config` directory holds Dolt
users/grants and branch-control state. **Retain both directories across restarts
and upgrades.** Starting with a different or empty configuration directory can
lose your account configuration. Do not commit these directories to Git or run
multiple Dolt server processes over the same data directory.

Binding to loopback is intentional: do not change this to `0.0.0.0` just to connect
another worker. Use the SSH-tunnel instructions below. Cerebra's current database
configuration does not expose MySQL TLS settings, so setting Dolt to require TLS
without also changing the client configuration is not a supported setup path.

### 2.3. Create database credentials

On a **fresh** Dolt server, the initial account is `root@localhost` with no
password. Bootstrap only from the database host. The following creates a
password-protected local administrator and a separate Cerebra service account,
then removes the passwordless root account. It is a first-time setup procedure,
not something to rerun on an existing installation.

Use two different generated passwords and retain them in your password manager.
In a second terminal on the database host, from the Cerebra checkout after
`pnpm install`, read them without putting their values in shell history:

```sh
printf 'New Dolt administrator password: '
read -r -s DOLT_ADMIN_PASSWORD
printf '\nNew Cerebra database password: '
read -r -s CEREBRA_DATABASE_PASSWORD
printf '\n'
export DOLT_ADMIN_PASSWORD CEREBRA_DATABASE_PASSWORD
```

The Node.js snippet uses Cerebra's already-installed MySQL client library.
Passwords are read from the environment rather than interpolated into shell
commands or written to configuration files:

```sh
node --input-type=module <<'NODE'
import mysql from "mysql2/promise";

const adminPassword = process.env.DOLT_ADMIN_PASSWORD;
const servicePassword = process.env.CEREBRA_DATABASE_PASSWORD;
if (!adminPassword || !servicePassword ||
    adminPassword.length < 16 || servicePassword.length < 16 ||
    adminPassword === servicePassword) {
  throw new Error("Supply two different generated passwords of at least 16 characters.");
}

const endpoint = { host: "127.0.0.1", port: 3307 };
let bootstrap;
let admin;
try {
  bootstrap = await mysql.createConnection({ ...endpoint, user: "root" });
  await bootstrap.query(
    "CREATE USER 'cerebra_admin'@'localhost' IDENTIFIED BY ?", [adminPassword]);
  await bootstrap.query(
    "GRANT ALL PRIVILEGES ON *.* TO 'cerebra_admin'@'localhost' WITH GRANT OPTION");
  await bootstrap.query(
    "CREATE USER 'cerebra'@'%' IDENTIFIED BY ?", [servicePassword]);
  await bootstrap.query(
    "GRANT ALL PRIVILEGES ON `cerebra`.* TO 'cerebra'@'%'");
  await bootstrap.query(
    "GRANT ALL PRIVILEGES ON `product_work`.* TO 'cerebra'@'%'");

  admin = await mysql.createConnection({
    ...endpoint, user: "cerebra_admin", password: adminPassword,
  });
  await admin.query("SELECT 1");
  await admin.query("DROP USER 'root'@'localhost'");
  console.log("Dolt accounts created; passwordless root removed.");
} catch (error) {
  console.error("Database bootstrap failed:", error.code ?? error.name);
  console.error("Inspect the account state with an administrator; do not blindly rerun bootstrap.");
  process.exitCode = 1;
} finally {
  if (bootstrap) await bootstrap.end();
  if (admin) await admin.end();
}
NODE
unset DOLT_ADMIN_PASSWORD
```

The service account has privileges only for the two named databases, including
the ability to create/migrate them. It does not receive global administration or
grant permissions. The `%` account host permits forwarded connections; it does
**not** expose the loopback-bound listener to the network. Protect the database
host's OS accounts and SSH access as well.

Do not grant workers the administrator password. For an existing managed Dolt
server, have its administrator create equivalent service-account grants instead
of running the fresh-server bootstrap. Additional consumer work databases need
their own database-specific grant.

Dolt persists `CREATE USER` and `GRANT` changes in its privilege file immediately;
there is no `FLUSH PRIVILEGES` or Git commit step. See
[Dolt access management](https://www.dolthub.com/docs/sql-reference/server/access-management/).

### 2.4. Check the service account and configure each worker

Keep `CEREBRA_DATABASE_PASSWORD` set for the engine and give Beads the same
password through its supported environment variable:

```sh
export BEADS_DOLT_PASSWORD="$CEREBRA_DATABASE_PASSWORD"
```

From the Cerebra checkout, verify that the account can connect:

```sh
node --input-type=module <<'NODE'
import mysql from "mysql2/promise";
const connection = await mysql.createConnection({
  host: "127.0.0.1", port: 3307, user: "cerebra",
  password: process.env.CEREBRA_DATABASE_PASSWORD,
});
try {
  const [rows] = await connection.query("SELECT CURRENT_USER() AS account, 1 AS ready");
  console.log(rows);
} finally {
  await connection.end();
}
NODE
```

Expected output contains `cerebra@%` and `ready: 1`. An access-denied error means
the account/password is wrong; connection-refused usually means the server or
tunnel is not running, or the port is wrong.

Use these application settings in each worker's Cerebra configuration:

```json
"database": {
  "host": "127.0.0.1",
  "port": 3307,
  "user": "cerebra",
  "passwordEnv": "CEREBRA_DATABASE_PASSWORD",
  "database": "cerebra"
}
```

These settings also work on another machine when it uses the following tunnel.
Environment variables are per shell: on every worker, load the service password
securely and set both password variables in the shell that runs Cerebra. Never
add passwords to the committed configuration.

### 2.5. Connect a second machine through SSH

On every worker that is not the database host, first open a tunnel in a separate
terminal. Replace `SSH_USER` and `DB_HOST` with the SSH account and private
hostname of the **one shared database host**:

```sh
ssh -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:3307:127.0.0.1:3307 \
  SSH_USER@DB_HOST
```

Leave it running. Both Cerebra and Beads on that worker connect to
`127.0.0.1:3307`, which now forwards to the shared server; they do not connect to
an independent local Dolt database. SSH encrypts traffic between the machines.
If port 3307 is already occupied on the worker, choose another local port in
`-L` and use that port consistently in both its Cerebra and Beads settings.

Run the service-account connection check from the worker before initializing or
bootstrapping Beads there. A sleeping worker may need its tunnel restarted after
waking; its existing work claims are not automatically released.

### 2.6. Initialize the consumer's Beads database

With the server reachable and `BEADS_DOLT_PASSWORD` set, run this **from the
consumer repository**, not the Cerebra implementation checkout unless Cerebra
itself is your consumer project:

```sh
bd init --server --external \
  --server-host 127.0.0.1 --server-port 3307 \
  --server-user cerebra --database product_work \
  --prefix product --skip-agents --non-interactive
```

Beads creates/migrates `product_work`. Later, section 4 creates/migrates the
separate `cerebra` application database. Do not point both tools at the same
logical database or manually create Beads tables.

For other clones, use Beads' non-destructive bootstrap procedure and point their
server configuration at the **same database and branch**. For example, set the
documented `BEADS_DOLT_SERVER_HOST`, `BEADS_DOLT_SERVER_PORT`,
`BEADS_DOLT_SERVER_USER`, and `BEADS_DOLT_SERVER_MODE=1` environment variables and
run `bd bootstrap --yes`. Confirm with `bd context --json` and:

```sh
bd sql 'SELECT active_branch() AS branch' --json
```

Do not use independent embedded stores with push/pull to coordinate claims.
Do not run Beads automatic lease-reclaim commands on Cerebra work. A sleeping
worker retains ownership until it returns or a human explicitly releases it.

### Stopping and restarting the database

Stop or drain the engines first when doing planned database maintenance. For
this foreground setup, press `Ctrl-C` in the Dolt terminal and wait for shutdown.
Restart with the exact command from section 2.2 and the same data/config paths;
**do not rerun account bootstrap or `bd init`**. Verify the service connection
again, restore any SSH tunnels, then resume the engines.

Closing the Dolt terminal or rebooting its host stops this manual setup. For
an always-on installation, run that same command under your OS service manager
(`launchd` on macOS or `systemd` on Linux), as the same non-root owner, with
absolute persistent paths, restart-on-failure, and retained logs. Cerebra does
not currently install that service or a backup policy for you.

## 3. Configure each engine

Copy [examples/cerebra.config.json](../examples/cerebra.config.json) to an
installation-specific path and edit it. The application does not implicitly
rewrite consumer repositories.

All relative paths are resolved against the configuration file, not the shell's
working directory. Configure:

- A unique `instance` ID and a private `dataDirectory` for this machine.
- The shared application database connection.
- The same project ID, repository, policy, default branch, and quality gates
  across all instances.
- This machine's `checkout` and `beadsDirectory` paths.
- The agent roster, names, roles, provider choices, instructions, and optional
  models. Set `providerAgent` to select a native provider agent definition from
  the consumer's `.claude/agents` or `.github/agents` configuration; provider-native
  skills remain available from the worktree. Fleet size is manual: add configured
  agents to add slots.
- CPU/memory limits for each sandbox and the local bridge address.

The example starts with five responsibilities, not twenty default executions.
Scale the roster deliberately after measuring machine and subscription capacity.
At least one implementer and an independent reviewer must be available across
the team for delivery work to progress.

One engine process serves one consumer project. For a second project on the same
machine, run another configuration with a distinct instance ID, data directory,
UI port, and bridge port. Both may share the application database and accounts;
each project has its own Beads database and role assignments.

### Network configuration

The human UI defaults to `127.0.0.1:4545`. For access from other computers, set
`host`, `publicUrl`, and `tls.cert`/`tls.key`. A non-loopback UI is rejected unless
TLS and an HTTPS public URL are configured. Browsers must use that exact public
origin; API writes and WebSocket connections enforce it.

The agent callback bridge is a separate token-authenticated HTTP listener. It
does not expose the human login or UI. Set `sandbox.engineUrl` to an address
reachable **from inside the agent container**:

- Docker Desktop commonly supports `http://host.docker.internal:4546`.
- Colima commonly requires `http://host.lima.internal:4546`.
- Native Linux may require binding `sandbox.bridgeHost` to the Docker bridge
  interface or a restricted private address rather than loopback.

Default bridge binding is loopback. If binding it more broadly, restrict access
to the local container network with host firewall rules. Execution tokens are
scoped to a current local assignment. Do not route this listener over an
untrusted network.

## 4. Initialize application data and human accounts

The application database must be distinct from the Beads database. The configured
database user needs permission to create/migrate Cerebra tables in it.

```sh
node dist/cli.js init-db --config /path/to/cerebra.config.json
node dist/cli.js migrate --config /path/to/cerebra.config.json
```

Supply the environment variable named by `database.passwordEnv` through your
local secret mechanism.

Set `CEREBRA_ACCOUNT_PASSWORD` privately, then create the first account:

```sh
node dist/cli.js account --config /path/to/cerebra.config.json \
  --id operator --roles product,ux,ui,architect,developer,qa
```

Remove that password environment variable after use. To assign an existing
account to another project's roles, use its configuration with `roles`:

```sh
node dist/cli.js roles --config /path/to/cerebra.config.json \
  --id operator --roles product,qa
node dist/cli.js password --config /path/to/cerebra.config.json --id operator
```

Password reset reads `CEREBRA_ACCOUNT_PASSWORD` and revokes existing sessions.
Accounts are shared through the database; role assignments are per project.
There is no project-read isolation in this trusted-team release.

`cerebra_users` and `cerebra_sessions` are deliberately ignored by Dolt commits.
Do not force-add them to version history. The working database still contains
sensitive data and requires normal filesystem/network protection.

## 5. Authenticate each agent

Use the isolated login shell for each enabled roster entry:

```sh
node dist/cli.js login --config /path/to/cerebra.config.json --agent builder
```

Inside it, perform the provider's supported subscription login and configure gh:

```sh
# Claude agent:
claude auth login

# Copilot agent:
copilot login --device-code

gh auth login
gh auth setup-git
exit
```

These commands require human authorization and must not be replaced with host
token extraction. Each agent has a private persistent home; configure the account
and provider policies appropriate for your team. No API-billing fallback is
performed.

An installer may alternatively provision the specifically named credential files
documented in `sandbox/launch.mjs` into that agent's credentials directory.
Interactive login is preferred over copying credentials between trust domains.
The credentials directory must exist even when provider login is already stored
in the dedicated home.

Configure Git author identity in each agent home if the consumer project does
not supply it. Provider-native instructions, skills, and project integrations
come from the isolated consumer worktree.

## 6. Check and start

```sh
node dist/cli.js doctor --config /path/to/cerebra.config.json
node dist/cli.js serve --config /path/to/cerebra.config.json
```

Start the command on each machine. Open that instance's public URL and log in.
`doctor` checks prerequisites and database/schema access; it does **not** certify
provider authentication, successful model inference, or deployment readiness.

Starting an idle planner conversation in the UI is a useful first action.
Clarify the idea, have the agent propose work with acceptance criteria, then rank
the delivery work in the Backlog view using a product-role account.

Questions appear only in the owning instance's Human inbox. Shared role members
can answer, but the first durable answer wins. Other instances cannot answer it.
Waiting retains the running CLI/container and its slot.

Human reviews happen on GitHub. Agent reviews are also recorded there.
The engine checks the reviewed head and configured GitHub gates before merging.

For additional project-specific gates, add `project.checkpoints`, for example:

```json
[
  {"id": "security", "description": "Run the project's security checks and link the evidence."},
  {"id": "staging-demo", "description": "QA accepts the staging demonstration.", "humanRole": "qa"}
]
```

These are merge prerequisites attached to the exact PR head. A reviewer may
record agent-eligible evidence through `cerebra gate`; a gate with `humanRole`
requires a person assigned that role to decide in the work detail UI. A subsequent
PR head invalidates earlier evidence. The gate records evidence, not proof that
an arbitrary command ran; approvals remain cooperative.

### Agent-facing commands

The container image installs `cerebra` as a narrow bridge to its local engine:

```text
cerebra work
cerebra backlog
cerebra checkpoint "Durable recovery context"
cerebra ask ux "Question for the UX role"
cerebra progress "Meaningful progress during a long wait"
cerebra propose '{"title":"...","description":"...","acceptance":"..."}'
cerebra refine WORK_ID '{"title":"...","description":"...","acceptance":"..."}'
cerebra decompose '[{"title":"...","description":"...","acceptance":"...","after":[]}]'
cerebra submit PR_NUMBER
cerebra review approved "Evidence and findings"
cerebra review changes_requested "Findings to address"
cerebra gate security PR_HEAD_SHA "Evidence or result link"
cerebra complete "Summary of the direct conversation"
```

`after` lists zero-based earlier entries in the decomposition. Child packages
inherit the parent's human-assigned rank. `complete` cannot bypass review and
merge for delivery packages.

Proposals/refinements may include `data.paths`, for example
`{"paths":["src/api","tests/api"]}`, to prevent concurrent overlapping work.
Use repository-relative prefixes or `*` for the whole repository, not globs.
Empty scopes are unspecified; the scheduler cannot infer unknown future edits.

## Deployments

Adapt [examples/deploy.yml](../examples/deploy.yml) in the consumer repository.
The example intentionally fails until a real project deployment step is supplied.
Keep deployment secrets in GitHub secrets, optionally protected by GitHub
environments.

The workflow must accept `cerebra_request_id` and `cerebra_commit`, include the
request ID in `run-name`, and check out the requested commit. The human requests
deployment from a merged work package in the web UI; Cerebra dispatches and
polls through gh.

If a dispatch is uncertain, inspect GitHub using the request ID. Cerebra will
adopt a matching run when it appears. It will not automatically redispatch an
ambiguous request. Do not interpret "dispatched" as "deployed"; completion depends
on the workflow's actual conclusion.

If investigation confirms no run was started, a deployment-role human may use
**Confirm dispatch did not start**, with an explanation. Cerebra checks again
for a matching run, records that decision, and returns the package to merged.
A new dispatch then requires fresh human authorization. Do not use this control
merely because a delayed GitHub run has not appeared yet.

Approval enforcement is cooperative. GitHub protections are recommended where
your team needs stronger prevention of direct agent merge/deployment.

## Recovery and operations

- **Pause:** stop new claims and automatic merge/deployment; leave sessions alive.
- **Drain:** finish existing work/reviews without new top-level delivery claims.
- **Stop:** terminate local sessions; retain durable assignments and checkpoints.
- **Retry execution:** reset a blocked local recovery incident after fixing its cause.
- **Release lost-machine assignment:** explicit human recovery when the original
  machine cannot return. The old assignment token becomes invalid.

Changing the shared project policy requires explicit adoption:

```sh
node dist/cli.js accept-policy --config /path/to/cerebra.config.json --confirm
```

Then restart all instances with matching shared configuration. Older instances
stop controlled work when they detect the mismatch. Never clone an instance's
private runtime directory to manufacture another machine with the same identity.

There is no Cerebra backup/restore feature or historical transcript archive.
Current work, questions, decisions, and checkpoints survive process restart.
Permanent disk loss can lose data. Source control is not a database backup.
Provider-native homes may contain their own transcripts and credentials; treat
them as private runtime data and manage retention separately.

## Development and verification

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

Unit/browser tests use explicitly labeled deterministic fixtures and do not call
models or modify GitHub.

The storage integration command starts its own Dolt process on an ephemeral
loopback port, creates a temporary Beads project, runs tests, and cleans up.
It requires `dolt` and `bd` on PATH. It never uses a consumer configuration.
Never point fixture tests at a real project database.

```sh
pnpm test:integration
pnpm test:docker
CEREBRA_DISTRIBUTED=1 pnpm exec vitest run tests/integration/distributed.test.ts
```

Docker tests use the built agent image. The provider-startup smoke scenario uses
`host.lima.internal` for its local callback route and exercises unauthenticated
startup, not model inference.

The advanced distributed fixture expects a dedicated Dolt server on port 13379,
databases `cerebra_spike_app`/`cerebra_spike_work`, a Beads clone at
`.cerebra-local/spike/project`, the checksum-verified Linux ARM64 Beads 1.3.0
binary in `.cerebra-local/tools/beads-linux/bd`, and a Colima-compatible
`host.lima.internal` route. It is a macOS-to-Linux validation scenario, not a
portable replacement for the ordinary CI suite.
