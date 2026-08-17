import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  eslint: {
    /**
     * Linting happens through this workspace's own eslint.config.mjs, run as
     * `npm run lint:web`. Next's build-time pass is turned off because it expects
     * `eslint-config-next`, which this workspace has never declared.
     *
     * It used to pass anyway: web-app depended on that config and the hoisted
     * linker put it where this workspace could resolve it. Deleting web-app took
     * it away, and the build started failing on `@next/next/no-img-element`
     * disable comments referring to a rule that was no longer defined - a lint
     * failure inherited from a package this workspace never asked for.
     *
     * Adding eslint-config-next here is the better fix and should replace this
     * the next time the registry is reachable; it could not be installed when
     * this was written.
     */
    ignoreDuringBuilds: true,
  },
  // Next can clean the conventional `.next` directory during a production build.
  // Keep development and production manifests fully isolated from that directory.
  distDir: process.env.NODE_ENV === 'production' ? '.next-build' : '.next-dev',
  // Emit a self-contained server bundle so a Docker runtime stage needs no
  // node_modules and no package manager.
  output: 'standalone',
  // The default trace root is this package. In a workspace that misses the
  // symlinked @texasrenters/shared package and any hoisted dependency living at
  // the repository root, which produces an image that starts and then fails on
  // the first import. Anchoring the trace at the workspace root includes them.
  outputFileTracingRoot: path.join(process.cwd(), '..'),
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
