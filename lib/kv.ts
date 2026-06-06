// Upstash Redis client (replaces the deprecated @vercel/kv).
//
// Uses the same env vars Vercel KV exposed — KV_REST_API_URL / KV_REST_API_TOKEN
// — so no env changes are needed (Upstash's Redis.fromEnv() looks for
// UPSTASH_REDIS_REST_* instead, so we configure explicitly).
//
// Usage from an api/ handler:
//   import { redis } from '../lib/kv';
//   await redis.set('key', value);
//   const value = await redis.get<MyType>('key');

import { Redis } from '@upstash/redis';

export const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// Backwards-compatible alias for call sites that used the `kv` name.
export const kv = redis;
