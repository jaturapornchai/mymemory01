import type { NextConfig } from 'next';

// Static export only: no API routes, no server components that need a server, no middleware.
const config: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default config;
