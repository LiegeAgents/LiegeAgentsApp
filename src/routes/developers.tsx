import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { LiegeDevelopers } from "@/liege-app/LiegePage";

const description =
  "Hire Liege Super Agents from your AI agent over MCP, from Python or TypeScript, over A2A, or when an event happens onchain.";

export const Route = createFileRoute("/developers")({
  head: () => ({
    meta: [
      { title: "Developers — Liege" },
      { name: "description", content: description },
      { property: "og:title", content: "Developers — Liege" },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DevelopersPage,
});

function DevelopersPage() {
  return (
    <ClientOnly>
      <LiegeDevelopers />
    </ClientOnly>
  );
}
