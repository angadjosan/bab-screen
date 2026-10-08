import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["better-sqlite3"],
  webpack(config) {
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ["**/.git/**", "**/.next/**", "**/node_modules/**", "**/.data/**"],
    };
    return config;
  },
};

export default nextConfig;
