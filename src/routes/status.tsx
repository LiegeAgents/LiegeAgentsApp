import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { LiegeStatus } from "@/liege-app/LiegePage";

export const Route = createFileRoute("/status")({
  head: () => ({
    meta: [
      { title: "System status — Liege" },
      {
        name: "description",
        content: "Whether the Liege API answers and which verified Super Agents are online now.",
      },
      { property: "og:title", content: "System status — Liege" },
      {
        property: "og:description",
        content: "Whether the Liege API answers and which verified Super Agents are online now.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: StatusPage,
});

function StatusPage() {
  return (
    <ClientOnly>
      <LiegeStatus />
    </ClientOnly>
  );
}
