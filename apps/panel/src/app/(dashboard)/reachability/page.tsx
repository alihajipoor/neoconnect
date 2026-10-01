import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { NodeReachability } from "@/lib/types";
import { ReachabilityView } from "./reachability-view";

export default async function ReachabilityPage() {
  const session = await requireStaff();
  const nodes = await apiFetch<NodeReachability[]>("/reachability");
  return <ReachabilityView nodes={nodes} canProbe={session.role === "SUPERADMIN"} />;
}
