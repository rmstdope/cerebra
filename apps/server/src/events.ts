import { EventEmitter } from "node:events";
import type { LiveEvent } from "../../../packages/core/src/protocol.js";
export { providerEventSchema, type ProviderEvent, type LiveEvent } from "../../../packages/core/src/protocol.js";
export class Events extends EventEmitter {
  publish(event: LiveEvent): void { this.emit("event", event); }
  subscribe(callback: (event: LiveEvent) => void): () => void {
    this.on("event", callback);
    return () => this.off("event", callback);
  }
}
