// The React Flight client Next renders with, which ships without types.
// login-form.test.tsx uses it to make the same server reference Next's
// compiler makes of a "use server" import.
declare module "next/dist/compiled/react-server-dom-webpack/client.node" {
  export function createServerReference(id: string): (...args: unknown[]) => Promise<unknown>;
}
