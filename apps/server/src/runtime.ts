import type { AgentConfig } from "../../../packages/core/src/config.js";
import type { Work } from "../../../packages/core/src/model.js";
import type { ProviderEvent } from "./events.js";
import { randomUUID } from "node:crypto";
export type { AgentView } from "../../../packages/core/src/protocol.js";

export interface Execution {
  session: string;
  write(data: string): void;
  resize(cols: number, rows: number): Promise<void>;
  stop(): Promise<void>;
}
export interface Launch {
  agent: AgentConfig;
  work: Work;
  session: string;
  credential: string;
  onTerminal(data: string): void;
  onExit(code: number | null): void;
  onError(error: Error): void;
}
export interface Runtime {
  preflight(): Promise<void>;
  launch(input: Launch): Promise<Execution>;
}
export function eventFromClaude(value: Record<string, unknown>): ProviderEvent | null {
  const event = value.hook_event_name;
  switch (event) {
    case "SessionStart":
      return { type: "ready", session: String(value.session_id) };
    case "UserPromptSubmit":
      return { type: "user", id: randomUUID(),
        text: String(value.prompt ?? "") };
    case "MessageDisplay":
      return { type: "delta", id: String(value.message_id), text: String(value.delta ?? ""), final: value.final === true };
    case "PreToolUse":
      return { type: "tool_start", id: String(value.tool_use_id), description: String(value.tool_name) };
    case "PostToolUse":
    case "PostToolUseFailure":
      return { type: "tool_end", id: String(value.tool_use_id) };
    case "Stop":
      return { type: "idle" };
    case "StopFailure":
      return { type: "error", message: String(value.error_details ?? value.error ?? "Provider failure"), recoverable: false };
    default:
      return null;
  }
}
