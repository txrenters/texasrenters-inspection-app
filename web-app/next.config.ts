import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Next can clean the conventional `.next` directory during a production build.
  // Keep development and production manifests fully isolated from that directory.
  distDir: process.env.NODE_ENV === 'production' ? '.next-build' : '.next-dev',
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
