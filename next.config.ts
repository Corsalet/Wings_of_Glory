import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // socket.io/three — внешние серверные пакеты (встраивание мультиплеера, pages/api/wog.ts)
  serverExternalPackages: ["socket.io", "three"],
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
