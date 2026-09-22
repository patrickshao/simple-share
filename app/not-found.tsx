import Link from "next/link";
import { Icon } from "@/components/icon";

export default function NotFound() {
  return (
    <main className="config-screen">
      <span className="brand-mark" aria-hidden="true"><Icon name="send" /></span>
      <h1>This page isn’t here</h1>
      <p>Return to Simple Share to send files or enter a room code.</p>
      <Link className="primary-button recovery-link" href="/">Open Simple Share</Link>
    </main>
  );
}
