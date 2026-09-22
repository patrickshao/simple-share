import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  signalRooms: defineTable({
    code: v.string(),
    pairId: v.optional(v.string()),
    guestPairHash: v.optional(v.string()),
    guestSecret: v.optional(v.string()),
    offer: v.string(),
    answer: v.optional(v.string()),
    hostSecret: v.string(),
    hostCandidates: v.optional(v.array(v.string())),
    guestCandidates: v.optional(v.array(v.string())),
    state: v.union(v.literal("waiting"), v.literal("joined")),
    expiresAt: v.number(),
  }).index("by_code", ["code"]).index("by_pairId", ["pairId"]),
  devicePairs: defineTable({
    pairId: v.string(), hashA: v.string(), hashB: v.string(),
    confirmed: v.boolean(), aSeen: v.number(), bSeen: v.number(), expiresAt: v.number(),
    invite: v.optional(v.object({ code: v.string(), from: v.union(v.literal("a"), v.literal("b")), expiresAt: v.number() })),
  }).index("by_pairId", ["pairId"]),
});
