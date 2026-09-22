import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { DomainError, humanRoles, type HumanRole } from "../../../packages/core/src/model.js";
import { z } from "zod";
import type { Locks } from "./locks.js";
import type { User } from "../../../packages/core/src/protocol.js";
export type { User } from "../../../packages/core/src/protocol.js";

const scrypt = promisify(scryptCallback);
export interface Accounts {
  create(id: string, password: string, roles: HumanRole[]): Promise<User>;
  login(id: string, password: string): Promise<{ token: string; user: User }>;
  authenticate(token: string): Promise<User | null>;
  logout(token: string): Promise<void>;
  list(): Promise<User[]>;
  roles(id: string, roles: HumanRole[]): Promise<User>;
  password(id: string, password: string): Promise<void>;
}
async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) {
    throw new DomainError("password", "Passwords must contain 12 to 256 characters.", 400);
  }
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${hash.toString("hex")}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, salt, digest] = stored.split(":");
  if (algorithm !== "scrypt" || !salt || !digest) throw new Error("Invalid stored password hash.");
  const expected = Buffer.from(digest, "hex");
  const actual = await scrypt(password, salt, 64) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");
const assignmentsSchema = z.record(z.string(), z.array(z.enum(humanRoles)));

export async function migrate(pool: Pool, locks: Locks): Promise<void> {
  await locks.run("application:migration", async () => {
    // Untracked ignored tables remain durable in Dolt's working set but out of commits.
    await pool.query("INSERT INTO dolt_ignore (pattern, ignored) VALUES ('cerebra_users', true), ('cerebra_sessions', true) ON DUPLICATE KEY UPDATE ignored = true");
    await pool.query(`CREATE TABLE IF NOT EXISTS cerebra_users (
      id VARCHAR(100) PRIMARY KEY,
      password_hash VARCHAR(300) NOT NULL,
      roles TEXT NOT NULL
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cerebra_sessions (
      token_hash CHAR(64) PRIMARY KEY,
      user_id VARCHAR(100) NOT NULL,
      expires_at BIGINT NOT NULL
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cerebra_instances (
      id VARCHAR(100) PRIMARY KEY,
      project VARCHAR(100) NOT NULL,
      config_hash CHAR(64) NOT NULL,
      last_seen BIGINT NOT NULL,
      machine_key CHAR(36) NOT NULL
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cerebra_project_config (
      id VARCHAR(100) PRIMARY KEY,
      config_hash CHAR(64) NOT NULL,
      work_identity TEXT
    )`);
    const [columns] = await pool.query<RowDataPacket[]>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cerebra_instances' AND COLUMN_NAME = 'machine_key'");
    if (!columns.length) await pool.query("ALTER TABLE cerebra_instances ADD COLUMN machine_key CHAR(36) NOT NULL DEFAULT ''");
    const [identityColumns] = await pool.query<RowDataPacket[]>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cerebra_project_config' AND COLUMN_NAME = 'work_identity'");
    if (!identityColumns.length) await pool.query("ALTER TABLE cerebra_project_config ADD COLUMN work_identity TEXT");
  });
}
export class SqlAccounts implements Accounts {
  constructor(private pool: Pool, private project: string) {}
  async create(id: string, password: string, roles: HumanRole[]): Promise<User> {
    const hash = await hashPassword(password);
    const [existing] = await this.pool.query<RowDataPacket[]>("SELECT id FROM cerebra_users WHERE id = ?", [id]);
    if (existing.length) throw new DomainError("exists", "An account with this ID already exists.");
    try {
      await this.pool.query("INSERT INTO cerebra_users (id, password_hash, roles) VALUES (?, ?, ?)",
        [id, hash, JSON.stringify({ [this.project]: roles })]);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ER_DUP_ENTRY") {
        throw new DomainError("exists", "An account with this ID already exists.");
      }
      throw error;
    }
    return { id, roles };
  }
  async login(id: string, password: string): Promise<{ token: string; user: User }> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT id, password_hash, roles FROM cerebra_users WHERE id = ?", [id]);
    const row = rows[0];
    if (!row || !await verifyPassword(password, String(row.password_hash))) {
      // Equalize the expensive operation when the account doesn't exist.
      if (!row) await scrypt(password, "cerebra-unknown-account", 64);
      throw new DomainError("credentials", "Invalid account or password.", 401);
    }
    const token = randomBytes(32).toString("base64url");
    await this.pool.query("DELETE FROM cerebra_sessions WHERE expires_at < ?", [Date.now()]);
    await this.pool.query("INSERT INTO cerebra_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
      [sessionHash(token), id, Date.now() + 12 * 60 * 60_000]);
    return { token, user: this.user(row) };
  }
  async authenticate(token: string): Promise<User | null> {
    if (token.length > 100) return null;
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT u.id, u.roles FROM cerebra_users u JOIN cerebra_sessions s ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`, [sessionHash(token), Date.now()]);
    return rows[0] ? this.user(rows[0]) : null;
  }
  async logout(token: string): Promise<void> {
    await this.pool.query("DELETE FROM cerebra_sessions WHERE token_hash = ?", [sessionHash(token)]);
  }
  async list(): Promise<User[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT id, roles FROM cerebra_users");
    return rows.map((row) => this.user(row));
  }
  async roles(id: string, roles: HumanRole[]): Promise<User> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT roles FROM cerebra_users WHERE id = ?", [id]);
    if (!rows[0]) throw new DomainError("not_found", "Account not found.", 404);
    const assignments = assignmentsSchema.parse(JSON.parse(String(rows[0].roles)));
    assignments[this.project] = roles;
    await this.pool.query("UPDATE cerebra_users SET roles = ? WHERE id = ?", [JSON.stringify(assignments), id]);
    return { id, roles };
  }
  async password(id: string, password: string): Promise<void> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT id FROM cerebra_users WHERE id = ?", [id]);
    if (!rows[0]) throw new DomainError("not_found", "Account not found.", 404);
    await this.pool.query("UPDATE cerebra_users SET password_hash = ? WHERE id = ?", [await hashPassword(password), id]);
    await this.pool.query("DELETE FROM cerebra_sessions WHERE user_id = ?", [id]);
  }
  private user(row: RowDataPacket): User {
    const assignments = assignmentsSchema.parse(JSON.parse(String(row.roles)));
    return { id: String(row.id), roles: assignments[this.project] ?? [] };
  }
}

export class MemoryAccounts implements Accounts {
  private users = new Map<string, { user: User; hash: string }>();
  private sessions = new Map<string, User>();
  async create(id: string, password: string, roles: HumanRole[]): Promise<User> {
    if (this.users.has(id)) throw new DomainError("exists", "Account already exists.");
    const user = { id, roles };
    this.users.set(id, { user, hash: await hashPassword(password) });
    return user;
  }
  async login(id: string, password: string): Promise<{ token: string; user: User }> {
    const account = this.users.get(id);
    if (!account || !await verifyPassword(password, account.hash)) {
      throw new DomainError("credentials", "Invalid account or password.", 401);
    }
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, account.user);
    return { token, user: account.user };
  }
  async authenticate(token: string): Promise<User | null> { return this.sessions.get(token) ?? null; }
  async logout(token: string): Promise<void> { this.sessions.delete(token); }
  async list(): Promise<User[]> { return [...this.users.values()].map(({ user }) => user); }
  async roles(id: string, roles: HumanRole[]): Promise<User> {
    const account = this.users.get(id);
    if (!account) throw new DomainError("not_found", "Account not found.", 404);
    account.user.roles = roles;
    return account.user;
  }
  async password(id: string, password: string): Promise<void> {
    const account = this.users.get(id);
    if (!account) throw new DomainError("not_found", "Account not found.", 404);
    account.hash = await hashPassword(password);
    for (const [token, user] of this.sessions) if (user.id === id) this.sessions.delete(token);
  }
}
