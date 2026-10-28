import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/game.html" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
