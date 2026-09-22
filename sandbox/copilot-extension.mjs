import { joinSession } from "@github/copilot-sdk/extension";
import { call } from "/opt/cerebra/sandbox/connection.mjs";

const session = await joinSession({ streaming: true });
let queue = Promise.resolve();
function publish(event) {
  queue = queue.then(() => call("events", event)).catch((error) => {
    console.error(`Cerebra event delivery failed: ${error.message}`);
  });
}
session.on((event) => {
  if (event.agentId || event.data?.parentToolCallId) return;
  const data = event.data;
  switch (event.type) {
    case "user.message": publish({ type: "user", id: data.messageId ?? event.id, text: data.content }); break;
    case "assistant.message_delta":
      publish({ type: "delta", id: data.messageId, text: data.deltaContent }); break;
    case "assistant.message":
      publish({ type: "message", id: data.messageId, text: data.content }); break;
    case "assistant.turn_start": publish({ type: "busy" }); break;
    case "session.idle": publish({ type: "idle" }); break;
    case "tool.execution_start":
      publish({ type: "tool_start", id: data.toolCallId, description: data.toolName }); break;
    case "tool.execution_complete": publish({ type: "tool_end", id: data.toolCallId }); break;
    case "session.error":
      publish({ type: "error", message: data.message ?? "Copilot session error", recoverable: false }); break;
    case "assistant.usage":
      publish({ type: "usage", id: event.id, inputTokens: data.inputTokens,
        outputTokens: data.outputTokens, nanoAiu: data.copilotUsage?.totalNanoAiu }); break;
  }
});
await call("events", { type: "ready", session: session.sessionId });
