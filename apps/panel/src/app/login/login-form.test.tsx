import { readFileSync } from "node:fs";
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// What Next's compiler makes of a "use server" import inside a client
// component: a server reference, from the same React Flight client Next
// renders with. Its $$FORM_ACTION is what lets the server-rendered form
// post to the action before any script has run.
vi.mock("./actions", async () => {
  const { createServerReference } = await import("next/dist/compiled/react-server-dom-webpack/client.node");
  return {
    loginAction: createServerReference("login-action-test-id"),
    requestLoginChallenge: createServerReference("login-challenge-test-id"),
  };
});

import { LoginForm } from "./login-form";

/** The page's HTML as the server sends it, before any script runs. A
 * stream, not renderToString: encoding useActionState's bound action for
 * the form is asynchronous. */
async function serverHtml(): Promise<string> {
  const stream = await renderToReadableStream(<LoginForm />);
  await stream.allReady;
  return new Response(stream).text();
}

describe("the server-rendered sign-in form", () => {
  // Before hydration -- a slow or filtered link, a script that failed to
  // load, Enter straight after autofill -- the browser submits the form
  // natively. A form with no method and no action is a GET to the page
  // itself: the admin password in the URL, so in nginx's access log, the
  // browser's history and the next request's Referer.
  it("posts to the sign-in action, never a GET that puts the password in the URL", async () => {
    const html = await serverHtml();
    const form = html.match(/<form\b[^>]*>/)?.[0] ?? "";
    expect(html).toContain('name="password"');
    expect(form).toMatch(/\bmethod="POST"/);
    expect(form).toMatch(/\benctype="multipart\/form-data"/i);
    expect(form).not.toMatch(/\baction="javascript:/);
    // The fields Next's server reads to know which action the post is for.
    expect(html).toMatch(/<input type="hidden" name="\$ACTION_REF_[^"]*"/);
    expect(html).toMatch(/<input type="hidden" name="\$ACTION_KEY"/);
  });
});

describe("moving from the password step to the code step", () => {
  // A source check: this suite has no DOM to hydrate into. The behaviour
  // itself was checked in a browser against `next start` -- before the
  // fix, the code box held the password in clear text (journal,
  // 2026-10-06, "panel review fixes, second round").
  const source = readFileSync(new URL("./login-form.tsx", import.meta.url), "utf8");

  it("clears the fields as React does for an action it runs itself", () => {
    expect(source).toMatch(/startTransition\(\(\) => \{[^}]*requestFormReset\(element\);\s*formAction\(form\);\s*\}\)/);
  });

  it("never reuses the password <input> as the code box", () => {
    expect(source).toContain('<Fragment key="code-step">');
    expect(source).toContain('<Fragment key="password-step">');
  });
});
