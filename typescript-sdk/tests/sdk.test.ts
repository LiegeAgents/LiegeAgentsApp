import { describe, expect, test } from "bun:test";
import { LiegeAPIError, LiegeClient, McpClient, decodeX402PaymentRequired } from "../src/index.js";

describe("LiegeClient", () => {
  test("retries transient GETs and preserves request ids on terminal errors", async () => {
    let calls = 0;
    const client = new LiegeClient({ retryBackoffMs: 0, maxRetries: 1, fetch: async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "upstream", code: "UPSTREAM" } }), { status: 503, headers: { "x-request-id": "req-42" } });
    } });
    await expect(client.listJobs()).rejects.toMatchObject({ status: 503, code: "UPSTREAM", requestId: "req-42", retryable: true });
    expect(calls).toBe(2);
  });

  test("supports typed pages and caller cancellation", async () => {
    const client = new LiegeClient({ fetch: async (_input, init) => {
      expect(init?.signal).toBeDefined();
      return new Response(JSON.stringify({ data: { items: [{ id: "job-1", status: "open" }], nextCursor: "cursor-2", total: 1 } }));
    } });
    const page = await client.listJobsPage();
    expect(page).toEqual({ items: [{ id: "job-1", status: "open" }], nextCursor: "cursor-2", total: 1 });
  });

  test("lists jobs and unwraps API data", async () => {
    const client = new LiegeClient({ fetch: async () => new Response(JSON.stringify({ data: [{ id: "job-1", status: "open" }] }), { status: 200 }) });
    expect(await client.listJobs()).toEqual([{ id: "job-1", status: "open" }]);
  });

  test("authenticates with an application-provided signer", async () => {
    const client = new LiegeClient({ fetch: async (_input, init) => {
      const path = new URL(String(_input)).pathname;
      if (path.endsWith("/nonce")) return new Response(JSON.stringify({ data: { nonce: "n1", message: "sign me" } }));
      return new Response(JSON.stringify({ data: { token: "session", userId: "u1", walletAddress: "0xabc" } }));
    } });
    const session = await client.authenticate("0xabc", (message) => `sig:${message}`);
    expect(session.token).toBe("session");
  });

  test("surfaces structured API errors", async () => {
    const client = new LiegeClient({ fetch: async () => new Response(JSON.stringify({ error: { message: "Denied", code: "POLICY" } }), { status: 403 }) });
    await expect(client.listJobs()).rejects.toBeInstanceOf(LiegeAPIError);
  });

  test("keeps the final SSE event when the stream has no blank terminator", async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('id: 1\nevent: job\ndata: {"id":"job-1"}\n')); controller.close(); } });
    const client = new LiegeClient({ token: "session", fetch: async () => new Response(stream) });
    const events = []; for await (const event of client.iterEvents("agent-1")) events.push(event);
    expect(events).toEqual([{ id: "1", event: "job", data: { id: "job-1" } }]);
  });

  test("reconnects with Last-Event-ID and deduplicates replayed events", async () => {
    let calls = 0;
    const client = new LiegeClient({ fetch: async (input, init) => {
      calls++;
      const url = new URL(String(input));
      if (calls === 1) {
        expect(url.searchParams.get("after")).toBe("1");
        expect(new Headers(init?.headers).get("Last-Event-ID")).toBe("1");
        return new Response('id: 1\nevent: job.funded\ndata: {"jobId":"j1"}\n\n');
      }
      return new Response('id: 1\nevent: job.funded\ndata: {"jobId":"j1"}\n\nid: 2\nevent: job.completed\ndata: {"jobId":"j1"}\n\n');
    } });
    const stream = client.streamEvents("agent-1", { after: "1", maxRetries: 1, backoffMs: 0 });
    const first = await stream.next();
    const second = await stream.next();
    await stream.return?.();
    expect([first.value.id, second.value.id]).toEqual(["1", "2"]);
    expect(calls).toBe(2);
  });

  test("creates an invoice through the authenticated API client", async () => {
    const client = new LiegeClient({ token: "session", fetch: async (_input, init) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer session" });
      const body = JSON.parse(String(init?.body));
      if (body.asset === "liege") {
        return new Response(JSON.stringify({ data: { id: "invoice-2", invoiceId: "invoice-2", publicId: "INV-2", amount: 100, amountUsdg: 100, asset: "liege", status: "issued" } }));
      }
      return new Response(JSON.stringify({ data: { id: "invoice-1", invoiceId: "invoice-1", publicId: "INV-1", amountUsdg: 12.5, asset: "usdg", status: "issued" } }));
    } });
    await expect(client.createInvoice({ agentId: "agent-1", description: "Research", amountUsdg: 12.5, expiresAt: "2030-01-01T00:00:00.000Z" })).resolves.toMatchObject({ id: "invoice-1", status: "issued" });
    await expect(client.createInvoice({ agentId: "agent-1", description: "Audit", amount: 100, asset: "liege", expiresAt: "2030-01-01T00:00:00.000Z" })).resolves.toMatchObject({ id: "invoice-2", asset: "liege" });
  });

  test("supports partial refunds bound to jobId and reason and lists refunds", async () => {
    const client = new LiegeClient({ token: "session", fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/invoices/inv-1/refund")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ amount: 5, jobId: "00000000-0000-0000-0000-000000000001", reason: "Scope adjusted" });
        return new Response(JSON.stringify({ data: { id: "inv-1", invoiceId: "inv-1", publicId: "INV-1", amount: 10, amountUsdg: 10, refundedAmount: 5, refundedAmountUsdg: 5, remainingAmount: 5, asset: "usdg", status: "partially_refunded" } }));
      }
      if (url.endsWith("/v1/invoices/inv-1/refunds")) {
        return new Response(JSON.stringify({ data: [{ id: "ref-1", invoiceId: "inv-1", payerId: "payer-1", issuerId: "issuer-1", amount: 5, amountUsdg: 5, asset: "usdg", jobId: "00000000-0000-0000-0000-000000000001", reason: "Scope adjusted", refundedAt: "2026-10-02T12:00:00Z", ledgerTransactionId: "tx-1" }] }));
      }
      return new Response("not found", { status: 404 });
    } });
    const refunded = await client.refundInvoice("inv-1", { amount: 5, jobId: "00000000-0000-0000-0000-000000000001", reason: "Scope adjusted" });
    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.refundedAmount).toBe(5);
    expect(refunded.remainingAmount).toBe(5);
    const refunds = await client.listInvoiceRefunds("inv-1");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].jobId).toBe("00000000-0000-0000-0000-000000000001");
    expect(refunds[0].reason).toBe("Scope adjusted");
  });

  test("lists receipts and exports OpenTelemetry compliant spans", async () => {
    const client = new LiegeClient({ token: "session", fetch: async (input) => {
      const url = String(input);
      if (url.includes("/v1/receipts?limit=500&format=otel")) {
        return new Response(JSON.stringify({
          resourceSpans: [{
            resource: { attributes: [{ key: "service.name", value: { stringValue: "liege" } }] },
            scopeSpans: [{
              scope: { name: "liege.ledger", version: "1.0.0" },
              spans: [{
                traceId: "00000000000000000000000000000001",
                spanId: "0000000000000001",
                name: "ledger.invoice_payment",
                kind: "SPAN_KIND_INTERNAL",
                startTimeUnixNano: "1727870400000000000",
                endTimeUnixNano: "1727870400000000000",
                attributes: [{ key: "ledger.asset", value: { stringValue: "usdg" } }],
                status: { code: "STATUS_CODE_OK" },
              }],
            }],
          }],
          digest: "a".repeat(64),
          generatedAt: "2026-10-02T12:00:00Z",
        }));
      }
      if (url.includes("/v1/receipts?limit=500")) {
        return new Response(JSON.stringify({
          data: [{ receiptId: "rec-1", type: "invoice_payment", reference: "ref-1", subject: null, createdAt: "2026-10-02T12:00:00Z" }],
          digest: "a".repeat(64),
          generatedAt: "2026-10-02T12:00:00Z",
        }));
      }
      return new Response("not found", { status: 404 });
    } });

    const statement = await client.listReceipts();
    expect(statement).toHaveLength(1);
    expect(statement[0].receiptId).toBe("rec-1");

    const otel = await client.listReceipts({ format: "otel" });
    expect(otel.resourceSpans).toHaveLength(1);
    expect(otel.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("ledger.invoice_payment");
  });

  test("lists and creates typed catalog services", async () => {
    let calls = 0;
    const client = new LiegeClient({ token: "session", fetch: async (input, init) => {
      calls++;
      if (calls === 1) {
        expect(new URL(String(input)).searchParams.get("type")).toBe("skill");
        return new Response(JSON.stringify({ data: [{ id: "svc-1", agent_id: "agent-1", slug: "research", name: "Research", description: "A research service for agents.", service_type: "skill", execution_mode: "sandboxed_runner", price_usd: "2.50", sla_minutes: 30, requirements_schema: {}, deliverable_schema: {} }] }));
      }
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ data: { id: "svc-2", agentId: "agent-1", slug: "lookup", name: "Lookup", description: "A lookup service for agents.", serviceType: "tool", executionMode: "manual", priceUsd: 1, slaMinutes: 15, requirementsSchema: {}, deliverableSchema: {} } }));
    } });
    const [service] = await client.listServices({ type: "skill" });
    const created = await client.createService({ agentId: "agent-1", slug: "lookup", name: "Lookup", description: "A lookup service for agents.", serviceType: "tool", priceUsd: 1, slaMinutes: 15 });
    expect(service).toMatchObject({ agentId: "agent-1", serviceType: "skill", executionMode: "sandboxed_runner", priceUsd: 2.5 });
    expect(created.serviceType).toBe("tool");
  });

  test("retrieves verifiable agent reputation and SLA audit record", async () => {
    const auditRecord = {
      agent: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        slug: "researcher",
        name: "Research Agent",
        category: "research",
        ownerWallet: "0x1111111111111111111111111111111111111111",
        reputationScore: 98,
        accountStatus: "active",
        registeredAt: "2026-10-01T00:00:00.000Z",
      },
      settlement: {
        currency: "USDG",
        totalSettledUsdg: "250.000000",
        totalSettledLiege: "1000.000000",
        network: "robinhood_chain",
        chainId: 4663,
      },
      jobs: {
        total: 10,
        completed: 9,
        rejected: 1,
        expired: 0,
        cancelled: 0,
        active: 0,
        completionRate: 0.9,
      },
      sla: {
        avgTurnaroundMinutes: 12.5,
        onTimeJobs: 9,
        onTimeDeliveryRate: 1.0,
        minCatalogSlaMinutes: 15,
      },
      disputes: {
        total: 0,
        resolvedProvider: 0,
        resolvedClient: 0,
        disputeRate: 0,
      },
      catalog: {
        activeServicesCount: 2,
        serviceTypes: ["tool", "skill"],
      },
      mandates: {
        activeCount: 1,
        totalIssued: 1,
      },
      auditDigest: "abc123digest",
      auditedAt: "2026-10-03T12:00:00.000Z",
    };

    const client = new LiegeClient({
      fetch: async (input) => {
        expect(String(input)).toContain("/v1/agents/researcher/reputation");
        return new Response(JSON.stringify({ data: auditRecord }));
      },
    });

    const reputation = await client.getAgentReputation("researcher");
    expect(reputation.agent.slug).toBe("researcher");
    expect(reputation.settlement.network).toBe("robinhood_chain");
    expect(reputation.settlement.chainId).toBe(4663);
    expect(reputation.jobs.completionRate).toBe(0.9);
    expect(reputation.sla.onTimeDeliveryRate).toBe(1.0);
    expect(reputation.auditDigest).toBe("abc123digest");
  });

  test("simulates and authorizes an agent action", async () => {
    let calls = 0;
    const client = new LiegeClient({ token: "session", fetch: async (input, init) => {
      calls++;
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/actions/simulate")) return new Response(JSON.stringify({ data: { id: "sim-1", action_digest: "digest-1234", action: { action: "run" }, result: { eligible: true }, policy_version: 2, expires_at: "2030-01-01T00:00:00Z", created_at: "2030-01-01T00:00:00Z" } }), { status: 201 });
      expect(path.endsWith("/actions/authorize")).toBe(true);
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ data: { actionId: "action-1", accountId: "agent-1", decision: "approval_required", reasons: [], policyVersion: 2, simulationDigest: "digest-1234", createdAt: "2030-01-01T00:00:00Z" } }));
    } });
    const simulation = await client.simulateAction("agent-1", { action: "run", amount: 1 });
    const authorization = await client.authorizeAction("agent-1", { action: "run", amount: 1, simulationId: simulation.id });
    expect(simulation.actionDigest).toBe("digest-1234");
    expect(authorization.decision).toBe("approval_required");
    expect(calls).toBe(2);
  });

  test("builds runner approval actions and executes only with both approvals", async () => {
    const requests: RequestInit[] = [];
    const client = new LiegeClient({ token: "session", fetch: async (input, init) => {
      requests.push(init ?? {});
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/actions/simulate")) return new Response(JSON.stringify({ data: { id: "sim-1", action_digest: "d", action: {}, result: { eligible: true }, policy_version: 1, expires_at: "2030-01-01", created_at: "2030-01-01" } }), { status: 201 });
      if (path.endsWith("/actions/authorize")) return new Response(JSON.stringify({ data: { actionId: "act-1", accountId: "agent-1", decision: "approved", reasons: [], policyVersion: 1, createdAt: "2030-01-01" } }));
      return new Response(JSON.stringify({ data: { id: "run-1", status: "succeeded", artifacts: [] } }), { status: 201 });
    } });
    const input = { agentId: "agent-1", command: "python" as const, files: { "main.py": "print(1)" } };
    const simulation = await client.simulateRunnerAction("agent-1", input);
    await client.authorizeRunnerAction("agent-1", input);
    const run = await client.executeApprovedRunnerAction({ ...input, actionId: "act-1", simulationId: simulation.id });
    expect(run).toMatchObject({ id: "run-1", status: "succeeded" });
    expect(JSON.parse(String(requests[0].body))).toMatchObject({ action: "runner.execute" });
    expect(JSON.parse(String(requests[2].body))).toMatchObject({ actionId: "act-1", simulationId: "sim-1" });
  });

  test("completes an x402 challenge with an application-provided signer", async () => {
    let attempts = 0;
    const challenge = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:4663" }] };
    const client = new LiegeClient({ fetch: async (_input, init) => {
      attempts++;
      if (attempts === 1) return new Response("pay", { status: 402, headers: { "PAYMENT-REQUIRED": btoa(JSON.stringify(challenge)) } });
      expect(new Headers(init?.headers).get("PAYMENT-SIGNATURE")).toBe(btoa(JSON.stringify({ payload: "signed" })));
      return new Response(JSON.stringify({ paid: true }), { status: 200, headers: { "PAYMENT-RESPONSE": btoa(JSON.stringify({ success: true })) } });
    } });
    const response = await client.requestX402("https://api.test/resource", (value) => {
      expect(value).toEqual(decodeX402PaymentRequired(btoa(JSON.stringify(challenge))));
      return { payload: "signed" };
    });
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("manages webhook subscriptions and verifies signed payloads", async () => {
    const client = new LiegeClient({ token: "session", fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/webhooks" && init?.method === "POST") return new Response(JSON.stringify({ data: { id: "wh-1", agent_id: "agent-1", url: "https://example.test/hook", event_types: ["job.completed"], active: true, secret: "whsec_test" } }), { status: 201 });
      if (path === "/v1/webhooks") return new Response(JSON.stringify({ data: [{ id: "wh-1", agent_id: "agent-1", url: "https://example.test/hook", event_types: ["job.completed"], active: true }] }));
      return new Response(null, { status: 204 });
    } });
    const created = await client.createWebhook({ agentId: "agent-1", url: "https://example.test/hook", eventTypes: ["job.completed"] });
    expect(created.secret).toBe("whsec_test");
    expect((await client.listWebhooks())[0].agentId).toBe("agent-1");
    await client.deleteWebhook("wh-1");
    const signature = "sha256=46bdc2a2e83964bd2695acc6a1f97162d8bafc135a071aa5cd5c99aae5481440";
    expect(await client.verifyWebhookSignature("{}", signature, "whsec_test")).toBe(true);
    expect(await client.verifyWebhookSignature("tampered", signature, "whsec_test")).toBe(false);
  });
});

describe("McpClient", () => {
  test("initializes and proposes an action", async () => {
    const methods: string[] = [];
    const client = new McpClient("lmp_test", "https://mcp.test", async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      methods.push(request.method);
      const result = request.method === "tools/call"
        ? { content: [{ type: "text", text: JSON.stringify({ id: "proposal-1", status: "pending" }) }] }
        : {};
      return new Response(JSON.stringify({ result }), { status: 200 });
    });
    expect(await client.propose("submit_deliverable", { jobId: "job-1" })).toMatchObject({ id: "proposal-1", status: "pending" });
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });

  test("interacts with account status, simulation, authorization, and services", async () => {
    const toolCalls: string[] = [];
    const client = new McpClient("lmp_test", "https://mcp.test", async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string } };
      if (request.method === "tools/call") {
        toolCalls.push(request.params?.name ?? "");
        const responses: Record<string, unknown> = {
          liege_account_status: { accountId: "agent-1", status: "active", budgetUsage: { dailySpent: 0 } },
          liege_account_simulate: { simulationId: "sim-1", actionDigest: "dig-1", result: { eligible: true } },
          liege_account_authorize: { actionId: "act-1", decision: "approved" },
          liege_account_mandates: [{ id: "man-1", nonce: "nonce-1" }],
          list_services: [{ id: "srv-1", name: "Market Data" }],
        };
        const text = JSON.stringify(responses[request.params?.name ?? ""] ?? {});
        return new Response(JSON.stringify({ result: { content: [{ type: "text", text }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    });

    const status = await client.accountStatus();
    expect(status).toMatchObject({ accountId: "agent-1", status: "active" });

    const sim = await client.accountSimulate({ action: "transfer", amount: 10 });
    expect(sim).toMatchObject({ simulationId: "sim-1", actionDigest: "dig-1" });

    const auth = await client.accountAuthorize({ action: "transfer", amount: 10, simulationId: "sim-1" });
    expect(auth).toMatchObject({ actionId: "act-1", decision: "approved" });

    const mandates = await client.accountMandates();
    expect(mandates).toHaveLength(1);
    expect(mandates[0]).toMatchObject({ id: "man-1" });

    const services = await client.listServices();
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ id: "srv-1" });

    expect(toolCalls).toEqual([
      "liege_account_status",
      "liege_account_simulate",
      "liege_account_authorize",
      "liege_account_mandates",
      "list_services",
    ]);
  });

  test("reads cursor-based MCP events and bounded waits", async () => {
    const toolCalls: string[] = [];
    const client = new McpClient("lmp_test", "https://mcp.test", async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string } };
      if (request.method === "tools/call") {
        const name = request.params?.name ?? "";
        toolCalls.push(name);
        const value = name === "list_job_events"
          ? { items: [{ id: "evt-1", cursor: "42", eventType: "job.funded", payload: { jobId: "job-1" } }], nextCursor: "42" }
          : { event: null, timedOut: true, cursor: "42" };
        return new Response(JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(value) }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    });

    const page = await client.listJobEvents({ after: "41", limit: 10 });
    expect(page.items[0]).toMatchObject({ id: "evt-1", cursor: "42", eventType: "job.funded" });
    expect(page.nextCursor).toBe("42");
    await expect(client.waitForJobEvent("42", { timeoutMs: 500 })).resolves.toMatchObject({ timedOut: true });
    expect(toolCalls).toEqual(["list_job_events", "wait_for_job_event"]);
  });

  test("exports an owner mandate in AP2 format", async () => {
    const client = new LiegeClient({
      token: "session",
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/v1/agent-accounts/agent-1/mandates/man-1/ap2")) {
          return new Response(
            JSON.stringify({
              data: {
                protocol: "ap2",
                version: "0.2",
                vct: "mandate.payment.open.1",
                mandate_id: "man-1",
                agent_id: "agent-1",
                status: "active",
                issuer: {
                  id: "did:pkh:eip155:4663:0x1234",
                  address: "0x1234",
                  chain_id: 4663,
                  network: "robinhood_chain",
                },
                subject: { agent_id: "agent-1", account_id: "agent-1" },
                "ap2.mandates.PaymentMandate": {
                  mandate_id: "man-1",
                  parent_mandate_id: null,
                  creation_time: "2026-10-02T12:00:00.000Z",
                  expiration_time: "2026-10-03T12:00:00.000Z",
                  nonce: "nonce-1",
                  constraints: {
                    type: "payment.open_constraints",
                    allowed_actions: ["rebalance"],
                    max_amount: "50",
                    daily_budget: null,
                    monthly_budget: null,
                    currency: "USDG",
                    allowed_assets: ["USDG", "LIEGE"],
                    allowed_payees: [],
                    allowed_venues: [],
                  },
                  payload: { actions: ["rebalance"], maxAmount: "50" },
                },
                "ap2.mandates.IntentMandate": {
                  natural_language_description: "Mandate authorization for Liege Agent agent-1",
                  user_cart_confirmation_required: false,
                  requires_refundability: true,
                  intent_expiry: "2026-10-03T12:00:00.000Z",
                  merchants: [],
                  constraints: {
                    max_amount: "50",
                    currency: "USDG",
                    allowed_assets: ["USDG", "LIEGE"],
                  },
                },
                proof: {
                  type: "EthereumPersonalSignature2021",
                  verification_method: "did:pkh:eip155:4663:0x1234#recovery",
                  created: "2026-10-02T12:00:00.000Z",
                  proof_purpose: "assertionMethod",
                  digest: "dig-1",
                  signature: "0xsignature",
                },
              },
            }),
          );
        }
        return new Response("not found", { status: 404 });
      },
    });

    const ap2 = await client.exportAgentMandateAp2("agent-1", "man-1");
    expect(ap2.protocol).toBe("ap2");
    expect(ap2.version).toBe("0.2");
    expect(ap2.mandate_id).toBe("man-1");
    expect(ap2.issuer.chain_id).toBe(4663);
    expect(ap2["ap2.mandates.PaymentMandate"].constraints.currency).toBe("USDG");
  });

  test("generates and exports harness presets for Claude Desktop, Cursor, ElizaOS, Hermes, and OpenClaw", async () => {
    const mcp = new McpClient("lmp_sample_token_xyz", "https://mcp.custom.org");
    const presets = mcp.exportPresets("arbitrage-bot", "Arbitrage Bot");

    expect(Object.keys(presets).sort()).toEqual([
      "claude_desktop",
      "cursor",
      "elizaos",
      "hermes",
      "openclaw",
    ]);

    expect(presets.claude_desktop.filename).toBe("claude_desktop_config.json");
    expect(
      (presets.claude_desktop.config as any).mcpServers["arbitrage-bot"].headers.Authorization,
    ).toBe("Bearer lmp_sample_token_xyz");

    expect(presets.cursor.filename).toBe(".cursor/mcp.json");
    expect(
      (presets.cursor.config as any).mcpServers["arbitrage-bot"].url,
    ).toBe("https://mcp.custom.org/mcp");

    expect(presets.elizaos.filename).toBe("character.json");
    expect(
      (presets.elizaos.config as any).settings.mcp.servers["arbitrage-bot"].headers.Authorization,
    ).toBe("Bearer lmp_sample_token_xyz");

    expect(presets.hermes.filename).toBe("hermes.json");
    expect(
      (presets.hermes.config as any).mcpServers["arbitrage-bot"].headers.Authorization,
    ).toBe("Bearer lmp_sample_token_xyz");

    expect(presets.openclaw.filename).toBe("openclaw.json");
    expect(
      (presets.openclaw.config as any).tools.mcp["arbitrage-bot"].headers.Authorization,
    ).toBe("Bearer lmp_sample_token_xyz");

    const liege = new LiegeClient({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/v1/mcp/connections/conn-1/presets")) {
          return new Response(
            JSON.stringify({
              data: {
                connectionId: "conn-1",
                agentName: "Arbitrage Bot",
                presets,
                serverUrl: "https://mcp.liegeagents.com/mcp",
              },
            }),
          );
        }
        return new Response("not found", { status: 404 });
      },
    });

    const res = await liege.getMcpPresets("conn-1");
    expect(res.connectionId).toBe("conn-1");
    expect(res.presets.cursor).toBeDefined();
  });
});
