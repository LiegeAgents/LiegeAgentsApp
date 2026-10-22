import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { keccak256, toHex } from "viem";
import {
  api,
  bearer,
  clearData,
  createAgent,
  credit,
  databaseAvailable,
  db,
  rebuildSchema,
  signIn,
} from "./support.js";
import { createWebhookSubscription } from "../src/webhooks.js";
import { chainRpc, processChainTriggers } from "../src/chainTriggers.js";

// One scanning pass; results are loosely typed so tests can read `fired` directly.
const poll = () => processChainTriggers() as Promise<any[]>;

const token = "0xc32ab2e562ade6fba6d3d1e3960d49b0957ef645";
const whale = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const transferTopic = keccak256(toHex("Transfer(address,address,uint256)"));
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}` as const;
const topicFor = (address: string) => `0x${address.slice(2).padStart(64, "0")}` as const;
// "LIEGE" as an ABI-encoded string.
const symbolResult = `0x${"20".padStart(64, "0")}${"5".padStart(64, "0")}${Buffer.from("LIEGE").toString("hex").padEnd(64, "0")}`;

describe.skipIf(!databaseAvailable)("onchain triggers", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  let head = 1000n;
  let logs: object[] = [];
  let tx = 0;
  let rpc: ReturnType<typeof spyOn>;
  beforeEach(() => {
    head = 1000n;
    logs = [];
    rpc = spyOn(chainRpc, "call").mockImplementation(async (method: string, params: any[]) => {
      if (method === "eth_blockNumber") return toHex(head);
      if (method === "eth_getCode")
        return params[0] === token || params[0].startsWith("0x9") ? "0x6080" : "0x";
      if (method === "eth_call") return params[0].data === "0x313ce567" ? word(18n) : symbolResult;
      if (method === "eth_getLogs") {
        const { fromBlock, toBlock } = params[0];
        return logs.filter(
          (log: any) =>
            BigInt(log.blockNumber) >= BigInt(fromBlock) &&
            BigInt(log.blockNumber) <= BigInt(toBlock),
        );
      }
      throw new Error(`unexpected ${method}`);
    });
  });
  afterEach(() => rpc.mockRestore());

  const transferLog = (block: bigint, from: string, to: string, tokens: number) => ({
    address: token,
    topics: [transferTopic, topicFor(from), topicFor(to)],
    data: word(BigInt(tokens) * 10n ** 18n),
    blockNumber: toHex(block),
    transactionHash: `0x${(++tx).toString(16).padStart(64, "0")}`,
    logIndex: "0x0",
  });

  async function fixture() {
    const [owner, client] = await Promise.all([signIn(), signIn()]);
    const agentId = await createAgent(owner);
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: "research-brief",
          name: "Research brief",
          description: "A cited research brief.",
          serviceType: "skill",
          priceUsd: 3,
          slaMinutes: 60,
        })
        .expect(201)
    ).body.data;
    const hook = await createWebhookSubscription(owner.userId, agentId, "https://8.8.8.8/hook", [
      "job.funded",
    ]);
    await db.query(
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at, settlement_assets)
       VALUES ($1,$2,$3,true,now(),$4)`,
      [agentId, service.id, hook.id, ["usdg"]],
    );
    return { owner, client, agentId };
  }

  const create = (user: { token: string; userId: string; address: string }, body: object) =>
    api().post("/v1/super-agents/chain-triggers").set(bearer(user)).send(body);

  test("validates the contract and event, then watches from the current block", async () => {
    const { client, agentId } = await fixture();
    const base = { agentId, contract: token, budgetAmount: 3, spendCap: 9 };
    expect((await create(client, { ...base, contract: other }).expect(422)).body.error.code).toBe(
      "not_a_contract",
    );
    expect(
      (await create(client, { ...base, kind: "contract_event" }).expect(400)).body.error.code,
    ).toBeDefined();
    expect(
      (
        await create(client, {
          ...base,
          kind: "contract_event",
          eventSignature: "not an event(",
        }).expect(422)
      ).body.error.code,
    ).toBe("invalid_event_signature");
    await create(client, { ...base, spendCap: 2 }).expect(400);
    await api().post("/v1/super-agents/chain-triggers").send(base).expect(401);
    const created = (await create(client, { ...base, minAmount: 1_000_000 }).expect(201)).body.data;
    expect(created).toMatchObject({
      kind: "token_transfer",
      contract_address: token,
      token_symbol: "LIEGE",
      token_decimals: 18,
      last_block: "997",
      status: "active",
      explorerUrl: `https://robinhoodchain.blockscout.com/address/${token}`,
    });
  });

  test("a large transfer opens one job within the limits and tells the client to fund it", async () => {
    const { client, agentId } = await fixture();
    const trigger = (
      await create(client, {
        agentId,
        contract: token,
        minAmount: 1_000_000,
        budgetAmount: 3,
        spendCap: 9,
      }).expect(201)
    ).body.data;
    logs = [
      transferLog(998n, whale, other, 5), // below the minimum
      transferLog(999n, whale, other, 1_500_000),
      transferLog(1000n, other, whale, 2_000_000),
      transferLog(1003n, whale, other, 9_000_000), // not yet confirmed
    ];
    head = 1003n;
    const [run] = await poll();
    expect(run).toMatchObject({ triggerId: trigger.id, from: "998", to: "1000", skipped: 1 });
    expect(run.fired).toMatchObject({ outcome: "awaiting_funding" });
    expect(run.fired.summary).toBe("1,500,000 LIEGE moved from 0x1111…1111 to 0x2222…2222");

    const listed = (
      await api().get("/v1/super-agents/chain-triggers").set(bearer(client)).expect(200)
    ).body.data[0];
    expect(listed).toMatchObject({
      runs_count: 1,
      skipped_count: 1,
      committed_amount: "3.000000000000000000",
      last_block: "1000",
    });
    expect(listed.runs[0]).toMatchObject({ outcome: "awaiting_funding", job_status: "open" });
    const job = (
      await db.query("SELECT budget_amount, title, strategy_policy FROM jobs WHERE id = $1", [
        run.fired.jobId,
      ])
    ).rows[0];
    expect(Number(job.budget_amount)).toBe(3);
    expect(job.strategy_policy).toMatchObject({ source: "superagent", chainTriggerId: trigger.id });
    const brief = (
      await api().get(`/v1/jobs/${run.fired.jobId}/payload/brief`).set(bearer(client)).expect(200)
    ).body.data.content;
    expect(brief).toContain(`1,500,000 LIEGE (token ${token}) moved from ${whale} to ${other}`);
    expect(brief).toContain("https://robinhoodchain.blockscout.com/tx/0x");
    const notes = (
      await db.query("SELECT event_type, title, message FROM notifications WHERE user_id = $1", [
        client.userId,
      ])
    ).rows;
    expect(notes).toContainEqual(
      expect.objectContaining({
        event_type: "trigger.fired",
        title: "Onchain trigger fired: LIEGE",
      }),
    );
    expect(notes.find((n) => n.event_type === "trigger.fired")!.message).toContain(
      "Fund the job by",
    );

    // Nothing new: no second job. A new large transfer waits for the cooldown and the unfunded job.
    expect(await poll()).toEqual([]);
    head = 1010n;
    logs.push(transferLog(1005n, whale, other, 3_000_000));
    const [later] = await poll();
    expect(later).toMatchObject({ fired: null, skipped: 2 });
  });

  test("only jobs that can still be funded hold the trigger back, and the cap ends it", async () => {
    const { client, agentId } = await fixture();
    await create(client, {
      agentId,
      contract: token,
      budgetAmount: 3,
      spendCap: 7,
      cooldownMinutes: 5,
    }).expect(201);
    logs = [transferLog(999n, whale, other, 10)];
    head = 1003n;
    const [first] = await poll();
    // The funding window passed and the cooldown is over: the next event fires.
    await db.query("UPDATE jobs SET deadline_at = now() - interval '1 minute' WHERE id = $1", [
      first.fired.jobId,
    ]);
    await db.query(
      "UPDATE superagent_chain_triggers SET last_fired_at = now() - interval '10 minutes'",
    );
    head = 1010n;
    logs.push(transferLog(1004n, other, whale, 20));
    const [second] = await poll();
    expect(second.fired).toMatchObject({ outcome: "awaiting_funding" });
    const trigger = (await api().get("/v1/super-agents/chain-triggers").set(bearer(client))).body
      .data[0];
    expect(trigger).toMatchObject({
      status: "completed",
      status_reason: "Spending cap reached.",
      runs_count: 2,
    });
  });

  test("auto-funds from the balance in ledger escrow and respects the daily maximum", async () => {
    const { client, agentId } = await fixture();
    await credit(client.userId, 20);
    await create(client, {
      agentId,
      contract: token,
      budgetAmount: 3,
      spendCap: 15,
      autoFund: true,
      cooldownMinutes: 5,
      maxRunsPerDay: 1,
    }).expect(201);
    logs = [transferLog(999n, whale, other, 10)];
    head = 1003n;
    const [run] = await poll();
    expect(run.fired).toMatchObject({ outcome: "funded" });
    expect(
      (await db.query("SELECT status FROM jobs WHERE id = $1", [run.fired.jobId])).rows[0].status,
    ).toBe("funded");
    await db.query(
      "UPDATE superagent_chain_triggers SET last_fired_at = now() - interval '1 hour'",
    );
    await db.query("UPDATE jobs SET status = 'completed'");
    head = 1010n;
    logs.push(transferLog(1004n, whale, other, 10));
    expect((await poll())[0]).toMatchObject({ fired: null, skipped: 1 });
  });

  test("scans a smaller range when the RPC refuses a query with too many logs", async () => {
    const { client, agentId } = await fixture();
    await create(client, { agentId, contract: token, budgetAmount: 3, spendCap: 9 }).expect(201);
    const getLogs = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (method: string, params: any[]) => {
      if (
        method === "eth_getLogs" &&
        BigInt(params[0].toBlock) - BigInt(params[0].fromBlock) > 100n
      )
        throw new Error(
          "Robinhood Chain RPC eth_getLogs failed: logs matched by query exceeds limit of 10000",
        );
      return getLogs(method, params);
    });
    head = 1500n;
    logs = [transferLog(1050n, whale, other, 10)];
    const [first] = await poll();
    // 998..1497 is halved until it fits: 998..1060 here, which holds the event.
    expect(first).toMatchObject({ from: "998", to: "1060" });
    expect(first.fired.outcome).toBe("awaiting_funding");
    const [next] = await poll();
    expect(next).toMatchObject({ from: "1061" });
  });

  test("watches any contract event by its signature", async () => {
    const { client, agentId } = await fixture();
    const contract = "0x9999999999999999999999999999999999999999";
    const signature =
      "OwnershipTransferred(address indexed previousOwner, address indexed newOwner)";
    await create(client, {
      agentId,
      kind: "contract_event",
      contract,
      eventSignature: signature,
      budgetAmount: 3,
      spendCap: 9,
    }).expect(201);
    logs = [
      {
        address: contract,
        topics: [
          keccak256(toHex("OwnershipTransferred(address,address)")),
          topicFor(whale),
          topicFor(other),
        ],
        data: "0x",
        blockNumber: toHex(999n),
        transactionHash: `0x${"ab".repeat(32)}`,
        logIndex: "0x1",
      },
    ];
    head = 1003n;
    const [run] = await poll();
    expect(run.fired.summary).toBe(
      "OwnershipTransferred(previousOwner=0x1111…1111, newOwner=0x2222…2222) on 0x9999…9999",
    );
  });

  test("pause, resume from the current block, cancel, and owner scoping", async () => {
    const { client, agentId } = await fixture();
    const stranger = await signIn();
    const { id } = (
      await create(client, { agentId, contract: token, budgetAmount: 3, spendCap: 9 }).expect(201)
    ).body.data;
    await api()
      .post(`/v1/super-agents/chain-triggers/${id}/pause`)
      .set(bearer(stranger))
      .expect(404);
    await api().post(`/v1/super-agents/chain-triggers/${id}/pause`).set(bearer(client)).expect(200);
    head = 2000n;
    logs = [transferLog(1500n, whale, other, 10)];
    expect(await poll()).toEqual([]);
    const resumed = (
      await api()
        .post(`/v1/super-agents/chain-triggers/${id}/resume`)
        .set(bearer(client))
        .expect(200)
    ).body.data;
    expect(resumed).toMatchObject({ status: "active", last_block: "1997" });
    expect(await poll()).toEqual([]);
    await api().delete(`/v1/super-agents/chain-triggers/${id}`).set(bearer(client)).expect(200);
    await api().delete(`/v1/super-agents/chain-triggers/${id}`).set(bearer(client)).expect(409);
  });
});
