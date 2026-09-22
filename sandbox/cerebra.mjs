#!/usr/bin/env node
import { call } from "./connection.mjs";

const [command, ...args] = process.argv.slice(2);
try {
  let result;
  switch (command) {
    case "work": result = await call("work", {}); break;
    case "backlog": result = await call("backlog", {}); break;
    case "checkpoint": result = await call("checkpoint", { text: args.join(" ") }); break;
    case "ask": result = await call("ask", { role: args[0], text: args.slice(1).join(" ") }); break;
    case "progress": result = await call("progress", { text: args.join(" ") || "Working" }); break;
    case "submit": result = await call("submit", { pr: Number(args[0]) }); break;
    case "complete": result = await call("complete", { summary: args.join(" ") }); break;
    case "refine": result = await call("refine", { work: args[0], input: JSON.parse(args.slice(1).join(" ")) }); break;
    case "decompose": result = await call("decompose", JSON.parse(args.join(" "))); break;
    case "review": result = await call("review", { result: args[0], summary: args.slice(1).join(" ") }); break;
    case "gate": result = await call("gate", { gate: args[0], head: args[1], evidence: args.slice(2).join(" ") }); break;
    case "propose": {
      const input = JSON.parse(args.join(" "));
      result = await call("propose", input);
      break;
    }
    default:
      throw new Error("Usage: cerebra work|backlog|checkpoint TEXT|ask ROLE QUESTION|progress TEXT|submit PR|review approved|changes_requested SUMMARY|gate ID HEAD EVIDENCE|propose JSON|refine ID JSON|decompose JSON_ARRAY|complete SUMMARY");
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
