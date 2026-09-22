import { createApi } from "../apps/server/src/api.js";
import { Engine } from "../apps/server/src/engine.js";
import { MemoryAccounts } from "../apps/server/src/accounts.js";
import { MemoryWorkStore } from "../apps/server/src/memory-store.js";
import { LocalLocks } from "../apps/server/src/locks.js";
import type { Execution, Launch } from "../apps/server/src/runtime.js";
import { FakeGitHub, FakeRuntime, testConfig } from "./helpers.js";
import { randomUUID } from "node:crypto";

let engine: Engine;
class BrowserRuntime extends FakeRuntime {
  override async launch(input: Launch): Promise<Execution> {
    const execution = await super.launch(input);
    setTimeout(() => {
      void engine.providerEvent(input.agent.id, { type: "ready", session: input.session });
    }, 50);
    return {
      ...execution,
      write: (text) => {
        execution.write(text);
        const clean = text.replace(/\u001b\[(200|201)~/g, "").trim();
        const id = randomUUID();
        void engine.providerEvent(input.agent.id, { type: "user", id: randomUUID(), text: clean });
        setTimeout(() => {
          void engine.providerEvent(input.agent.id, { type: "delta", id, text: "Fixture response: " });
          void engine.providerEvent(input.agent.id, { type: "delta", id, text: "same live session.", final: true });
          void engine.providerEvent(input.agent.id, { type: "idle" });
          input.onTerminal("Fixture terminal output\r\n");
        }, 50);
      },
    };
  }
}
const config = testConfig();
config.port = 14545;
config.publicUrl = "http://127.0.0.1:14545";
const store = new MemoryWorkStore();
await store.create({ title: "Build accessible sign-in", description: "An example delivery item.",
  acceptance: "Keyboard navigation works", data: { phase: "ready", rank: 0 } });
await store.create({ title: "Improve profile screen", description: "Clarify profile design.", acceptance: "Design agreed" });
engine = new Engine(config, store, new BrowserRuntime(), new FakeGitHub(), new LocalLocks());
const accounts = new MemoryAccounts();
await accounts.create("operator", "browser-fixture-password", ["product", "ux", "qa"]);
const app = await createApi(engine, accounts, { staticDirectory: "dist/web" });
await app.listen({ port: config.port, host: "127.0.0.1" });
await engine.start();
await engine.ask("builder-0", "ux", "Which label should the primary action use?");
process.once("SIGTERM", () => {
  void engine.stop().then(() => app.close());
});
