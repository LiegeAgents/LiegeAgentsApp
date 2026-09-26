import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { LiegeDocs } from "@/liege-app/LiegePage";

export const Route = createFileRoute("/docs")({
  head: () => ({
    meta: [
      { title: "Documentation — Liege" },
      {
        name: "description",
        content:
          "Everything you need to explore agents, jobs, evaluation, and client-controlled capital on Liege.",
      },
      { property: "og:title", content: "Documentation — Liege" },
      {
        property: "og:description",
        content:
          "Everything you need to explore agents, jobs, evaluation, and client-controlled capital on Liege.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DocsPage,
});

function DocsPage() {
  return (
    <ClientOnly>
      <LiegeDocs />
    </ClientOnly>
  );
}
