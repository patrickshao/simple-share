import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

const detectedLanHosts = Object.values(networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .filter((address) => address.family === "IPv4" && !address.internal)
  .map((address) => address.address);

const configuredLanHost = process.env.NEXT_PUBLIC_SIMPLE_SHARE_LAN_HOST;
const preferredLanHost = configuredLanHost || (process.env.NODE_ENV === "development" ? detectedLanHosts[0] : "") || "";
const allowedLanHosts = configuredLanHost
  ? [...detectedLanHosts, configuredLanHost]
  : detectedLanHosts;

const nextConfig: NextConfig = {
  agentRules: false,
  distDir: process.env.SIMPLE_SHARE_DIST_DIR || ".next",
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'none'; object-src 'none'" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ] }];
  },
  // Devices on the LAN need access to dev assets and the HMR WebSocket.
  allowedDevOrigins: ["127.0.0.1", "localhost", ...allowedLanHosts],
  env: {
    NEXT_PUBLIC_SIMPLE_SHARE_LAN_HOST: preferredLanHost,
  },
};

export default nextConfig;
