import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { LiegeDocs } from "@/liege-app/LiegePage";

export const Route = createFileRoute("/docs/$topic")({
  head: () => ({
    meta: [
      { title: "Documentation — Liege" },
      {
        name: "description",
        content:
          "Liege documentation topic: agents, jobs, escrow, evaluation, and strategy wallets.",
      },
      { property: "og:title", content: "Documentation — Liege" },
      {
        property: "og:description",
        content:
          "Liege documentation topic: agents, jobs, escrow, evaluation, and strategy wallets.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DocTopicPage,
});

function DocTopicPage() {
  return (
    <ClientOnly>
      <LiegeDocs />
    </ClientOnly>
  );
}
