import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { sha256Fallback } from "../lib/peer";
import { limitCreation } from "./limits";

export const credential = { pairId: v.string(), token: v.string() };
const credentials = v.object(credential);
const PAIR_TTL = 30 * 24 * 60 * 60 * 1000;
export function tokenHash(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid device credential.");
  return Array.from(sha256Fallback(new TextEncoder().encode(token)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function findPair(ctx: QueryCtx | MutationCtx, pairId: string, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(pairId)) throw new Error("Invalid pairing.");
  const hash = tokenHash(token);
  const pair = await ctx.db.query("devicePairs").withIndex("by_pairId", q => q.eq("pairId", pairId)).unique();
  if (!pair || (pair.hashA !== hash && pair.hashB !== hash)) return null;
  return { pair, side: pair.hashA === hash ? "a" as const : "b" as const };
}

export const create = mutation({
  args: { pairId: v.string(), tokenA: v.string(), hashB: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(args.pairId) || !/^[a-f0-9]{64}$/.test(args.hashB)) throw new Error("Invalid pairing.");
    const hashA = tokenHash(args.tokenA);
    if (hashA === args.hashB) throw new Error("Device credentials must differ.");
    const existing = await ctx.db.query("devicePairs").withIndex("by_pairId", q => q.eq("pairId", args.pairId)).unique();
    if (existing) throw new Error("Pairing already exists.");
    await limitCreation(ctx, "pairs");
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const id = await ctx.db.insert("devicePairs", { pairId: args.pairId, hashA, hashB: args.hashB, confirmed: false, aSeen: 0, bSeen: 0, expiresAt });
    await ctx.scheduler.runAt(expiresAt, internal.pairing.expire, { id });
    return null;
  },
});
export const confirm = mutation({
  args: credential,
  returns: v.null(),
  handler: async (ctx, args) => {
    const found = await findPair(ctx, args.pairId, args.token);
    if (!found || found.side !== "b" || found.pair.expiresAt <= Date.now()) throw new Error("Pairing expired. Connect again to remember this device.");
    if (!found.pair.confirmed) {
      const expiresAt = Date.now() + PAIR_TTL;
      await ctx.db.patch(found.pair._id, { confirmed: true, expiresAt });
      await ctx.scheduler.runAt(expiresAt, internal.pairing.expire, { id: found.pair._id });
    }
    return null;
  },
});
export const list = query({
  args: { devices: v.array(credentials) },
  returns: v.array(v.object({ pairId: v.string(), confirmed: v.boolean(), expiresAt: v.number(), peerLastSeen: v.number(), invite: v.union(v.null(), v.object({ code: v.string(), expiresAt: v.number() })) })),
  handler: async (ctx, args) => {
    if (args.devices.length > 20) throw new Error("Too many paired devices.");
    const result = [];
    for (const device of args.devices) {
      const found = await findPair(ctx, device.pairId, device.token);
      if (!found) continue;
      const { pair, side } = found;
      result.push({ pairId: pair.pairId, confirmed: pair.confirmed, expiresAt: pair.expiresAt, peerLastSeen: side === "a" ? pair.bSeen : pair.aSeen,
        invite: pair.invite && pair.invite.from !== side ? { code: pair.invite.code, expiresAt: pair.invite.expiresAt } : null });
    }
    return result;
  },
});
export const heartbeat = mutation({
  args: { devices: v.array(credentials) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.devices.length > 20) throw new Error("Too many paired devices.");
    for (const device of args.devices) {
      const found = await findPair(ctx, device.pairId, device.token);
      if (!found || !found.pair.confirmed || found.pair.expiresAt <= Date.now()) continue;
      const key = found.side === "a" ? "aSeen" : "bSeen";
      if (Date.now() - found.pair[key] >= 15_000) await ctx.db.patch(found.pair._id, { [key]: Date.now() });
    }
    return null;
  },
});
export const clearInvite = mutation({
  args: { ...credential, code: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const found = await findPair(ctx, args.pairId, args.token);
    if (found?.pair.invite?.code === args.code) {
      await ctx.db.patch(found.pair._id, { invite: undefined });
      const room = await ctx.db.query("signalRooms").withIndex("by_code", q => q.eq("code", args.code)).unique();
      if (room?.pairId === args.pairId) await ctx.db.delete(room._id);
    }
    return null;
  },
});
export const forget = mutation({
  args: credential, returns: v.null(),
  handler: async (ctx, args) => {
    const found = await findPair(ctx, args.pairId, args.token);
    if (found) {
      const rooms = await ctx.db.query("signalRooms").withIndex("by_pairId", q => q.eq("pairId", args.pairId)).take(20);
      for (const room of rooms) await ctx.db.delete(room._id);
      await ctx.db.delete(found.pair._id);
    }
    return null;
  },
});
export const expire = internalMutation({
  args: { id: v.id("devicePairs") }, returns: v.null(),
  handler: async (ctx, args) => {
    const pair = await ctx.db.get(args.id);
    if (pair && pair.expiresAt <= Date.now()) await ctx.db.delete(pair._id);
    return null;
  },
});
