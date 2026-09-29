import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { transfer, userBalance } from "../src/ledger.js";
import {
  api,
  availableBalance,
  bearer,
  clearData,
  createAgent,
  createJob,
  credit,
  databaseAvailable,
  db,
  escrowBalance,
  inTransaction,
  rebuildSchema,
  signIn,
} from "./support.js";

describe.skipIf(!databaseAvailable)("ledger debits", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  test("a debit waits for a concurrent debit from the same account, then sees its effect", async () => {
    const [payer, firstPayee, secondPayee] = await Promise.all([signIn(), signIn(), signIn()]);
    await credit(payer.userId, 100);
    const first = await db.connect();
    const second = await db.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const from = (await userBalance(first, payer.userId)).accountId;
      await transfer(first, {
        type: "test",
        from,
        to: (await userBalance(first, firstPayee.userId)).accountId,
        amount: 60,
      });
      const secondDebit = transfer(second, {
        type: "test",
        from,
        to: (await userBalance(second, secondPayee.userId)).accountId,
        amount: 60,
      });
      const state = await Promise.race([
        secondDebit.then(
          () => "settled",
          () => "settled",
        ),
        Bun.sleep(250).then(() => "waiting"),
      ]);
      expect(state).toBe("waiting");
      await first.query("COMMIT");
      await expect(secondDebit).rejects.toMatchObject({ code: "insufficient_balance" });
    } finally {
      // Never return a connection to the pool mid-transaction, even when an assertion fails.
      await Promise.all([first.query("ROLLBACK"), second.query("ROLLBACK")]);
      first.release();
      second.release();
    }
    expect(await availableBalance(payer.userId)).toBe(40);
  });

  test("concurrent funding requests cannot overdraw the client", async () => {
    const [client, provider] = await Promise.all([signIn(), signIn()]);
    await credit(client.userId, 100);
    // One agent per job: transitions lock the agent row too, which would serialize jobs that
    // share an agent and hide the race.
    const jobs = [
      await createJob(client, await createAgent(provider), 60),
      await createJob(client, await createAgent(provider), 60),
    ];
    const responses = await Promise.all(
      jobs.map((id) => api().post(`/v1/jobs/${id}/fund`).set(bearer(client)).send({})),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    const refused = responses.find((response) => response.status === 422)!;
    expect(refused.body.error.code).toBe("insufficient_available_balance");
    expect(await availableBalance(client.userId)).toBe(40);
    expect((await escrowBalance(jobs[0])) + (await escrowBalance(jobs[1]))).toBe(60);
  });

  test("user accounts cannot go below zero, compared at six-decimal precision", async () => {
    const [payer, payee] = await Promise.all([signIn(), signIn()]);
    await credit(payer.userId, 0.3);
    await inTransaction(async (client) => {
      const from = (await userBalance(client, payer.userId)).accountId;
      const to = (await userBalance(client, payee.userId)).accountId;
      await expect(
        transfer(client, { type: "test", from, to, amount: 0.300001 }),
      ).rejects.toMatchObject({ code: "insufficient_balance" });
      // 0.1 + 0.2 is 0.30000000000000004 as a float; the ledger stores six decimals.
      await transfer(client, { type: "test", from, to, amount: 0.1 + 0.2 });
    });
    expect(await availableBalance(payer.userId)).toBe(0);
    expect(await availableBalance(payee.userId)).toBe(0.3);
  });
});
