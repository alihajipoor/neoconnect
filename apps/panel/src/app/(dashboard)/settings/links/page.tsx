import { apiFetch } from "@/lib/api";
import type { AppLinks } from "@/lib/types";
import { AppLinksCard } from "./app-links-card";

export default async function AppLinksPage() {
  const links = await apiFetch<AppLinks>("/app-links");
  return <AppLinksCard links={links} />;
}
