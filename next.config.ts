import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // A stray lockfile in the parent folder makes Next guess the wrong workspace
  // root, so pin it to this project.
  turbopack: {
    root: path.resolve(__dirname),
  },
  // `next dev` keeps a lock on .next, so a production build run at the same time
  // fails with EPERM. Set NEXT_BUILD_DIR to build into a separate folder.
  distDir: process.env.NEXT_BUILD_DIR || '.next',
};

export default nextConfig;
