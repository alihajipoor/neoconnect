import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** One route the backend serves, read off the decorators. */
export interface RouteInfo {
  method: string;
  /** Joined and normalised: "/customer/subscriptions/:id/routes". */
  path: string;
  controller: new (...args: never[]) => unknown;
  handler: string;
  /** Controller-level guards first, then the handler's. */
  guards: unknown[];
}

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...controllerFiles(full));
    else if (entry.name.endsWith(".controller.ts")) out.push(full);
  }
  return out;
}

function asList(value: unknown): string[] {
  if (value === undefined) return [""];
  return Array.isArray(value) ? (value as string[]) : [value as string];
}

function join2(base: string, path: string): string {
  const segments = `${base}/${path}`.split("/").filter(Boolean);
  return `/${segments.join("/")}`;
}

/** Every route of every controller under src/, enumerated from the
 * router's own metadata -- so a test written against this list covers an
 * endpoint added after it was written. */
export function collectRoutes(): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const src = join(__dirname, "..", "src");
  for (const file of controllerFiles(src)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exported = require(file) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (typeof value !== "function") continue;
      const base = Reflect.getMetadata(PATH_METADATA, value) as unknown;
      if (base === undefined) continue;
      const controller = value as RouteInfo["controller"];
      const classGuards = (Reflect.getMetadata(GUARDS_METADATA, value) as unknown[] | undefined) ?? [];
      const proto = (value as { prototype: Record<string, unknown> }).prototype;
      for (const handler of Object.getOwnPropertyNames(proto)) {
        if (handler === "constructor") continue;
        const fn = proto[handler];
        if (typeof fn !== "function") continue;
        const path = Reflect.getMetadata(PATH_METADATA, fn) as unknown;
        if (path === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as number];
        const guards = [...classGuards, ...((Reflect.getMetadata(GUARDS_METADATA, fn) as unknown[] | undefined) ?? [])];
        for (const b of asList(base)) {
          for (const p of asList(path)) {
            routes.push({ method, path: join2(b, p), controller, handler, guards });
          }
        }
      }
    }
  }
  return routes;
}
