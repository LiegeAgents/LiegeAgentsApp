import { useEffect, useState } from "react";

type Agent = {
  id: string;
  name: string;
  active: boolean;
  service_id: string | null;
  webhook_id: string | null;
  settlement_assets: string[];
  enrollment_settlement_assets: string[] | null;
  enabled: boolean;
  verified_at: string | null;
};
type Service = {
  id: string;
  agent_id: string;
  name: string;
  price_usd: string;
  sla_minutes: number;
  settlement_assets: string[];
};
type Hook = { id: string; agent_id: string; url: string };
export function Enrollment({
  api,
  token,
  notify,
}: {
  api: string;
  token: string;
  notify: (notice: { title: string; body: string }) => void;
}) {
  const [data, setData] = useState<{ agents: Agent[]; services: Service[]; webhooks: Hook[] }>({
    agents: [],
    services: [],
    webhooks: [],
  });
  const [agentId, setAgentId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [webhookId, setWebhookId] = useState("");
  const [settlementAssets, setSettlementAssets] = useState<string[]>(["usdg"]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const agent = data.agents.find((a) => a.id === agentId);
  const service = data.services.find((item) => item.id === serviceId);
  useEffect(() => {
    if (!agent || !service) return;
    const supported = ["usdg", "liege"].filter(
      (asset) =>
        agent.settlement_assets?.includes(asset) && service.settlement_assets?.includes(asset),
    );
    setSettlementAssets((current) => {
      const next = current.filter((asset) => supported.includes(asset));
      return next.length ? next : supported.slice(0, 1);
    });
  }, [agent?.id, service?.id]);
  async function call(path: string, body?: unknown) {
    const response = await fetch(`${api}/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error?.message || "The update could not be completed.");
    return result.data;
  }
  async function load() {
    setData(await call("super-agents/enrollments"));
  }
  useEffect(() => {
    void load()
      .catch((error) => notify({ title: "Could not load your agents", body: error.message }))
      .finally(() => setLoading(false));
  }, [api, token]);
  async function act(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      await load();
      window.dispatchEvent(new Event("sa-requests-updated"));
    } catch (error) {
      notify({
        title: "Enrollment not updated",
        body: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel enrollment-panel enrollment-editor">
      <div className="panel-heading enrollment-heading">
        <h2>Your Super Agents</h2>
        <span className="enrollment-kicker">OWNER CONTROL · DISCOVERY</span>
      </div>
      <div className="settings-content enrollment-content">
        <p>
          Connect an existing Liege agent to chat and X. Its identity, owner, and payment
          destination stay the same.
        </p>
        {loading ? (
          <p>Loading your agents…</p>
        ) : !data.agents.length ? (
          <p>No owned agents found. Launch an agent in your Liege workspace first.</p>
        ) : (
          <>
            <label className="enrollment-field">
              Choose your agent
              <select
                value={agentId}
                disabled={busy}
                onChange={(event) => {
                  const a = data.agents.find((item) => item.id === event.target.value);
                  setAgentId(event.target.value);
                  setServiceId(a?.service_id || "");
                  setWebhookId(a?.webhook_id || "");
                  setSettlementAssets(
                    a?.enrollment_settlement_assets?.length
                      ? a.enrollment_settlement_assets
                      : a?.settlement_assets?.length
                        ? a.settlement_assets
                        : ["usdg"],
                  );
                }}
              >
                <option value="">Select an agent you own</option>
                {data.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.active ? "" : " (inactive)"}
                  </option>
                ))}
              </select>
            </label>
            {agent && (
              <>
                <span className="status">
                  {agent.enabled
                    ? "Discoverable"
                    : agent.verified_at
                      ? "Connection verified"
                      : agent.service_id
                        ? "Connection test required"
                        : "Not enrolled"}
                </span>
                <label className="enrollment-field-label" htmlFor="super-agent-service">
                  Service
                </label>
                <select
                  id="super-agent-service"
                  disabled={busy}
                  value={serviceId}
                  onChange={(event) => setServiceId(event.target.value)}
                >
                  <option value="">Choose a service</option>
                  {data.services
                    .filter((s) => s.agent_id === agentId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.sla_minutes} min ·{" "}
                        {(s.settlement_assets || ["usdg"])
                          .map((asset) => asset.toUpperCase())
                          .join(" / ")}
                      </option>
                    ))}
                </select>
                {!data.services.some((s) => s.agent_id === agentId) && (
                  <p className="muted small">
                    This agent has no service listing yet. Add the service it should offer below,
                    then it will appear in the selector.
                  </p>
                )}
                <details
                  className="enrollment-disclosure"
                  open={!data.services.some((s) => s.agent_id === agentId)}
                >
                  <summary>Add a service</summary>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const values = new FormData(event.currentTarget);
                      void act(async () => {
                        const service = await call("services", {
                          agentId,
                          slug: values.get("slug"),
                          name: values.get("name"),
                          description: values.get("description"),
                          serviceType: "skill",
                          priceUsd: Number(values.get("price")),
                          slaMinutes: Number(values.get("sla")),
                          settlementAssets: ["usdg", "liege"].filter(
                            (asset) => values.get(asset) === "on",
                          ),
                        });
                        setServiceId(service.id);
                      });
                    }}
                  >
                    <label>
                      Service name
                      <input name="name" required minLength={2} maxLength={120} />
                    </label>
                    <label>
                      Service slug
                      <input
                        name="slug"
                        required
                        pattern="[a-z0-9]+(-[a-z0-9]+)*"
                        maxLength={80}
                        placeholder="research-brief"
                      />
                    </label>
                    <label>
                      Offering and deliverables
                      <textarea name="description" required minLength={20} maxLength={4000} />
                    </label>
                    <label>
                      Reference amount (display only)
                      <input
                        name="price"
                        type="number"
                        required
                        min="0.000001"
                        step="0.000001"
                        defaultValue="1"
                      />
                    </label>
                    <fieldset className="asset-fieldset">
                      <legend>Accepted settlement assets</legend>
                      <p className="muted small">
                        Select every token this service can accept. Each job still settles in one
                        token.
                      </p>
                      <div className="asset-options">
                        <label className="asset-choice">
                          <input
                            className="asset-choice-input"
                            name="usdg"
                            type="checkbox"
                            defaultChecked
                          />
                          <span className="asset-choice-box" aria-hidden="true">
                            ✓
                          </span>
                          <img src="/brand/usdg-official.png" alt="" />
                          <span>USDG</span>
                        </label>
                        <label className="asset-choice">
                          <input className="asset-choice-input" name="liege" type="checkbox" />
                          <span className="asset-choice-box" aria-hidden="true">
                            ✓
                          </span>
                          <img src="/brand/logo-transparent.png" alt="" />
                          <span>LIEGE</span>
                        </label>
                      </div>
                    </fieldset>
                    <label>
                      Delivery time (minutes)
                      <input name="sla" type="number" required min="1" max="10080" />
                    </label>
                    <button className="button" disabled={busy}>
                      Save service
                    </button>
                  </form>
                </details>
                <fieldset className="asset-fieldset enrollment-asset-fieldset">
                  <legend>Settlement assets for this enrollment</legend>
                  <p className="muted small">
                    Select every token this enrollment can accept. Each job settles in one token; no
                    conversion or oracle is used.
                  </p>
                  <div className="asset-options">
                    {["usdg", "liege"].map((asset) => {
                      const supported = Boolean(
                        agent.settlement_assets?.includes(asset) &&
                        service?.settlement_assets?.includes(asset),
                      );
                      return (
                        <label key={asset} className="asset-choice">
                          <input
                            className="asset-choice-input"
                            type="checkbox"
                            checked={settlementAssets.includes(asset)}
                            disabled={busy || !supported}
                            onChange={(event) =>
                              setSettlementAssets((current) =>
                                event.target.checked
                                  ? [...new Set([...current, asset])]
                                  : current.filter((item) => item !== asset),
                              )
                            }
                          />
                          <span className="asset-choice-box" aria-hidden="true">
                            ✓
                          </span>
                          <img
                            src={`/brand/${asset === "usdg" ? "usdg-official.png" : "logo-transparent.png"}`}
                            alt=""
                          />
                          <span>{asset.toUpperCase()}</span>
                          {!supported && (
                            <small className="asset-unavailable">
                              Not supported by agent or service
                            </small>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
                <label htmlFor="super-agent-webhook">Execution webhook</label>
                <select
                  id="super-agent-webhook"
                  disabled={busy}
                  value={webhookId}
                  onChange={(event) => setWebhookId(event.target.value)}
                >
                  <option value="">Choose a funded-job webhook</option>
                  {data.webhooks
                    .filter((w) => w.agent_id === agentId)
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.url}
                      </option>
                    ))}
                </select>
                {!data.webhooks.some((w) => w.agent_id === agentId) && (
                  <p className="muted small">
                    No funded-job webhook is connected yet. Create one for this agent’s runtime
                    endpoint, then copy its one-time secret into the runtime environment.
                  </p>
                )}
                <details className="enrollment-disclosure">
                  <summary>Add an execution connection</summary>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const url = new FormData(event.currentTarget).get("url");
                      void act(async () => {
                        const hook = await call("webhooks", {
                          agentId,
                          url,
                          eventTypes: ["job.funded"],
                        });
                        setWebhookId(hook.id);
                        notify({
                          title: "Save your webhook secret",
                          body: `Configure this secret in your runtime before testing. It is shown only once: ${hook.secret}`,
                        });
                      });
                    }}
                  >
                    <label>
                      HTTPS webhook URL
                      <input
                        name="url"
                        type="url"
                        required
                        placeholder="https://your-runtime.example/webhooks/agent"
                      />
                    </label>
                    <button className="button" disabled={busy}>
                      Create connection
                    </button>
                  </form>
                </details>
                <div className="enrollment-actions">
                  <button
                    className="button"
                    disabled={busy || !agent.active || !serviceId || !webhookId}
                    onClick={() =>
                      void act(async () => {
                        await call("super-agents/enrollments", {
                          agentId,
                          serviceId,
                          webhookId,
                          settlementAssets,
                        });
                        notify({
                          title: "Enrollment saved",
                          body: "Configure your runtime, then test the connection. Saving changes turns discovery off until you verify again.",
                        });
                      })
                    }
                  >
                    Save enrollment
                  </button>
                  <button
                    className="button secondary"
                    disabled={
                      busy ||
                      !agent.service_id ||
                      serviceId !== agent.service_id ||
                      webhookId !== agent.webhook_id
                    }
                    onClick={() =>
                      void act(async () => {
                        await call(`super-agents/enrollments/${agentId}/verify`, {});
                        notify({
                          title: "Connection verified",
                          body: "Your runtime verified the signed connection test. You can now enable discovery.",
                        });
                      })
                    }
                  >
                    Test connection
                  </button>
                  <button
                    className="button secondary"
                    disabled={
                      busy ||
                      (!agent.enabled &&
                        (!agent.verified_at ||
                          serviceId !== agent.service_id ||
                          webhookId !== agent.webhook_id))
                    }
                    onClick={() =>
                      void act(async () => {
                        await call(`super-agents/enrollments/${agentId}/discovery`, {
                          enabled: !agent.enabled,
                        });
                        notify({
                          title: agent.enabled ? "Discovery disabled" : "Discovery enabled",
                          body: agent.enabled
                            ? "New chat and X requests will no longer match this agent. Existing jobs remain available."
                            : "Users can now request this agent by name in chat and on X.",
                        });
                      })
                    }
                  >
                    {agent.enabled ? "Disable discovery" : "Enable discovery"}
                  </button>
                </div>
                <p className="muted small">
                  A connection test confirms that your endpoint knows the webhook secret and this
                  agent ID. Run a funded test job separately to verify delivery quality.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
