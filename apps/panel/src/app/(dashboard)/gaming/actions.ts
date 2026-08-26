"use server";

import { revalidatePath } from "next/cache";
import { apiFetch, apiMutate, type MutationResult } from "@/lib/api";
import type { GameProfile, GamingResolver, PlanFeatureGrant, PlanFeatureKey } from "@/lib/types";

/** The whole row behind a table row, for the edit form.
 *
 * `GET /gaming/profiles` stopped returning `notes`, `processNames` and
 * `destinationCidrs` when the 1,480-row catalogue was bounded, so the
 * list no longer carries enough to edit from. The form dialog calls this
 * when it opens and waits for the answer rather than pre-filling from the
 * row it was handed: a form showing three empty fields that are not
 * actually empty saves blanks over them on the first Save.
 *
 * Deliberately allowed to reject rather than returning a MutationResult.
 * `apiFetch` redirects to /login on an expired session, which a Server
 * Action performs properly, and that has to stay possible -- so the
 * caller catches the rejection and shows the failure instead of a form. */
export async function getGameProfile(id: string): Promise<GameProfile> {
  return apiFetch<GameProfile>(`/gaming/profiles/${id}`);
}

export interface GameProfileInput {
  slug: string;
  displayName: string;
  publisher?: string | null;
  iconKey?: string | null;
  /** Launcher, login, account, web and store hosts only. Realm/world
   * servers are handed to the game as literal addresses inside its own
   * session, so a resolver never sees them -- listing one here is
   * accepted everywhere and does nothing at runtime. */
  hostnames: string[];
  /** Left on the customer's own path on purpose. Patch and CDN hosts
   * belong here: a multi-gigabyte download pulled through a node eats a
   * metered plan's cap and the bill is ours. */
  excludeHostnames: string[];
  /** Per-game private exit only, which is not built. */
  processNames: string[];
  /** Per-game private exit only, which is not built. */
  destinationCidrs: string[];
  /** Per-game private exit only, which is not built. */
  destinationAsn?: string | null;
  prefixComplete: boolean;
  /** Must be one of `hostnames`. The client resolves it to prove the
   * rules are live; without it the client cannot report better than
   * "partial". */
  canaryHostname?: string | null;
  sortOrder: number;
  isActive: boolean;
  notes?: string | null;
}

export async function createGameProfile(
  input: GameProfileInput,
): Promise<MutationResult<GameProfile>> {
  const result = await apiMutate<GameProfile>("/gaming/profiles", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/gaming");
  return result;
}

export async function updateGameProfile(
  id: string,
  input: Partial<GameProfileInput>,
): Promise<MutationResult<GameProfile>> {
  const result = await apiMutate<GameProfile>(`/gaming/profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/gaming");
  return result;
}

export async function deleteGameProfile(id: string): Promise<MutationResult<void>> {
  const result = await apiMutate<void>(`/gaming/profiles/${id}`, { method: "DELETE" });
  if (result.ok) revalidatePath("/gaming");
  return result;
}

export interface GamingResolverInput {
  nodeId: string;
  dohHost: string;
  dohPort: number;
  proxyIp: string;
  proxyPort: number;
  isEnabled: boolean;
}

export async function createGamingResolver(
  input: GamingResolverInput,
): Promise<MutationResult<GamingResolver>> {
  const result = await apiMutate<GamingResolver>("/gaming/resolvers", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/gaming");
  return result;
}

export async function updateGamingResolver(
  id: string,
  input: Partial<GamingResolverInput>,
): Promise<MutationResult<GamingResolver>> {
  const result = await apiMutate<GamingResolver>(`/gaming/resolvers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  if (result.ok) revalidatePath("/gaming");
  return result;
}

export async function deleteGamingResolver(id: string): Promise<MutationResult<void>> {
  const result = await apiMutate<void>(`/gaming/resolvers/${id}`, { method: "DELETE" });
  if (result.ok) revalidatePath("/gaming");
  return result;
}

/**
 * Replaces a plan's whole feature set, which is why it is a PUT.
 *
 * An empty array is a meaningful payload and is sent deliberately: it
 * revokes every feature on the plan. The same reasoning as the plan
 * form's `allowedRouteIds` -- if this were a partial update, an operator
 * unticking the last box would watch nothing happen.
 */
export async function setPlanFeatures(
  planId: string,
  features: PlanFeatureKey[],
): Promise<MutationResult<PlanFeatureGrant>> {
  const result = await apiMutate<PlanFeatureGrant>(`/gaming/plan-features/${planId}`, {
    method: "PUT",
    body: JSON.stringify({ features }),
  });
  if (result.ok) revalidatePath("/gaming");
  return result;
}
