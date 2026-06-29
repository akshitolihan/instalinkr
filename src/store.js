import fs from "node:fs/promises";
import path from "node:path";
import { Redis } from "@upstash/redis";

const DATA_DIR = path.resolve("data");
const DATA_FILE = path.join(DATA_DIR, "db.json");
const REDIS_KEY = process.env.STORE_REDIS_KEY || "instagram-dm-funnel:store";

const initialData = {
  accounts: [],
  campaigns: [],
  leads: [],
  events: []
};

// Older stored data may predate multi-tenancy; make sure every collection key
// exists so callers never hit undefined.
function normalize(data) {
  const d = data || {};
  d.accounts ||= [];
  d.campaigns ||= [];
  d.leads ||= [];
  d.events ||= [];
  d.otps ||= [];
  return d;
}

globalThis.__DM_FUNNEL_STORE__ ||= structuredClone(initialData);

function createRedisClient() {
  // Support Upstash direct credentials OR Vercel KV (which is Upstash under the hood)
  const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "").trim();

  if (!url || !url.startsWith("https://") || !token) return null;

  try {
    return new Redis({ url, token });
  } catch (e) {
    console.error("[store] Redis client init failed:", e.message);
    return null;
  }
}

const redis = createRedisClient();

export const storeBackend = redis ? "redis" : (process.env.VERCEL ? "memory" : "file");

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify(initialData, null, 2));
  }
}

export async function readStore() {
  if (redis) {
    try {
      const data = await redis.get(REDIS_KEY);
      return normalize(data || structuredClone(initialData));
    } catch (e) {
      console.error("[store] Redis read failed, falling back to memory:", e.message);
    }
  }

  if (process.env.VERCEL) {
    return normalize(globalThis.__DM_FUNNEL_STORE__);
  }

  await ensureStore();
  const raw = await fs.readFile(DATA_FILE, "utf8");
  return normalize(JSON.parse(raw));
}

export async function writeStore(data) {
  if (redis) {
    try {
      await redis.set(REDIS_KEY, data);
      return;
    } catch (e) {
      console.error("[store] Redis write failed, falling back to memory:", e.message);
    }
  }

  if (process.env.VERCEL) {
    globalThis.__DM_FUNNEL_STORE__ = data;
    return;
  }

  await ensureStore();
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

export async function mutateStore(mutator) {
  const data = await readStore();
  const result = await mutator(data);
  await writeStore(data);
  return result;
}

export function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function nowIso() {
  return new Date().toISOString();
}
