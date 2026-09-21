import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1"],
  async rewrites() {
    const apiBaseUrl = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4310";
    return [{ source: "/api/:path*", destination: `${apiBaseUrl}/api/:path*` }];
  },
};

export default nextConfig;
