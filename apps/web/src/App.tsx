import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Work, Question } from "../../../packages/core/src/model.js";
import type { AgentView, User, LiveEvent, Snapshot } from "../../../packages/core/src/protocol.js";
type ChatMessage = { id: string; role: "user" | "assistant"; text: string };
type Action = (path: string, body: unknown) => Promise<boolean>;
class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json() as T & { message?: string };
  if (!response.ok) throw new ApiError(result.message ?? `Request failed (${response.status}).`, response.status);
  return result;
}
export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState<"fleet" | "backlog" | "inbox">("fleet");
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [connected, setConnected] = useState(false);
  const [controller, setController] = useState("");
  const socket = useRef<WebSocket | null>(null);
  const terminalListener = useRef<(agent: string, text: string, sequence: number) => void>(() => {});
  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api<Snapshot>("/state"));
    } catch (reason) { setError(String(reason)); }
  }, []);
  useEffect(() => {
    void api<User>("/me").then(setUser).catch((reason: unknown) => {
      setUser(null);
      if (!(reason instanceof ApiError && reason.status === 401)) setError(String(reason));
    });
  }, []);
  useEffect(() => {
    if (!user) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/events`);
      socket.current = ws;
      ws.onopen = () => { setConnected(true); void refresh(); };
      ws.onmessage = (message: MessageEvent<string>) => {
        const event = JSON.parse(message.data) as LiveEvent | { type: "connected"; controller: string };
        if (event.type === "connected") setController(event.controller);
        else if (event.type === "state") void refresh();
        else if (event.type === "error") setError(event.message);
        else if (event.type === "terminal") terminalListener.current(event.agent, event.data, event.sequence);
        else if (event.type === "provider") {
          const incoming = event.event;
          if (incoming.type === "ready") setMessages((current) => ({ ...current, [event.agent]: [] }));
          if (incoming.type === "delta" || incoming.type === "message" || incoming.type === "user") {
            setMessages((current) => {
              const entries = [...(current[event.agent] ?? [])];
              const existing = entries.findIndex((item) => item.id === incoming.id);
              const text = incoming.type === "delta" && existing >= 0 ? entries[existing]!.text + incoming.text : incoming.text;
              const entry: ChatMessage = { id: incoming.id, role: incoming.type === "user" ? "user" : "assistant", text };
              if (existing >= 0) entries[existing] = entry;
              else entries.push(entry);
              return { ...current, [event.agent]: entries.slice(-100) };
            });
          }
          if (["ready", "idle", "error"].includes(incoming.type)) void refresh();
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    const poll = setInterval(() => { void refresh(); }, 5000);
    return () => { closed = true; clearTimeout(retry); clearInterval(poll); socket.current?.close(); };
  }, [user, refresh]);
  const action: Action = async (path, body) => {
    try { setError(""); await api(path, body); await refresh(); return true; }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false; }
  };
  if (!user) return <Login onLogin={setUser} externalError={error} />;
  const agent = snapshot?.agents.find((item) => item.id === selected);
  return <div className="app">
    <header>
      <div><h1>Cerebra</h1><p>{snapshot?.project ?? "Connecting"} / {snapshot?.instance}</p></div>
      <div className="header-actions">
        <span className={`badge ${connected ? "good" : "bad"}`}>{connected ? "Live" : "Disconnected"}</span>
        <span>{user.id} <small>{user.roles.join(", ")}</small></span>
        <button onClick={() => { void api("/logout", {}).then(() => setUser(null)).catch((reason) => setError(String(reason))); }}>Sign out</button>
      </div>
    </header>
    {error && <div className="error" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
    {snapshot?.error && <div className="warning">Engine: {snapshot.error}</div>}
    <nav aria-label="Workspace">
      {(["fleet", "backlog", "inbox"] as const).map((name) =>
        <button key={name} className={tab === name ? "selected" : ""} onClick={() => setTab(name)}>
          {name === "fleet" ? "Fleet" : name === "backlog" ? "Backlog" : `Human inbox (${snapshot?.questions.length ?? 0})`}
        </button>)}
      <span className="spacer" />
      <span className="badge">{snapshot?.mode}</span>
      {(["resume", "pause", "drain", "stop"] as const).map((name) =>
        <button key={name} onClick={() => { void action("/control", { action: name }); }}>{name}</button>)}
    </nav>
    {snapshot && <section className="metrics" aria-label="Metrics">
      <Metric label="Active" value={snapshot.agents.filter((item) => item.state === "working").length} />
      <Metric label="Waiting slots" value={snapshot.metrics.waiting} />
      <Metric label="Completed work" value={snapshot.metrics.completed} />
      <Metric label="Recoveries" value={snapshot.metrics.retries} />
      <Metric label="Review rework" value={snapshot.metrics.reviewRework} />
      <Metric label="Mean cycle time" value={snapshot.metrics.cycleTimeMs === null ? "No data" : `${Math.round(snapshot.metrics.cycleTimeMs / 60_000)} min`} />
      <Metric label="Free RAM" value={`${(snapshot.metrics.memoryFree / 1024 ** 3).toFixed(1)} GB`} />
      <Metric label="CPU load / cores" value={`${snapshot.metrics.loadAverage[0]?.toFixed(1)} / ${snapshot.metrics.cpuCount}`} />
      <Metric label="Reported Copilot usage" value={snapshot.metrics.usage?.nanoAiu == null
        ? "Unknown" : `${(snapshot.metrics.usage.nanoAiu / 1e9).toFixed(3)} AIU (known)`} />
    </section>}
    <main>
      {tab === "fleet" && <div className="fleet-layout">
        <section className="agents" aria-label="Local agents">
          <h2>Local fleet</h2>
          {snapshot?.agents.map((item) => <button key={item.id} className={`agent-card ${selected === item.id ? "selected" : ""}`} onClick={() => setSelected(item.id)}>
            <strong>{item.name}</strong><span className={`badge ${item.state === "blocked" ? "bad" : ""}`}>{item.state}</span>
            <small>{item.role} / {item.provider}</small>
            <span>{item.workId ?? "No assignment"}</span>
            {item.error && <span className="inline-error">{item.error}</span>}
          </button>)}
        </section>
        <section className="conversation">
          {agent ? <>
            <div className="section-heading"><h2>{agent.name}</h2>
              <span>{agent.ready ? "Structured bridge ready" : "Waiting for provider bridge"}</span>
              {agent.state === "blocked" && <button onClick={() => { void action(`/agents/${agent.id}/retry`, {}); }}>Retry execution</button>}
            </div>
            <p><small>Reported input/output tokens: {agent.usage?.inputTokens ?? "unknown"} / {agent.usage?.outputTokens ?? "unknown"}.
              Unpriced requests: {agent.usage?.unpricedRequests ?? "unknown"}. Missing provider data is not free usage.</small></p>
            <AgentSession key={agent.id} agent={agent} messages={messages[agent.id] ?? []}
              send={(text) => action(`/agents/${agent.id}/chat`, { text, session: agent.session })}
              start={(text) => action(`/agents/${agent.id}/conversation`, { text })}
              socket={socket.current} controller={controller} listener={terminalListener} />
          </> : <div className="empty"><h2>Your local team</h2><p>Select an agent to open its live chat and terminal.</p></div>}
        </section>
      </div>}
      {tab === "backlog" && snapshot && <Backlog work={snapshot.work} revision={snapshot.rankingRevision}
        checkpoints={snapshot.checkpoints} user={user} action={action} />}
      {tab === "inbox" && <section className="inbox">
        <h2>Human attention</h2><p>Only questions owned by this instance appear here. Waiting agents retain their slots.</p>
        <div className="buttons">{snapshot && Object.entries(snapshot.metrics.attentionByRole).map(([role, count]) =>
          <span key={role} className={`badge ${count ? "bad" : ""}`}>{role}: {count}</span>)}</div>
        {!snapshot?.questions.length && <p className="empty">No questions awaiting attention.</p>}
        {snapshot?.questions.map((question) => <QuestionCard key={question.id} question={question} user={user}
          answer={(text) => action(`/work/${question.workId}/answer`, { question: question.id, answer: text })} />)}
      </section>}
    </main>
    <footer>Private, self-hosted orchestration. Approvals are cooperative. Live chat and terminal history are not archived by Cerebra.</footer>
  </div>;
}
function Login({ onLogin, externalError }: { onLogin(user: User): void; externalError?: string }) {
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try { onLogin(await api<User>("/login", { id, password })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <main className="login"><form onSubmit={(event) => { void submit(event); }}>
    <h1>Cerebra</h1><p>Your human and agent team, working together.</p>
    {(error || externalError) && <p role="alert" className="error">{error || externalError}</p>}
    <label>Account<input autoComplete="username" value={id} onChange={(event) => setId(event.target.value)} required /></label>
    <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
    <button className="primary">Sign in</button>
    <small>Ask your installation operator to create a local account.</small>
  </form></main>;
}
function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}
function AgentSession({ agent, messages, send, start, socket, controller, listener }: {
  agent: AgentView; messages: ChatMessage[]; send(text: string): Promise<boolean>;
  start(text: string): Promise<boolean>;
  socket: WebSocket | null; controller: string;
  listener: React.MutableRefObject<(agent: string, text: string, sequence: number) => void>;
}) {
  const [view, setView] = useState<"chat" | "terminal">("chat");
  const [text, setText] = useState("");
  const terminalElement = useRef<HTMLDivElement>(null);
  const ownControl = agent.terminalController === controller;
  const controlRef = useRef(ownControl);
  controlRef.current = ownControl;
  useEffect(() => {
    if (view !== "terminal" || !terminalElement.current) return;
    const terminal = new Terminal({ theme: { background: "#0b1020" }, fontSize: 13, cursorBlink: true, scrollback: 2000 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(terminalElement.current);
    fit.fit();
    let mounted = true;
    let loaded = false;
    let sequence = 0;
    const pending: { sequence: number; data: string }[] = [];
    const append = (frame: { sequence: number; data: string }) => {
      if (frame.sequence > sequence) { terminal.write(frame.data); sequence = frame.sequence; }
    };
    listener.current = (id, data, seq) => {
      if (id !== agent.id) return;
      if (!loaded) pending.push({ sequence: seq, data });
      else append({ sequence: seq, data });
    };
    void api<{ session?: string; frames: { sequence: number; data: string }[] }>(`/agents/${agent.id}/terminal`).then((snapshot) => {
      if (!mounted || snapshot.session !== agent.session) return;
      for (const frame of snapshot.frames) append(frame);
      loaded = true;
      for (const frame of pending) append(frame);
    }).catch((reason) => {
      if (!mounted) return;
      terminal.writeln(`Terminal snapshot unavailable: ${String(reason)}`);
      loaded = true;
      for (const frame of pending) append(frame);
    });
    const write = terminal.onData((data) => {
      if (controlRef.current && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
        agent: agent.id, session: agent.session, action: "input", data,
      }));
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (controlRef.current && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
        agent: agent.id, session: agent.session, action: "resize", cols: terminal.cols, rows: terminal.rows,
      }));
    });
    observer.observe(terminalElement.current);
    return () => { mounted = false; listener.current = () => {}; observer.disconnect(); write.dispose(); terminal.dispose(); };
  }, [view, agent.id, agent.session, socket, listener]);
  return <>
    <div className="session-tabs">
      <button className={view === "chat" ? "selected" : ""} onClick={() => setView("chat")}>Chat</button>
      <button className={view === "terminal" ? "selected" : ""} onClick={() => setView("terminal")}>Terminal</button>
      <small>Session {agent.session?.slice(0, 8) ?? "not running"}</small>
    </div>
    {view === "chat" ? <>
      <div className="messages" aria-live="polite">
        {!messages.length && <p className="empty">Messages stream here as the agent works. Earlier conversations are not replayed.</p>}
        {messages.map((message) => <article className={`message ${message.role}`} key={message.id}>
          <strong>{message.role === "user" ? "Human / instruction" : agent.name}</strong><pre>{message.text}</pre>
        </article>)}
      </div>
      <form className="compose" onSubmit={(event) => { event.preventDefault(); if (text.trim()) {
        void (agent.session ? send(text) : start(text)).then((success) => { if (success) setText(""); });
      } }}>
        <label className="sr-only" htmlFor="chat-message">Message</label>
        <textarea id="chat-message" value={text} onChange={(event) => setText(event.target.value)}
          placeholder={agent.busy ? "Agent is working; wait for its turn to finish" : "Message this agent"} />
        <button className="primary" disabled={(Boolean(agent.session) && !agent.ready) || agent.busy || Boolean(agent.terminalController) || !text.trim()}>
          {agent.session ? "Send" : "Start conversation"}
        </button>
      </form>
    </> : <>
      <div className="terminal-controls">
        <button disabled={!agent.session} onClick={() => socket?.send(JSON.stringify({
          agent: agent.id, session: agent.session, action: ownControl ? "release" : "acquire",
        }))}>{ownControl ? "Release terminal control" : "Take terminal control"}</button>
        <span>{ownControl ? "You control input; chat input is paused." : agent.terminalController ? "Another browser controls input." : "Read-only until you take control."}</span>
      </div>
      <div className="terminal" ref={terminalElement} />
    </>}
  </>;
}
function QuestionCard({ question, user, answer }: {
  question: Question & { workId: string; title: string }; user: User; answer(text: string): Promise<boolean>;
}) {
  const [text, setText] = useState("");
  return <article className="question">
    <span className="badge">{question.role}</span><h3>{question.title}</h3>
    <p>{question.text}</p><small>Waiting since {new Date(question.askedAt).toLocaleString()}</small>
    <form onSubmit={(event) => { event.preventDefault(); void answer(text); }}>
      <label>Your decision<textarea value={text} onChange={(event) => setText(event.target.value)} required /></label>
      <button disabled={!user.roles.includes(question.role) || !text.trim()}>Answer as {question.role}</button>
    </form>
  </article>;
}
function Backlog({ work, revision, checkpoints, user, action }: {
  work: Work[]; revision: string; checkpoints: Snapshot["checkpoints"]; user: User; action: Action;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [detail, setDetail] = useState<string>();
  const sorted = work.filter((item) => item.data.kind !== "conversation").sort((a, b) => (a.data.rank ?? Infinity) - (b.data.rank ?? Infinity));
  const selected = work.find((item) => item.id === detail);
  const move = (id: string, direction: number) => {
    const ids = sorted.filter((item) => !item.data.reviewOf && !item.data.parent).map((item) => item.id);
    const index = ids.indexOf(id);
    const target = Math.max(0, Math.min(ids.length - 1, index + direction));
    ids.splice(index, 1); ids.splice(target, 0, id);
    void action("/rank", { ids, revision });
  };
  return <section className="backlog">
    <div className="section-heading"><h2>Project backlog</h2><span>Human-ranked, shared across instances</span></div>
    <details><summary>Propose new work</summary><form className="new-work" onSubmit={(event) => {
      event.preventDefault();
      void action("/work", { title, description, acceptance }).then((success) => {
        if (success) { setTitle(""); setDescription(""); setAcceptance(""); }
      });
    }}>
      <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
      <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <label>Acceptance criteria<textarea value={acceptance} onChange={(event) => setAcceptance(event.target.value)} required /></label>
      <button>Create unranked work</button>
    </form></details>
    <div className="table-scroll"><table><thead><tr><th>Rank</th><th>Work</th><th>Phase</th><th>Owner</th><th>Priority</th></tr></thead>
      <tbody>{sorted.map((item) => <tr key={item.id}>
        <td>{item.data.rank === null ? "Unranked" : item.data.rank + 1}</td>
        <td><button className="link" onClick={() => setDetail(item.id)}>{item.title}</button><small>{item.id}</small></td>
        <td><span className="badge">{item.data.phase}</span></td><td>{item.owner ? `${item.owner.instance} / ${item.owner.agent}` : "Available"}</td>
        <td>{!item.data.reviewOf && !item.data.parent && <><button aria-label={`Raise ${item.title}`} disabled={!user.roles.includes("product")} onClick={() => move(item.id, -1)}>Up</button>
          <button aria-label={`Lower ${item.title}`} disabled={!user.roles.includes("product")} onClick={() => move(item.id, 1)}>Down</button></>}</td>
      </tr>)}</tbody></table></div>
    {selected && <WorkDetail key={selected.id} work={selected} checkpoints={checkpoints} user={user} action={action} close={() => setDetail(undefined)} />}
  </section>;
}
function WorkDetail({ work, checkpoints, user, action, close }: {
  work: Work; checkpoints: Snapshot["checkpoints"]; user: User; action: Action; close(): void;
}) {
  const [note, setNote] = useState("");
  const [description, setDescription] = useState(work.description);
  const [acceptance, setAcceptance] = useState(work.acceptance);
  return <section className="work-detail" aria-label="Work details">
    <div className="section-heading"><h2>{work.title}</h2><button onClick={close}>Close</button></div>
    <p>{work.description}</p><h3>Acceptance</h3><pre>{work.acceptance}</pre>
    {!work.owner && <details><summary>Refine this work package</summary>
      <form onSubmit={(event) => {
        event.preventDefault();
        void action(`/work/${work.id}/edit`, { title: work.title, description, acceptance });
      }}>
        <label>Work description<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <label>Work acceptance criteria<textarea value={acceptance} onChange={(event) => setAcceptance(event.target.value)} required /></label>
        <button>Save clarification</button>
      </form>
    </details>}
    <h3>Recovery checkpoint</h3><pre>{work.data.checkpoint || "No checkpoint yet."}</pre>
    {work.data.error && <p className="error">{work.data.error}</p>}
    {work.data.review && <p><a href={work.data.review.githubUrl} target="_blank" rel="noreferrer">Independent review: {work.data.review.result}</a></p>}
    {work.data.head && <p>Reviewed change: <code>{work.data.head}</code></p>}
    <label>Verification note<textarea value={note} onChange={(event) => setNote(event.target.value)} /></label>
    {checkpoints.length > 0 && <section><h3>Required project checkpoints</h3>
      {checkpoints.map((gate) => <article className="question" key={gate.id}>
        <strong>{gate.id}</strong><p>{gate.description}</p>
        <p>{work.data.gates[gate.id]?.head === work.data.head
          ? work.data.gates[gate.id]?.passed ? "Passed" : "Failed" : "Awaiting evidence for current head"}</p>
        {work.data.gates[gate.id] && <pre>{work.data.gates[gate.id]?.evidence}</pre>}
        <div className="buttons">
          {[true, false].map((passed) => <button key={String(passed)}
            disabled={!note.trim() || !work.data.head || !["review", "verified"].includes(work.data.phase)
              || Boolean(gate.humanRole && !user.roles.includes(gate.humanRole))}
            onClick={() => { void action(`/work/${work.id}/gate`, {
              gate: gate.id, head: work.data.head, passed, evidence: note,
            }); }}>{passed ? "Pass" : "Fail"} {gate.id}</button>)}
        </div>
      </article>)}
    </section>}
    <div className="buttons">
      <button disabled={!note.trim() || !work.data.head} onClick={() => { void action(`/work/${work.id}/verify`, { approved: true, note, head: work.data.head }); }}>Approve verification</button>
      <button disabled={!note.trim() || !work.data.head} onClick={() => { void action(`/work/${work.id}/verify`, { approved: false, note, head: work.data.head }); }}>Report verification failure</button>
      <button disabled={!["merged", "deployed"].includes(work.data.phase)} onClick={() => {
        if (window.confirm(`Authorize deployment of reviewed change ${work.data.head} through the project workflow?`)) {
          void action(`/work/${work.id}/deploy`, { head: work.data.head });
        }
      }}>Authorize deployment</button>
      <button disabled={!work.owner} onClick={() => {
        if (window.confirm("Release this machine's ownership? The previous execution will be invalidated.")) void action(`/work/${work.id}/reassign`, {});
      }}>Release lost-machine assignment</button>
      <button disabled={!note.trim() || ["merged", "deployed", "done", "deploying", "cancelled"].includes(work.data.phase)}
        onClick={() => {
          if (window.confirm("Cancel this work? Dependent work will remain blocked.")) void action(`/work/${work.id}/cancel`, { note });
        }}>Cancel work</button>
    </div>
    {work.data.deployment && <div>
      <p>Deployment: {work.data.deployment.state} {work.data.deployment.url && <a href={work.data.deployment.url}>GitHub run</a>}</p>
      <small>Request ID: {work.data.deployment.requestId}</small>
      {["dispatching", "uncertain"].includes(work.data.deployment.state) && <button disabled={!note.trim()} onClick={() => {
        if (window.confirm("After checking GitHub, confirm that this request did not start any deployment. A delayed run may still exist; do not use this merely because it has not appeared yet.")) {
          void action(`/work/${work.id}/reconcile-deployment`, { note });
        }
      }}>Confirm dispatch did not start</button>}
    </div>}
  </section>;
}
