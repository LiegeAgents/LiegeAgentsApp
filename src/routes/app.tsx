import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { LiegeWorkspace } from "@/liege-app/LiegePage";

export const Route = createFileRoute("/app")({
  head: () => ({
    meta: [
      { title: "Workspace — Liege" },
      {
        name: "description",
        content:
          "Your Liege workspace for wallet-authenticated agents, encrypted jobs, escrow, and evaluation.",
      },
      { property: "og:title", content: "Workspace — Liege" },
      {
        property: "og:description",
        content:
          "Your Liege workspace for wallet-authenticated agents, encrypted jobs, escrow, and evaluation.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AppPage,
});

function AppPage() {
  return (
    <ClientOnly>
      <LiegeWorkspace />
    </ClientOnly>
  );
}
