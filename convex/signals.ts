import { findPair, tokenHash, credential } from "./pairing";
import { limitCreation } from "./limits";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";

const ROOM_TTL_MS = 10 * 60 * 1000;
const MAX_SIGNAL_LENGTH = 30_000;
const MAX_CANDIDATE_LENGTH = 2_000;
const MAX_CANDIDATES = 40;
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

const roomState = v.union(v.literal("waiting"), v.literal("joined"));

function assertCode(code: string) {
  if (!ROOM_CODE_PATTERN.test(code)) {
    throw new Error("Room code is invalid.");
  }
}

function assertSignal(signal: string) {
  if (signal.length < 20 || signal.length > MAX_SIGNAL_LENGTH) {
    throw new Error("Connection details are invalid.");
  }
}

function assertCandidate(candidate: string) {
  if (candidate.length < 2 || candidate.length > MAX_CANDIDATE_LENGTH) {
    throw new Error("Connection candidate is invalid.");
  }
}

export const createRoom = mutation({
  args: {
    code: v.string(),
    offer: v.string(),
    hostSecret: v.string(),
    pairing: v.optional(v.object(credential)),
  },
  returns: v.object({ expiresAt: v.number() }),
  handler: async (ctx, args) => {
    assertCode(args.code);
    assertSignal(args.offer);
    if (args.hostSecret.length < 32 || args.hostSecret.length > 128) {
      throw new Error("Host secret is invalid.");
    }

    const existing = await ctx.db
      .query("signalRooms")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();

    if (existing && existing.expiresAt > Date.now()) {
      throw new Error("That room code is already in use.");
    }
    if (existing) {
      await ctx.db.delete(existing._id);
    }

    const target = args.pairing ? await findPair(ctx, args.pairing.pairId, args.pairing.token) : null;
    if (args.pairing && (!target || !target.pair.confirmed || target.pair.expiresAt <= Date.now())) throw new Error("This device pairing expired or was removed.");
    if (target?.pair.invite && target.pair.invite.expiresAt > Date.now()) throw new Error("A connection request is already pending. Cancel it or wait for it to expire.");
    await limitCreation(ctx, "rooms");
    const expiresAt = Date.now() + ROOM_TTL_MS;
    const roomId = await ctx.db.insert("signalRooms", {
      code: args.code,
      ...(target ? { pairId: target.pair.pairId, guestPairHash: target.side === "a" ? target.pair.hashB : target.pair.hashA } : {}),
      offer: args.offer,
      hostSecret: args.hostSecret,
      hostCandidates: [],
      guestCandidates: [],
      state: "waiting",
      expiresAt,
    });

    if (target) await ctx.db.patch(target.pair._id, { invite: { code: args.code, from: target.side, expiresAt } });
    await ctx.scheduler.runAt(expiresAt, internal.signals.expireRoom, {
      roomId,
    });

    return { expiresAt };
  },
});

export const getRoomForJoin = query({
  args: { code: v.string(), pairingToken: v.optional(v.string()) },
  returns: v.union(
    v.null(),
    v.object({
      offer: v.string(),
      state: roomState,
      expiresAt: v.number(),
      hostCandidates: v.array(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    assertCode(args.code);
    const room = await ctx.db
      .query("signalRooms")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();

    if (!room || (room.guestPairHash && (!args.pairingToken || tokenHash(args.pairingToken) !== room.guestPairHash))) return null;
    if (room.pairId) {
      const pair = await findPair(ctx, room.pairId, args.pairingToken!);
      if (!pair || !pair.pair.confirmed) return null;
    }

    return {
      offer: room.offer,
      state: room.state,
      expiresAt: room.expiresAt,
      hostCandidates: room.hostCandidates ?? [],
    };
  },
});

export const getAnswerForHost = query({
  args: {
    code: v.string(),
    hostSecret: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      answer: v.optional(v.string()),
      state: roomState,
      expiresAt: v.number(),
      guestCandidates: v.array(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    assertCode(args.code);
    const room = await ctx.db
      .query("signalRooms")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();

    if (!room || room.hostSecret !== args.hostSecret) {
      return null;
    }

    return {
      answer: room.answer,
      state: room.state,
      expiresAt: room.expiresAt,
      guestCandidates: room.guestCandidates ?? [],
    };
  },
});

export const getHostCandidates = query({
  args: { code: v.string(), guestSecret: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    assertCode(args.code);
    const room = await ctx.db
      .query("signalRooms")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();
    if (!room || room.guestSecret !== args.guestSecret) return [];
    return room.hostCandidates ?? [];
  },
});

export const addHostCandidate = mutation({
  args: {
    code: v.string(),
    hostSecret: v.string(),
    candidate: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertCode(args.code);
    assertCandidate(args.candidate);
    const room = await ctx.db
      .query("signalRooms")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();
    if (!room || room.hostSecret !== args.hostSecret || room.expiresAt <= Date.now()) {
      return null;
    }
    const current = room.hostCandidates ?? [];
    if (current.includes(args.candidate) || current.length >= MAX_CANDIDATES) {
      return null;
    }
    await ctx.db.patch(room._id, { hostCandidates: [...current, args.candidate] });
    return null;
  },
});

export const addGuestCandidate = mutation({
  args: {
    code: v.string(),
    guestSecret: v.string(),
    candidate: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertCode(args.code);
    assertCandidate(args.candidate);
    const room = await ctx.db
      .query("signalRooms")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();
    if (!room || room.guestSecret !== args.guestSecret || room.expiresAt <= Date.now()) {
      return null;
    }
    const current = room.guestCandidates ?? [];
    if (current.includes(args.candidate) || current.length >= MAX_CANDIDATES) {
      return null;
    }
    await ctx.db.patch(room._id, { guestCandidates: [...current, args.candidate] });
    return null;
  },
});

export const joinRoom = mutation({
  args: {
    code: v.string(),
    answer: v.string(),
    guestSecret: v.string(),
    pairingToken: v.optional(v.string()),
  },
  returns: v.object({ expiresAt: v.number() }),
  handler: async (ctx, args) => {
    assertCode(args.code);
    assertSignal(args.answer);
    tokenHash(args.guestSecret);
    const room = await ctx.db
      .query("signalRooms")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();

    if (!room || room.expiresAt <= Date.now()) {
      throw new Error("This room expired. Ask the sender for a new code.");
    }
    if (room.guestPairHash && (!args.pairingToken || tokenHash(args.pairingToken) !== room.guestPairHash)) throw new Error("This room is reserved for a paired device.");
    if (room.pairId) {
      const pair = await findPair(ctx, room.pairId, args.pairingToken!);
      if (!pair || !pair.pair.confirmed || pair.pair.expiresAt <= Date.now()) throw new Error("This device pairing expired or was removed.");
    }
    if (room.answer) {
      throw new Error("Another device already joined this room.");
    }

    await ctx.db.patch(room._id, {
      answer: args.answer,
      guestSecret: args.guestSecret,
      state: "joined",
    });
    return { expiresAt: room.expiresAt };
  },
});

export const closeRoom = mutation({
  args: {
    code: v.string(),
    hostSecret: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertCode(args.code);
    const room = await ctx.db
      .query("signalRooms")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique();

    if (room && room.hostSecret === args.hostSecret) {
      if (room.pairId) {
        const pair = await ctx.db.query("devicePairs").withIndex("by_pairId", q => q.eq("pairId", room.pairId!)).unique();
        if (pair?.invite?.code === room.code) await ctx.db.patch(pair._id, { invite: undefined });
      }
      await ctx.db.delete(room._id);
    }
    return null;
  },
});

export const expireRoom = internalMutation({
  args: { roomId: v.id("signalRooms") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (room && room.expiresAt <= Date.now()) {
      await ctx.db.delete(args.roomId);
    }
    return null;
  },
});
