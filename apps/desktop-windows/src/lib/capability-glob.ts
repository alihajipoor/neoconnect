/** Tauri's URL globs, close enough to check a capability file against.
 *
 * Lifted out of api-endpoints.scope.test.ts so the mobile client's test
 * can assert the same thing about its own capability file. Two copies of
 * this would be worse than none: the halves behave differently, and a
 * copy that drifted would keep passing while checking the wrong shape.
 *
 * The difference between the halves is the whole point. In the
 * authority, `*` must not cross a label boundary, or `*.example.com`
 * would quietly cover somebody else's domain. In the path it spans
 * everything, which is how `https://*.example.com/*` reaches
 * `/api/customer/me` in the live app.
 *
 * Not a reimplementation of Tauri's matcher and not trying to be. It is
 * here to catch an endpoint with no glob covering it at all, which is
 * the fault that has shipped twice.
 */
export function matchesCapabilityGlob(pattern: string, url: string): boolean {
  const escape = (part: string) => part.replace(/[.+?^${}()|[\]\\]/g, (ch) => "\\" + ch);
  const split = (value: string): [string, string] => {
    const at = value.indexOf("/", value.indexOf("://") + 3);
    return at === -1 ? [value, ""] : [value.slice(0, at), value.slice(at)];
  };

  const [patternHost, patternPath] = split(pattern);
  const source =
    "^" +
    patternHost.split("*").map(escape).join("[^/.]*") +
    patternPath.split("*").map(escape).join(".*") +
    "$";
  return new RegExp(source).test(url);
}

/** The `http:default` allow list out of a parsed capability file, or
 * undefined when there is none -- which would mean every request is
 * denied, and is worth asserting separately rather than treating as an
 * empty list. */
export function httpAllowList(capability: unknown): { url: string }[] | undefined {
  type Permission = string | { identifier: string; allow?: { url: string }[] };
  const permissions = (capability as { permissions?: Permission[] }).permissions ?? [];
  return permissions
    .filter((p): p is Exclude<Permission, string> => typeof p !== "string")
    .find((p) => p.identifier === "http:default")?.allow;
}

/** Names an endpoint for a test title or a failure message without
 * printing it.
 *
 * This repository is public, and so are its CI logs. A failing scope
 * assertion used to print the endpoint it could not match, and an
 * `it.each` over the endpoint list put each address in a test title --
 * so any red build published the current node mirrors and panel
 * alternates to anyone reading the Actions output.
 *
 * That is the exact thing docs/node-address-hygiene.md exists to
 * prevent, and its reasoning applies here unchanged: the old names are
 * already burned, while the new ones are only useful for as long as
 * nobody has a list of them. A test that leaks them on failure is a
 * worse leak than one in source, because nobody reviews it.
 *
 * The index and the port are enough to act on -- they say which entry
 * of the bundle is uncovered and which kind of endpoint it is -- and
 * neither is a secret.
 */
export function describeEndpoint(url: string, index: number): string {
  let port = "default";
  try {
    const parsed = new URL(url);
    port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    // Not a URL we can parse is still worth counting, and its shape is
    // not worth guessing at.
  }
  return `endpoint ${index + 1} (port ${port})`;
}
