import { apiFetch } from "@/lib/api";
import { getSession, requireStaff } from "@/lib/session";
import type { Node } from "@/lib/types";
import { NodesTable } from "./nodes-table";

export default async function NodesPage() {
  await requireStaff();
  const [nodes, session] = await Promise.all([apiFetch<Node[]>("/nodes"), getSession()]);
  return <NodesTable nodes={nodes} canManage={session?.role === "SUPERADMIN"} />;
}
