import { readFile } from "node:fs/promises";

export async function connection() {
  const path = process.env.CEREBRA_BRIDGE_FILE;
  if (!path) throw new Error("CEREBRA_BRIDGE_FILE is required.");
  return JSON.parse(await readFile(path, "utf8"));
}
export async function call(path, body) {
  const config = await connection();
  const response = await fetch(`${config.url}/agent/${config.agent}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Cerebra ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
