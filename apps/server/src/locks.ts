import { createHash } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { DomainError } from "../../../packages/core/src/model.js";

export interface Locks {
  run<T>(key: string, operation: () => Promise<T>): Promise<T>;
}
export const lockName = (key: string): string =>
  `cb:${createHash("sha256").update(key).digest("hex").slice(0, 48)}`;

export class LocalLocks implements Locks {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, next);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}

export class SqlLocks implements Locks {
  constructor(private pool: Pool) {}
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const name = lockName(key);
    const connection = await this.pool.getConnection();
    let acquired = false;
    try {
      const [rows] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK(?, 15) AS acquired", [name]);
      acquired = Number(rows[0]?.acquired) === 1;
      if (!acquired) throw new DomainError("busy", "Shared coordination is busy; retry this operation.", 503);
      return await operation();
    } finally {
      if (acquired) await this.release(connection, name);
      else connection.release();
    }
  }
  private async release(connection: PoolConnection, name: string): Promise<void> {
    try { await connection.query("SELECT RELEASE_LOCK(?)", [name]); }
    finally { connection.release(); }
  }
}
