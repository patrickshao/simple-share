export type ConnectionCheckResult = "available" | "public-only" | "local-only" | "no-candidates" | "unavailable" | "offline";

/** Probe capability and candidate gathering, never peer reachability. No SDP or IPs are retained. */
export async function checkConnection(
  createPeer: () => RTCPeerConnection,
  signal: AbortSignal,
  timeoutMs = 8_000,
): Promise<ConnectionCheckResult> {
  let peer: RTCPeerConnection;
  try { peer = createPeer(); } catch { return "unavailable"; }
  return new Promise(resolve => {
    let finished = false;
    let local = false;
    let publicPath = false;
    const finish = (result: ConnectionCheckResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      peer.close();
      resolve(result);
    };
    const result = () => publicPath ? local ? "available" : "public-only" : local ? "local-only" : "no-candidates";
    const abort = () => finish(result());
    const timer = setTimeout(() => finish(result()), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    peer.addEventListener("icecandidate", event => {
      if (finished) return;
      if (!event.candidate) { finish(result()); return; }
      const type = event.candidate.type;
      if (type === "host") local = true;
      if (type === "srflx" || type === "relay") publicPath = true;
    });
    void (async () => {
      try {
        peer.createDataChannel("connection-check");
        const offer = await peer.createOffer();
        if (!finished) await peer.setLocalDescription(offer);
      } catch { finish("unavailable"); }
    })();
  });
}
