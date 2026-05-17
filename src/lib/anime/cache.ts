/**
 * In-memory cache with per-resource TTLs.
 *
 * TTLs (seconds):
 *   search    300   (5 min)
 *   details  1800   (30 min)
 *   episodes  600   (10 min)
 *   servers   300   (5 min)
 *   numericId 86400 (24 h — stable identifier)
 *   streams are NOT cached (time-scoped CDN tokens)
 */
import NodeCache from "node-cache";

const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

export function cacheGet<T>(key: string): T | undefined {
  return cache.get<T>(key);
}

export function cacheSet<T>(key: string, value: T, ttl = 300): void {
  cache.set(key, value, ttl);
}

export function cacheDel(key: string): void {
  cache.del(key);
}

/** TTL constants (seconds) for callers that want explicit values */
export const TTL = {
  SEARCH: 300,       // 5 min
  DETAILS: 1800,     // 30 min
  EPISODES: 600,     // 10 min
  SERVERS: 300,      // 5 min
  NUMERIC_ID: 86400, // 24 h
} as const;
