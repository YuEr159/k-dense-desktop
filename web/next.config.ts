import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { resolve } from "path";

function readAppVersion(): string {
  // The server package is the source of truth for the app version (it's what
  // the README badge and release tags track). Reading it here keeps the
  // frontend's update check honest — a stale fallback makes every published
  // GitHub release look "newer" and shows a false "update available" banner.
  try {
    const pkg = readFileSync(resolve(__dirname, "..", "server", "package.json"), "utf-8");
    const version = (JSON.parse(pkg) as { version?: string }).version;
    if (version) return version;
  } catch {
    // fall through to default
  }
  return "0.0.0";
}

const nextConfig: NextConfig = {
  devIndicators: false,
  output: "standalone",
  async headers() {
    return [{ source: "/office/:path*", headers: [
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
    ] }];
  },
  // Next 16.3 otherwise writes AGENTS.md/CLAUDE.md into web/ on every dev start.
  agentRules: false,
  // The repo-root package.json (npm-start wrapper, no lockfile) makes Turbopack
  // infer the monorepo root as its workspace root, which breaks module
  // resolution (e.g. tailwindcss) against web/node_modules.
  turbopack: {
    root: __dirname,
  },
  // Next's dev server treats the hostname it bound to as the only same-origin
  // one, and blocks `/_next/*` (HMR, and the client entry chunks) for every
  // other spelling of loopback. The desktop shell navigates to
  // `http://127.0.0.1:3000` while the dev server reports `localhost:3000`, so
  // the page rendered its server HTML and then never hydrated — a permanent
  // "Loading projects…". Both spellings reach the same backend, so allow both.
  allowedDevOrigins: ["localhost", "127.0.0.1", "[::1]"],
  env: {
    NEXT_PUBLIC_APP_VERSION: readAppVersion(),
  },
};

export default nextConfig;
