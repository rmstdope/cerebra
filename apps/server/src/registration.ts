import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type { Config } from "../../../packages/core/src/config.js";
import type { Locks } from "./locks.js";

export function policyHash(config: Config): string {
  const { checkout: _checkout, beadsDirectory: _beadsDirectory, ...shared } = config.project;
  return createHash("sha256").update(JSON.stringify(shared)).digest("hex");
}
export async function registerInstance(config: Config, pool: Pool, locks: Locks): Promise<() => Promise<void>> {
  const path = resolve(config.dataDirectory, `${config.instance}.identity`);
  let identity: string;
  try { identity = (await readFile(path, "utf8")).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    identity = randomUUID();
    await writeFile(path, identity, { flag: "wx", mode: 0o600 });
  }
  const hash = policyHash(config);
  await locks.run(`registration:${config.instance}`, async () => {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT machine_key FROM cerebra_instances WHERE id = ?", [config.instance]);
    if (rows[0] && rows[0].machine_key !== identity) {
      throw new Error("This instance ID belongs to a different machine. Choose a new ID; use explicit work reassignment for a lost machine.");
    }
    await pool.query(`INSERT INTO cerebra_instances (id, project, config_hash, last_seen, machine_key)
      VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE last_seen = ?, config_hash = ?`,
    [config.instance, config.project.id, hash, Date.now(), identity, Date.now(), hash]);
  });
  return async () => {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT config_hash FROM cerebra_project_config WHERE id = ?", [config.project.id]);
    if (!rows[0] || rows[0].config_hash !== hash) throw new Error("Project policy changed. Restart this instance with the agreed configuration.");
    await pool.query("UPDATE cerebra_instances SET last_seen = ? WHERE id = ? AND machine_key = ?", [Date.now(), config.instance, identity]);
  };
}
