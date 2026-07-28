import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import type {NextConfig} from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The design system is workspace source, not a published package.
  transpilePackages: ["@plazo/ui"],
  turbopack: {
    // Pinned explicitly. Next walks upward looking for a lockfile and finds a stray
    // one above the repo, so inference picks the wrong root and resolves workspace
    // packages against it.
    root: join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
  },
};

export default config;
