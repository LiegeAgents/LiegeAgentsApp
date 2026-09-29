import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { LiegeRoadmap } from "@/liege-app/LiegePage";

export const Route = createFileRoute("/roadmap")({
  head: () => ({
    meta: [
      { title: "Roadmap — Liege" },
      {
        name: "description",
        content:
          "What Liege ships next, in order: the jobs protocol first, then challenge panels, runtime adapters, and strategy controls.",
      },
      { property: "og:title", content: "Roadmap — Liege" },
      {
        property: "og:description",
        content:
          "What Liege ships next, in order: the jobs protocol first, then challenge panels, runtime adapters, and strategy controls.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: RoadmapPage,
});

function RoadmapPage() {
  return (
    <ClientOnly>
      <LiegeRoadmap />
    </ClientOnly>
  );
}
