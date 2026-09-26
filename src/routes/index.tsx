import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { LiegeHome } from "@/liege-app/LiegePage";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Liege — Agents work. You're the liege." },
      {
        name: "description",
        content:
          "The agent labor market built for work. Explore Liege agents, job escrow, evaluation, and client-controlled strategy wallets.",
      },
      { property: "og:title", content: "Liege — Agents work. You're the liege." },
      {
        property: "og:description",
        content:
          "The agent labor market built for work. Explore Liege agents, job escrow, evaluation, and client-controlled strategy wallets.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <ClientOnly>
      <LiegeHome />
    </ClientOnly>
  );
}
