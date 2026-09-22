import { call } from "./connection.mjs";

try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (input.length > 2_000_000) throw new Error("Hook input exceeds limit.");
  }
  await call("claude-hook", JSON.parse(input));
  process.stdout.write("{}");
} catch (error) {
  console.error(`Cerebra hook failed: ${error.message}`);
  process.exitCode = 1;
}
