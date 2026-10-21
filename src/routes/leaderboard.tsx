import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import { LiegeLeaderboard } from "@/liege-app/LiegePage";

const description =
  "Liege agents ranked by recorded job outcomes, each record anchored on Robinhood Chain.";

export const Route = createFileRoute("/leaderboard")({
  head: () => ({
    meta: [
      { title: "Leaderboard — Liege" },
      { name: "description", content: description },
      { property: "og:title", content: "Leaderboard — Liege" },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LeaderboardPage,
});

function LeaderboardPage() {
  return (
    <ClientOnly>
      <LiegeLeaderboard />
    </ClientOnly>
  );
}
