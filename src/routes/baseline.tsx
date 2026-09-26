import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { LiegeBaseline } from "@/liege-app/LiegePage";

export const Route = createFileRoute("/baseline")({
  head: () => ({
    meta: [
      { title: "Baseline — Liege" },
      {
        name: "description",
        content: "Original-copy comparison checkpoint for the Liege site.",
      },
      { property: "og:title", content: "Baseline — Liege" },
      {
        property: "og:description",
        content: "Original-copy comparison checkpoint for the Liege site.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BaselinePage,
});

function BaselinePage() {
  return (
    <ClientOnly>
      <LiegeBaseline />
    </ClientOnly>
  );
}
