"use client";

import { useEffect, useState } from "react";

export function QuickStart({ mode = "send" }: { mode?: "send" | "receive" }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    try { setVisible(localStorage.getItem("simple-share:quick-start-seen") !== "1"); }
    catch { setVisible(true); }
  }, []);
  function dismiss() {
    setVisible(false);
    try { localStorage.setItem("simple-share:quick-start-seen", "1"); } catch { /* Optional preference. */ }
  }
  if (!visible) return null;
  return <aside className="quick-start" aria-label="Quick start">
    <div className="quick-start-heading"><strong>Files, straight to another device.</strong><button className="text-button" onClick={dismiss}>Got it</button></div>
    {mode === "send"
      ? <ol><li>Choose files</li><li>Share the room</li><li>Accept on the other device</li></ol>
      : <ol><li>Get the sender’s room code</li><li>Join the room</li><li>Accept and save the files</li></ol>}
  </aside>;
}
