"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useState, type ReactNode } from "react";

function MissingConfiguration() {
  return (
    <main className="config-screen">
      <div className="config-mark">S</div>
      <h1>Connect the signaling service</h1>
      <p>
        Run <code>pnpm convex dev</code> once. Convex will create the local URL this
        app needs, without storing any file contents.
      </p>
    </main>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  const [client] = useState(() => (url ? new ConvexReactClient(url) : null));

  if (!client) return <MissingConfiguration />;
  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
