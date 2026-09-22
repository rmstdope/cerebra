import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { z, ZodError } from "zod";
import type { WebSocket } from "ws";
import { createWorkSchema, DomainError, idSchema, roleSchema, textSchema } from "../../../packages/core/src/model.js";
import type { Accounts, User } from "./accounts.js";
import type { Engine } from "./engine.js";
import { providerEventSchema } from "./events.js";
import { eventFromClaude } from "./runtime.js";

declare module "fastify" {
  interface FastifyRequest { cerebraUser?: User }
}
function user(request: FastifyRequest): User {
  if (!request.cerebraUser) throw new DomainError("login", "Login required.", 401);
  return request.cerebraUser;
}
function errors(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "validation", message: error.message });
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.code, message: error.message });
    if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
        && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: "request", message: error.message });
    }
    request.log.error(error, "Request failed");
    return reply.code(500).send({ error: "internal", message: "The operation failed. Check the engine log and retry only after resolving the cause." });
  });
}
export async function createApi(engine: Engine, accounts: Accounts, options: { staticDirectory?: string; logger?: boolean } = {}) {
  const tls = engine.config.tls ? {
    cert: await readFile(engine.config.tls.cert), key: await readFile(engine.config.tls.key),
  } : undefined;
  const app = Fastify({
    logger: options.logger ?? false, bodyLimit: 100_000,
    serverFactory: (handler) => tls ? httpsServer(tls, handler) : httpServer(handler),
  });
  errors(app);
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(websocket, { options: { maxPayload: 100_000 } });
  const sockets = new Map<string, Set<WebSocket>>();
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'");
    reply.header("cache-control", "no-store");
    const url = request.routeOptions.url;
    if (!url?.startsWith("/api/")) return;
    if (request.method !== "GET" || request.headers.upgrade === "websocket") {
      if (request.headers.origin !== new URL(engine.config.publicUrl).origin) {
        throw new DomainError("origin", "Request origin does not match this instance.", 403);
      }
    }
    if (url === "/api/login") return;
    const token = request.cookies.cerebra;
    const account = token ? await accounts.authenticate(token) : null;
    if (!account) throw new DomainError("login", "Login required.", 401);
    request.cerebraUser = account;
  });
  app.get("/health", async () => ({ status: "ok", instance: engine.config.instance }));
  app.post("/api/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = z.object({ id: idSchema, password: z.string().min(1).max(256) }).parse(request.body);
    const login = await accounts.login(body.id, body.password);
    reply.setCookie("cerebra", login.token, {
      httpOnly: true, sameSite: "strict", secure: Boolean(tls),
      path: "/", maxAge: 12 * 60 * 60,
    });
    return login.user;
  });
  app.post("/api/logout", async (request, reply) => {
    await accounts.logout(request.cookies.cerebra!);
    for (const socket of sockets.get(request.cookies.cerebra!) ?? []) socket.close(1008, "Signed out");
    reply.clearCookie("cerebra", { path: "/" });
    return { ok: true };
  });
  app.get("/api/me", async (request) => user(request));
  app.get("/api/state", async () => engine.snapshot());
  app.get("/api/users", async () => accounts.list());
  app.post("/api/work", async (request) => engine.create(createWorkSchema.parse(request.body)));
  app.post("/api/work/:id/edit", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    return engine.editWork(id, createWorkSchema.parse(request.body));
  });
  app.post("/api/rank", async (request) => {
    const body = z.object({ ids: z.array(idSchema).min(1).max(10_000), revision: z.string().length(64) }).parse(request.body);
    await engine.rank(body.ids, user(request), body.revision);
    return { ok: true };
  });
  app.post("/api/control", async (request) => {
    const body = z.object({ action: z.enum(["pause", "resume", "drain", "stop"]) }).parse(request.body);
    await engine.control(body.action);
    return { ok: true };
  });
  app.post("/api/work/:id/answer", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const body = z.object({ question: z.string().uuid(), answer: textSchema }).parse(request.body);
    return engine.answer(id, body.question, body.answer, user(request));
  });
  app.post("/api/work/:id/verify", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const body = z.object({ approved: z.boolean(), note: textSchema, head: z.string().regex(/^[a-f0-9]{40}$/) }).parse(request.body);
    return engine.verify(id, body.approved, body.note, user(request), body.head);
  });
  app.post("/api/work/:id/gate", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const body = z.object({ gate: idSchema, head: z.string().regex(/^[a-f0-9]{40}$/),
      passed: z.boolean(), evidence: textSchema }).parse(request.body);
    return engine.gate(id, body.gate, body.head, body.passed, body.evidence, user(request));
  });
  app.post("/api/work/:id/reassign", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    return engine.reassign(id, user(request));
  });
  app.post("/api/work/:id/cancel", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const { note } = z.object({ note: textSchema }).parse(request.body);
    return engine.cancel(id, note, user(request));
  });
  app.post("/api/work/:id/deploy", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const { head } = z.object({ head: z.string().regex(/^[a-f0-9]{40}$/) }).parse(request.body);
    return engine.deploy(id, user(request), head);
  });
  app.post("/api/work/:id/reconcile-deployment", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const { note } = z.object({ note: textSchema }).parse(request.body);
    return engine.reconcileDeployment(id, note, user(request));
  });
  app.post("/api/agents/:id/retry", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    await engine.retry(id);
    return { ok: true };
  });
  app.post("/api/agents/:id/chat", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const { text, session } = z.object({ text: textSchema, session: z.string().uuid() }).parse(request.body);
    await engine.chat(id, text, session);
    return { ok: true };
  });
  app.post("/api/agents/:id/conversation", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const { text } = z.object({ text: textSchema }).parse(request.body);
    return engine.conversation(id, text, user(request));
  });
  app.get("/api/agents/:id/terminal", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    return engine.terminalSnapshot(id);
  });
  app.get("/api/events", { websocket: true }, (socket, request) => {
    const token = request.cookies.cerebra!;
    const sessions = sockets.get(token) ?? new Set<WebSocket>();
    sessions.add(socket);
    sockets.set(token, sessions);
    const controller = `${user(request).id}:${randomUUID()}`;
    socket.send(JSON.stringify({ type: "connected", controller }));
    const unsubscribe = engine.events.subscribe((event) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > 2 * 1024 * 1024) {
        socket.close(1013, "Client is too slow; reconnect.");
        return;
      }
      socket.send(JSON.stringify(event));
    });
    let queue = Promise.resolve();
    const expiry = setInterval(() => {
      void accounts.authenticate(token).then((account) => {
        if (!account) socket.close(1008, "Session expired");
      }).catch((error: unknown) => {
        request.log.error(error, "WebSocket authentication check failed");
        socket.close(1011, "Authentication service unavailable");
      });
    }, 15_000);
    socket.on("message", (message) => {
      queue = queue.then(async () => {
        const token = request.cookies.cerebra;
        if (!token || !await accounts.authenticate(token)) {
          socket.close(1008, "Session expired"); return;
        }
        const data = z.object({
          agent: idSchema, action: z.enum(["acquire", "release", "input", "resize"]),
          session: z.string().uuid(),
          data: z.string().max(16_384).optional(),
          cols: z.number().int().min(10).max(500).optional(),
          rows: z.number().int().min(5).max(200).optional(),
        }).parse(JSON.parse(message.toString()));
        if (engine.terminalSnapshot(data.agent).session !== data.session) {
          throw new DomainError("session", "The terminal session changed. Refresh before controlling it.");
        }
        await engine.terminal(data.agent, controller, data.action, data.data, data.cols, data.rows);
      }).catch((error: unknown) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
        }
      });
    });
    socket.on("close", () => {
      clearInterval(expiry);
      sessions.delete(socket);
      if (!sessions.size) sockets.delete(token);
      unsubscribe();
      engine.releaseController(controller);
    });
  });
  if (options.staticDirectory) {
    await app.register(staticFiles, { root: resolve(options.staticDirectory) });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}

export async function createAgentApi(engine: Engine) {
  const app = Fastify({ bodyLimit: 2_000_000 });
  errors(app);
  await app.register(rateLimit, { max: 5000, timeWindow: "1 minute" });
  app.addHook("onRequest", async (request) => {
    const { id } = z.object({ id: idSchema }).parse(request.params);
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) throw new DomainError("unauthorized", "Execution credential required.", 401);
    const route = request.routeOptions.url;
    if (route === "/agent/:id/events" || route === "/agent/:id/claude-hook") {
      engine.authenticateExecution(id, authorization.slice(7));
    } else await engine.authorizedAgent(id, authorization.slice(7));
  });
  const localAgent = (request: FastifyRequest) => z.object({ id: idSchema }).parse(request.params).id;
  app.post("/agent/:id/work", async (request) => {
    return engine.authorizedAgent(localAgent(request), request.headers.authorization!.slice(7));
  });
  app.post("/agent/:id/backlog", async () => engine.store.list());
  app.post("/agent/:id/events", async (request) => {
    await engine.providerEvent(localAgent(request), providerEventSchema.parse(request.body), request.headers.authorization!.slice(7));
    return { ok: true };
  });
  app.post("/agent/:id/claude-hook", async (request) => {
    const body = z.record(z.string(), z.unknown()).parse(request.body);
    const event = eventFromClaude(body);
    if (event) await engine.providerEvent(localAgent(request), event, request.headers.authorization!.slice(7));
    return { ok: true };
  });
  app.post("/agent/:id/checkpoint", async (request) => {
    const { text } = z.object({ text: textSchema }).parse(request.body);
    return engine.checkpoint(localAgent(request), text);
  });
  app.post("/agent/:id/progress", async (request) => {
    const { text } = z.object({ text: textSchema }).parse(request.body);
    await engine.providerEvent(localAgent(request), { type: "progress", description: text });
    return { ok: true };
  });
  app.post("/agent/:id/ask", async (request) => {
    const body = z.object({ role: roleSchema, text: textSchema }).parse(request.body);
    return engine.ask(localAgent(request), body.role, body.text);
  });
  app.post("/agent/:id/submit", async (request) => {
    const { pr } = z.object({ pr: z.number().int().positive() }).parse(request.body);
    return engine.submit(localAgent(request), pr);
  });
  app.post("/agent/:id/review", async (request) => {
    const body = z.object({ result: z.enum(["approved", "changes_requested"]), summary: textSchema }).parse(request.body);
    return engine.review(localAgent(request), body.result, body.summary);
  });
  app.post("/agent/:id/gate", async (request) => {
    const body = z.object({ gate: idSchema, head: z.string().regex(/^[a-f0-9]{40}$/), evidence: textSchema }).parse(request.body);
    return engine.agentGate(localAgent(request), body.gate, body.head, body.evidence);
  });
  app.post("/agent/:id/propose", async (request) => engine.create(createWorkSchema.parse(request.body)));
  app.post("/agent/:id/complete", async (request) => {
    const { summary } = z.object({ summary: textSchema }).parse(request.body);
    return engine.complete(localAgent(request), summary);
  });
  app.post("/agent/:id/refine", async (request) => {
    const body = z.object({ work: idSchema, input: createWorkSchema }).parse(request.body);
    return engine.editWork(body.work, body.input);
  });
  app.post("/agent/:id/decompose", async (request) => {
    const body = z.array(createWorkSchema.extend({
      after: z.array(z.number().int().nonnegative()).default([]),
    })).min(1).max(50).parse(request.body);
    return engine.decompose(localAgent(request), body);
  });
  return app;
}
