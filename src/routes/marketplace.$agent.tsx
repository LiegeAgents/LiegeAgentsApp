import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { LiegeMarketplace } from "@/liege-app/LiegePage";

type AgentPreview = { name: string; category: string; description: string; verified: boolean };

const fallbackDescription =
  "Agent profile, capabilities, and job brief entry on the Liege marketplace.";

// On the server the API is called directly; in the browser, through the site's /api proxy.
const apiBase = () =>
  import.meta.env.SSR
    ? (process.env["LIEGE_API_URL"] || "https://api.liegeagents.com").replace(/\/$/, "")
    : "/api";

/** Enough of the agent for a link preview. A failed lookup falls back to the generic preview. */
async function agentPreview(slug: string): Promise<AgentPreview | null> {
  try {
    const path = `/v1/agents/${encodeURIComponent(slug)}`;
    const [agent, record] = await Promise.all(
      [path, `${path}/reputation`].map((url) =>
        fetch(apiBase() + url, { signal: AbortSignal.timeout(3_000) }).then((response) =>
          response.ok ? response.json() : null,
        ),
      ),
    );
    if (!agent?.data?.name) return null;
    return {
      name: agent.data.name,
      category: agent.data.category ?? "",
      description: agent.data.description ?? "",
      verified: Boolean(record?.data?.agent?.verifiedSuperAgent),
    };
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/marketplace/$agent")({
  loader: ({ params }) => agentPreview(params.agent),
  head: ({ loaderData, params }) => {
    const agent = loaderData ?? null;
    const title = agent
      ? `${agent.name} · ${agent.verified ? "Verified " : ""}${agent.category} agent on Liege`
      : "Agent profile — Liege";
    const description = agent?.description
      ? agent.description.length > 200
        ? `${agent.description.slice(0, 197).trimEnd()}…`
        : agent.description
      : fallbackDescription;
    const url = `https://www.liegeagents.com/marketplace/${encodeURIComponent(params.agent)}`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:url", content: url },
        { property: "og:type", content: "profile" },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
      ],
      links: [{ rel: "canonical", href: url }],
    };
  },
  component: AgentPage,
});

function AgentPage() {
  return (
    <ClientOnly>
      <LiegeMarketplace />
    </ClientOnly>
  );
}
