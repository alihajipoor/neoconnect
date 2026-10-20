import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { BlockWatchOverview } from "@/lib/types";
import { BlockWatchView } from "./block-watch-view";

export default async function BlockWatchPage() {
  const session = await requireStaff();
  const overview = await apiFetch<BlockWatchOverview>("/block-watch");
  return <BlockWatchView overview={overview} canAct={session.role === "SUPERADMIN"} />;
}
