import { existsSync } from "node:fs";
import { join } from "node:path";

/** agent.proto lives in packages/proto/ at the monorepo root, but where
 * that ends up relative to this compiled file differs between local dev
 * (apps/backend/dist/... inside the checked-out monorepo) and the
 * production Docker image (apps/backend/Dockerfile copies it to /app/proto
 * directly, since packages/ isn't part of the runtime image otherwise).
 * Try both rather than hard-coding one. */
export function resolveProtoPath(): string {
  const candidates = [
    join(__dirname, "../../../proto/agent.proto"), // Docker runtime image: /app/proto/agent.proto
    join(__dirname, "../../../../../packages/proto/agent.proto"), // monorepo dev: apps/backend/dist/modules/agent-gateway -> repo root
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`agent.proto not found. Tried:\n${candidates.join("\n")}`);
  }
  return found;
}
