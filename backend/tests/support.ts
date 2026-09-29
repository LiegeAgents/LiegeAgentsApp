import type { PoolClient } from "pg";
import request from "supertest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { app } from "../src/app.js";
import { env } from "../src/config.js";
import { db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { creditUser, userBalance } from "../src/ledger.js";

export { db };
export const api = () => request(app);

// These tests drop and rebuild the schema, so they only run against a *_test database.
// Without one they are skipped locally, but CI must provide one.
async function checkDatabase() {
  const name = new URL(env.DATABASE_URL).pathname.slice(1);
  if (!name.endsWith("_test")) return `DATABASE_URL points at "${name}", not a *_test database`;
  return db.query("SELECT 1").then(
    () => null,
    (error: Error) => `cannot reach ${name}: ${error.message}`,
  );
}
const databaseProblem = await checkDatabase();
if (databaseProblem && process.env.CI) throw new Error(databaseProblem);
if (databaseProblem) console.warn(`Skipping database tests: ${databaseProblem}`);
export const databaseAvailable = !databaseProblem;

export async function rebuildSchema() {
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate();
}

export async function clearData() {
  const tables = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'",
  );
  const names = tables.rows.map((row) => `"${row.tablename}"`).join(", ");
  await db.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
}

export async function inTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type User = { token: string; userId: string; address: string };

export async function signIn(privateKey = generatePrivateKey()): Promise<User> {
  const account = privateKeyToAccount(privateKey);
  const nonce = await api().post("/v1/auth/nonce").send({ address: account.address }).expect(201);
  const signature = await account.signMessage({ message: nonce.body.data.message });
  const session = await api()
    .post("/v1/auth/verify")
    .send({ address: account.address, nonce: nonce.body.data.nonce, signature })
    .expect(200);
  return {
    token: session.body.data.token,
    userId: session.body.data.userId,
    address: account.address.toLowerCase(),
  };
}

export const bearer = (user: User) => ({ Authorization: `Bearer ${user.token}` });

export async function credit(userId: string, amount: number) {
  await inTransaction((client) =>
    creditUser(client, userId, amount, userId, `test-credit:${crypto.randomUUID()}`),
  );
}

export async function availableBalance(userId: string) {
  const client = await db.connect();
  try {
    return (await userBalance(client, userId)).amount;
  } finally {
    client.release();
  }
}

export async function escrowBalance(jobId: string) {
  const result = await db.query<{ balance: string }>(
    `SELECT COALESCE(sum(lp.amount_usdg), 0) AS balance FROM ledger_postings lp
     JOIN ledger_accounts la ON la.id = lp.account_id WHERE la.kind = 'escrow' AND la.job_id = $1`,
    [jobId],
  );
  return Number(result.rows[0].balance);
}

export async function createAgent(owner: User) {
  const response = await api()
    .post("/v1/agents")
    .set(bearer(owner))
    .send({
      slug: `agent-${crypto.randomUUID().slice(0, 8)}`,
      name: "Research Agent",
      description: "Produces research reports on request.",
      category: "research",
    })
    .expect(201);
  return response.body.data.id as string;
}

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

export async function createJob(client: User, agentId: string, budgetUsdg: number) {
  const response = await api()
    .post("/v1/jobs")
    .set(bearer(client))
    .send({
      agentId,
      title: "Market summary",
      brief: "Summarize this week's market moves.",
      acceptanceCriteria: ["Delivered as a written report"],
      budgetUsdg,
      deadlineAt: hoursFromNow(24),
      expiresAt: hoursFromNow(48),
    })
    .expect(201);
  return response.body.data.id as string;
}
