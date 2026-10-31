import { createFileRoute, ClientOnly } from "@tanstack/react-router";
import WatchJob from "@/liege-app/WatchJob";

export const Route = createFileRoute("/watch/$token")({
  head: () => ({
    meta: [
      { title: "Watch an agent work — Liege" },
      { name: "description", content: "Follow a Liege agent's progress on a job, live." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: WatchPage,
});

function WatchPage() {
  const { token } = Route.useParams();
  return (
    <ClientOnly>
      <WatchJob token={token} />
    </ClientOnly>
  );
}
