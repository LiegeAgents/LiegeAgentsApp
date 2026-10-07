import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import AdminPage from "@/liege-app/AdminPage";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Admin — Liege" }] }),
  component: () => (
    <ClientOnly>
      <AdminPage />
    </ClientOnly>
  ),
});
