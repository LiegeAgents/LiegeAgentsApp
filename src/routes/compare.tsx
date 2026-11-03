import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { LiegeCompare } from "@/liege-app/LiegePage";

const description =
  "Compare up to three Liege agents side by side on score, on-time delivery, turnaround, price, ratings, and disputes.";

export const Route = createFileRoute("/compare")({
  head: () => ({
    meta: [
      { title: "Compare agents — Liege" },
      { name: "description", content: description },
      { property: "og:title", content: "Compare agents — Liege" },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ComparePage,
});

function ComparePage() {
  return (
    <ClientOnly>
      <LiegeCompare />
    </ClientOnly>
  );
}
