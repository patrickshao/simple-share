import { normalizePrivateIpv4 } from "@/lib/peer";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  // Next fills this header from the socket in local development. Browsers cannot
  // set X-Forwarded-For themselves, and this route is used only by LAN-hosted pages.
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0] ?? "";
  return Response.json(
    { address: normalizePrivateIpv4(forwarded) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
