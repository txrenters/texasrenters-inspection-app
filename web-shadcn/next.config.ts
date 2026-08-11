import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Next can clean the conventional `.next` directory during a production build.
  // Keep development and production manifests fully isolated from that directory.
  distDir: process.env.NODE_ENV === 'production' ? '.next-build' : '.next-dev',
  // Emit a self-contained server bundle so a Docker runtime stage needs no
  // node_modules and no package manager.
  output: 'standalone',
  // The default trace root is this package. In a pnpm workspace that misses the
  // symlinked @texasrenters/shared package and any hoisted dependency living at
  // the repository root, which produces an image that starts and then fails on
  // the first import. Anchoring the trace at the workspace root includes them.
  outputFileTracingRoot: path.join(process.cwd(), '..'),
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
