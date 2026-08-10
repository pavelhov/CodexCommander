import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { browserSecurityHeaders } from "./auth-cors";

/** CodexCommander version, read from the packaged package.json (same source as the server bootstrap). */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon",
};

function findGuiDist(): string | null {
  const candidates = [
    join(import.meta.dir, "..", "..", "gui", "dist"),
    join(import.meta.dir, "..", "..", "..", "gui", "dist"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "index.html"))) return c;
  }
  return null;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Static assets are an application boundary, not merely a path-normalisation problem.
 * Resolve the root and candidate physically, and refuse links or hard-linked files so
 * a compromised/stale GUI build cannot expose files outside its own generated tree.
 */
function physicalGuiDist(guiDist: string): string | null {
  try {
    const stat = lstatSync(guiDist);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    return realpathSync(guiDist);
  } catch {
    return null;
  }
}

function safeGuiFile(root: string, candidate: string): string | null {
  try {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return null;
    const physical = realpathSync(candidate);
    return isContained(root, physical) ? physical : null;
  } catch {
    return null;
  }
}

export function resolveGuiFilePath(guiDist: string, pathname: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes("\0")) return null;

  const relativePath = decodedPath === "/" || decodedPath === ""
    ? "index.html"
    : decodedPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const root = resolve(guiDist);
  const filePath = resolve(root, relativePath);
  const rel = relative(root, filePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return filePath;
}

function htmlDocumentResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...browserSecurityHeaders(),
    },
  });
}

function htmlResponse(path: string): Response {
  return htmlDocumentResponse(readFileSync(path, "utf8"));
}

export function serveGuiFile(
  pathname: string,
  guiDist = findGuiDist(),
): Response | null {
  if (!guiDist) return null;
  const root = physicalGuiDist(guiDist);
  if (!root) return null;
  const requestedPath = resolveGuiFilePath(root, pathname);
  if (!requestedPath) return null;
  const filePath = safeGuiFile(root, requestedPath);

  if (!filePath) {
    if (!extname(pathname)) {
      const indexPath = safeGuiFile(root, join(root, "index.html"));
      if (indexPath) {
        return htmlResponse(indexPath);
      }
    }
    return null;
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  if (ext === ".html") return htmlResponse(filePath);
  return new Response(Bun.file(filePath), {
    headers: { "Content-Type": contentType, ...browserSecurityHeaders() },
  });
}

export function rootFallbackPayload() {
  return {
    status: "ok",
    service: "codexcommander",
    version: VERSION,
    dashboard: {
      available: false,
      reason: "GUI build not found. Run `bun run build:gui` from the CodexCommander repo, or use `ccx gui` from a packaged install.",
    },
    endpoints: {
      health: "/healthz",
      models: "/v1/models",
      responses: "/v1/responses",
      chatCompletions: "/v1/chat/completions",
      management: "/api/*",
    },
  };
}
