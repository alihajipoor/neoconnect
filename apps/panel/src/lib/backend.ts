// Server-only: the backend URL used for requests made from the Next.js
// server process. In production this is the Docker Compose service name
// (http://backend:4000, same internal network, no nginx hop needed); in
// local dev it's the backend's dev server port.
export function backendUrl(): string {
  return process.env.INTERNAL_API_URL ?? "http://localhost:4000";
}
