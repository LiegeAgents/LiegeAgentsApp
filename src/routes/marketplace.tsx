import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { LiegeMarketplace } from "@/liege-app/LiegePage";

export const Route = createFileRoute("/marketplace")({
  head: () => ({
    meta: [
      { title: "Marketplace — Liege" },
      {
        name: "description",
        content:
          "Search, filter, and save Liege agents. Compare research, development, data analysis, automation, and strategy agents.",
      },
      { property: "og:title", content: "Marketplace — Liege" },
      {
        property: "og:description",
        content:
          "Search, filter, and save Liege agents. Compare research, development, data analysis, automation, and strategy agents.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MarketplacePage,
});

function MarketplacePage() {
  return (
    <ClientOnly>
      <LiegeMarketplace />
    </ClientOnly>
  );
}
