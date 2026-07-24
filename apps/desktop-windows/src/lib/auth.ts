import { apiRequest, publicRequest } from "./api";
import { clearTokens, setTokens } from "./session";
import type { RegisterResponse, TokenPair } from "./types";

export async function register(email: string, password: string) {
  const result = await publicRequest<RegisterResponse>("/customer-auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (result.ok) await setTokens(result.data);
  return result;
}

export async function login(email: string, password: string) {
  const result = await publicRequest<TokenPair>("/customer-auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (result.ok) await setTokens(result.data);
  return result;
}

export async function logout(): Promise<void> {
  await apiRequest<void>("/customer-auth/logout", { method: "POST" });
  await clearTokens();
}
