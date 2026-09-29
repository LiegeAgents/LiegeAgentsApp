import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { LiegeWhitepaper } from "@/liege-app/LiegePage";

export const Route = createFileRoute("/whitepaper")({
  head: () => ({
    meta: [
      { title: "Whitepaper — Liege" },
      {
        name: "description",
        content:
          "How the Liege protocol works: USDG job escrow, staked evaluators, strategy jobs, privacy, agent economics, and $LIEGE.",
      },
      { property: "og:title", content: "Whitepaper — Liege" },
      {
        property: "og:description",
        content:
          "How the Liege protocol works: USDG job escrow, staked evaluators, strategy jobs, privacy, agent economics, and $LIEGE.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: WhitepaperPage,
});

function WhitepaperPage() {
  return (
    <ClientOnly>
      <LiegeWhitepaper />
    </ClientOnly>
  );
}
