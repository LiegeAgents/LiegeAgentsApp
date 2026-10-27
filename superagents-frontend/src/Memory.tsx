import { useEffect, useState } from "react";
import { Brain, Trash2 } from "lucide-react";

type Memory = {
  agentId: string;
  agentName: string;
  enabled: boolean;
  preferences: string | null;
  learned: Array<{ jobTitle: string; feedback: string; at: string }>;
};

export function MemoryPanel({
  api,
  token,
  notify,
}: {
  api: string;
  token: string;
  notify: (notice: { title: string; body: string }) => void;
}) {
  const [items, setItems] = useState<Memory[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  async function call(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${api}/v1/super-agents${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error?.message || "That did not work.");
    return result.data;
  }
  const load = async () => {
    const data: Memory[] = await call("/memory");
    setItems(data);
    setDrafts(Object.fromEntries(data.map((item) => [item.agentId, item.preferences ?? ""])));
  };
  useEffect(() => {
    void load()
      .catch((error) => notify({ title: "Could not load memory", body: error.message }))
      .finally(() => setLoading(false));
  }, [api, token]);

  const act = (title: string, work: () => Promise<unknown>) =>
    void work()
      .then(load)
      .catch((error) => notify({ title, body: error.message }));

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>What agents remember about you</h2>
        <span className="preview-label">ENCRYPTED · YOURS TO CLEAR</span>
      </div>
      <p className="muted recurring-empty">
        Each agent gets your preferences and your feedback from earlier revisions with it, so you
        don't repeat yourself. The job's brief always wins. Turn it off or clear it anytime.
      </p>
      {loading ? (
        <p className="muted recurring-empty">Loading…</p>
      ) : !items.length ? (
        <div className="empty">
          <Brain size={28} />
          <h3>No agents yet.</h3>
          <p>Hire an agent and its memory of you shows here.</p>
        </div>
      ) : (
        items.map((item) => (
          <article className="recurring-item memory-item" key={item.agentId}>
            <header>
              <strong>{item.agentName}</strong>
              <label className="memory-toggle">
                <input
                  type="checkbox"
                  checked={item.enabled}
                  onChange={(event) =>
                    act("Could not change memory", () =>
                      call(`/memory/${item.agentId}`, "PUT", { enabled: event.target.checked }),
                    )
                  }
                />
                Remember me
              </label>
            </header>
            {item.enabled && (
              <>
                <label className="enrollment-field" htmlFor={`prefs-${item.agentId}`}>
                  Your preferences
                </label>
                <textarea
                  id={`prefs-${item.agentId}`}
                  rows={2}
                  maxLength={2000}
                  value={drafts[item.agentId] ?? ""}
                  placeholder="For example: bullet points, cite sources, keep it under a page."
                  onChange={(event) => setDrafts({ ...drafts, [item.agentId]: event.target.value })}
                />
                <div className="memory-actions">
                  <button
                    className="button"
                    type="button"
                    onClick={() =>
                      act("Could not save", () =>
                        call(`/memory/${item.agentId}`, "PUT", {
                          preferences: drafts[item.agentId]?.trim() || null,
                        }),
                      )
                    }
                  >
                    Save preferences
                  </button>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() =>
                      act("Could not clear", () => call(`/memory/${item.agentId}`, "DELETE"))
                    }
                  >
                    <Trash2 size={14} /> Clear memory
                  </button>
                </div>
                {item.learned.length > 0 && (
                  <ul className="memory-learned">
                    {item.learned.map((entry, index) => (
                      <li key={index}>
                        <small>{entry.jobTitle}</small> {entry.feedback}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </article>
        ))
      )}
    </section>
  );
}
