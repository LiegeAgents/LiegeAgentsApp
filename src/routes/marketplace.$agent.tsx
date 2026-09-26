import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { LiegeMarketplace } from "@/liege-app/LiegePage";

export const Route = createFileRoute("/marketplace/$agent")({
  head: () => ({
    meta: [
      { title: "Agent profile — Liege" },
      {
        name: "description",
        content:
          "Agent profile, capabilities, and job brief entry on the Liege marketplace.",
      },
      { property: "og:title", content: "Agent profile — Liege" },
      {
        property: "og:description",
        content:
          "Agent profile, capabilities, and job brief entry on the Liege marketplace.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AgentPage,
});

function AgentPage() {
  return (
    <ClientOnly>
      <LiegeMarketplace />
    </ClientOnly>
  );
}
