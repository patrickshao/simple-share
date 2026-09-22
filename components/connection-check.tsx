"use client";

import { useEffect, useRef, useState } from "react";
import { createPeerConnection } from "@/lib/peer";
import { checkConnection, type ConnectionCheckResult } from "@/lib/connection-check";

const messages: Record<ConnectionCheckResult, string> = {
  "public-only": "No local routes were exposed. Browser privacy settings may prevent same-Wi-Fi transfers. Try another browser or review Brave’s WebRTC IP handling policy.",
  available: "Browser check passed. A connection to the other device still needs to be tested when you join.",
  "local-only": "Local connection options found. Internet discovery did not respond; a same-network transfer may still work.",
  "no-candidates": "No connection options found. Browser privacy settings, a VPN, or this network may be blocking WebRTC.",
  unavailable: "This browser could not start WebRTC. Try an updated Chrome or Samsung Internet browser.",
  offline: "This device appears offline. Connect to a network, then check again.",
};

export function ConnectionCheck() {
  const [result, setResult] = useState<ConnectionCheckResult | null>(null);
  const [running, setRunning] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(/Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2);
  }, []);

  async function run() {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setRunning(true);
    const next = navigator.onLine
      ? await checkConnection(createPeerConnection, current.signal)
      : "offline";
    if (current.signal.aborted) return;
    setResult(next);
    setRunning(false);
  }

  useEffect(() => {
    void run();
    const refresh = () => { void run(); };
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    return () => {
      controller.current?.abort();
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
    };
  }, []);

  const support = running ? "Checking" : result === "offline" ? "Not checked" : result === "unavailable" ? "Unavailable" : "Supported";
  const discovery = running ? "Checking" : (result === "available" || result === "public-only") ? "Responding" : result === "local-only" ? "Local options found" : result === "no-candidates" ? "No options found" : "Not checked";
  return <section className="connection-trouble" aria-label="Connection help">
    <strong role="alert">Couldn’t connect the devices</strong>
    {isMac
      ? <p>On Mac, enable your browser in <strong>System Settings → Privacy &amp; Security → Local Network</strong>. Reopen the browser and try a new room.</p>
      : <p>Check local-network permissions on both devices. Try the same Wi-Fi without a VPN.</p>}
    <details className="connection-check">
      <summary>Technical details</summary>
      <div className="check-content" aria-live="polite" aria-busy={running}>
        <dl className="check-results">
          <div><dt>Browser support</dt><dd>{support}</dd></div>
          <div><dt>Network discovery</dt><dd>{discovery}</dd></div>
        </dl>
        {!running && result && <p>{messages[result]}</p>}
        <p>These checks cannot read system permissions or confirm access to the other device.</p>
        <button className="text-button" disabled={running} onClick={() => void run()}>{running ? "Checking…" : "Run checks again"}</button>
      </div>
    </details>
  </section>;
}
