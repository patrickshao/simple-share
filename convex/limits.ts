import { RateLimiter, MINUTE, DAY } from "@convex-dev/rate-limiter";
import { ConvexError } from "convex/values";
import { components } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";

// Global buckets deliberately cannot be bypassed by rotating anonymous IDs.
// Constant bucket names also keep limiter storage bounded.
const limiter = new RateLimiter(components.rateLimiter, {
  roomsBurst: { kind: "token bucket", rate: 60, period: MINUTE, capacity: 60 },
  roomsDaily: { kind: "token bucket", rate: 2000, period: DAY, capacity: 2000 },
  pairsBurst: { kind: "token bucket", rate: 20, period: MINUTE, capacity: 20 },
  pairsDaily: { kind: "token bucket", rate: 200, period: DAY, capacity: 200 },
});

export async function limitCreation(ctx: MutationCtx, kind: "rooms" | "pairs") {
  for (const name of [`${kind}Burst`, `${kind}Daily`] as const) {
    const result = await limiter.limit(ctx, name);
    if (!result.ok) {
      // Throwing rolls back the entire mutation, including consumed tokens.
      throw new ConvexError("Simple Share is busy. Please try again later.");
    }
  }
}
