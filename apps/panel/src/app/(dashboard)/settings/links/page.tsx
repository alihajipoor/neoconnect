import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { AppLinks } from "@/lib/types";
import { AppLinksCard } from "./app-links-card";

export default async function AppLinksPage() {
  await requireStaff();
  const links = await apiFetch<AppLinks>("/app-links");
  return <AppLinksCard links={links} />;
}
