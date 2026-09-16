import type { StashedChunk } from "@agentruntime/token-funnel";
import { parseCcrMarker } from "@agentruntime/token-funnel";

/**
 * Bounded LRU store for CCR (Compressed Content Recovery) chunks.
 *
 * ## Why this is a shared dependency and not tool-local
 *
 * `token-funnel` gives every caller `funnelReversible()`, which compresses to a budget
 * and leaves `<<ccr:HASH>>` sentinels where content was removed. That is only half a
 * mechanism: a marker nobody can expand is worse than a plain truncation, because it
 * *claims* the content is recoverable. The recovery half lived inside `packages/tools`
 * as a module-level Map, so `packages/tools` was the only cartridge that could honestly
 * compress. Every other tool that returns bulk text — youtube-transcript, web-fetch —
 * had to choose between blowing the caller's context and dropping content silently.
 * Both are the ambiguous-garbage failure the Honest Response Principle forbids.
 *
 * ## The eviction contract, and what it costs
 *
 * Eviction is pure LRU: `Map` preserves insertion order, so the oldest entry is always
 * `store.keys().next().value`, and every access re-inserts at the most-recently-used
 * end. No lock is needed — Node is single-threaded, so no interleaving is possible
 * between the `has`/`get` pairs below.
 *
 * **A stashed chunk is not durable, and callers must not imply that it is.** The store
 * is in-memory and per-process: a cartridge restart drops every chunk, and under
 * pressure an old chunk is evicted while its marker still sits in text the model may
 * still be holding. So `retrieve()` returning `null` is a NORMAL outcome, not a bug,
 * and the caller's job is to say "that chunk has expired, re-run the call" rather than
 * to present the gap as if the content never existed. This is why `retrieve` returns
 * `string | null` instead of throwing: expiry is an expected state, not an error.
 */

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 50 * 1_048_576; // 50 MiB

export interface CcrLimits {
  /** Max chunks retained before LRU eviction. Default 500. */
  maxEntries?: number;
  /** Max total stashed bytes before LRU eviction. Default 50 MiB. */
  maxBytes?: number;
}

export interface CcrEntryView {
  content: string;
  /** What the marker said this span was, when it was minted with a label. */
  label?: string;
}

export interface CcrStore {
  /** Stash chunks produced by `funnelReversible`. Re-stashing a known hash refreshes its LRU position without double-counting bytes. */
  stash(chunks: StashedChunk[]): void;
  /** Expand a marker (bare or labelled) or bare hash. `null` means expired/never-stashed — an expected outcome the caller must report honestly. */
  retrieve(markerOrHash: string): string | null;
  /**
   * Same lookup as `retrieve`, but also returns the chunk's label so a tool can say WHICH
   * span it is handing back ("12 context lines · …") rather than dumping anonymous bytes.
   * Counts as an access for LRU purposes, exactly like `retrieve`.
   */
  retrieveEntry(markerOrHash: string): CcrEntryView | null;
  /** Drop everything. Intended for tests and for a caller that knows its chunks are dead. */
  clear(): void;
  /** Current occupancy — for tests, telemetry and eviction assertions. */
  size(): { entries: number; bytes: number };
}

interface CcrEntry {
  content: string;
  byteCount: number;
  label?: string;
}

/**
 * Normalize a marker (bare or labelled) or a bare hex hash to its hash. `null` means the
 * input is not a valid CCR reference at all.
 *
 * Delegates to token-funnel, which OWNS the marker grammar because it mints it. This
 * deliberately does not re-implement the regex: an independent copy here is how a store
 * stops recognising the labelled markers the minter started producing.
 *
 * The inherited implementation (packages/tools) fell back to `markerOrHash.trim()` when
 * its regex missed, which silently turned a MALFORMED marker into its own cache key:
 * `stash("<<ccr:zz>>")` wrote under the literal marker, a later `retrieve("zz")` missed,
 * and the caller could not tell a typo'd reference from an evicted one. Both surfaced as
 * `null`. Returning `null` keeps those two cases separable and the key space hashes-only.
 */
export function parseCcrHash(markerOrHash: string): string | null {
  return parseCcrMarker(markerOrHash)?.hash ?? null;
}

/**
 * Build an isolated store. Prefer this over the process-wide singleton when a cartridge
 * wants its own budget — one tool's bulk output should not evict another's chunks.
 */
export function createCcrStore(limits: CcrLimits = {}): CcrStore {
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const store = new Map<string, CcrEntry>();
  let totalBytes = 0;

  function evict(): void {
    while (store.size > maxEntries || totalBytes > maxBytes) {
      const oldest = store.keys().next().value;
      // The loop condition implies store.size > 0, so a key must exist. A violation here
      // means the Map invariant broke, which must be loud rather than silently skipped.
      if (oldest === undefined) throw new Error(
        "ccr-store evict(): oldest key is undefined but store.size > 0 — Map invariant violated",
      );
      const entry = store.get(oldest);
      if (entry === undefined) throw new Error(
        "ccr-store evict(): get(oldest) undefined after keys() returned it — Map invariant violated",
      );
      totalBytes -= entry.byteCount;
      store.delete(oldest);
    }
  }

  return {
    stash(chunks: StashedChunk[]): void {
      for (const { marker, content, label } of chunks) {
        const hash = parseCcrHash(marker);
        // Markers are minted by token-funnel's funnelReversible, never by a user. An
        // unparseable one is a broken invariant upstream, not bad input to tolerate —
        // and silently stashing it under a key nobody can compute would guarantee the
        // chunk is unrecoverable while the text still advertises it as recoverable.
        if (hash === null) throw new Error(
          `ccr-store stash(): marker ${JSON.stringify(marker)} is not a <<ccr:HEX>> reference — `
          + `token-funnel invariant violated`,
        );
        const existing = store.get(hash);
        if (existing !== undefined) {
          // Refresh LRU position only. Re-adding byteCount here would leak the budget
          // on every repeated stash of the same chunk.
          store.delete(hash);
          store.set(hash, existing);
          continue;
        }
        const byteCount = Buffer.byteLength(content, "utf-8");
        // Only the CONTENT is charged to the byte budget. A label is bounded (80 chars by
        // token-funnel's cap) and counting it would make the budget depend on presentation.
        store.set(hash, label === undefined ? { content, byteCount } : { content, byteCount, label });
        totalBytes += byteCount;
        evict();
      }
    },

    retrieve(markerOrHash: string): string | null {
      return this.retrieveEntry(markerOrHash)?.content ?? null;
    },

    retrieveEntry(markerOrHash: string): CcrEntryView | null {
      const hash = parseCcrHash(markerOrHash);
      if (hash === null) return null; // not a CCR reference — same outcome as a miss, by design
      const entry = store.get(hash);
      if (entry === undefined) return null;
      store.delete(hash);
      store.set(hash, entry);
      return entry.label === undefined
        ? { content: entry.content }
        : { content: entry.content, label: entry.label };
    },

    clear(): void {
      store.clear();
      totalBytes = 0;
    },

    size(): { entries: number; bytes: number } {
      return { entries: store.size, bytes: totalBytes };
    },
  };
}

/**
 * Process-wide default store.
 *
 * A long-lived MCP server (ar-tools, youtube-transcript) keeps one module instance, so
 * this persists across tool calls within a session — which is the whole point: the model
 * receives a marker on one call and expands it on a later one.
 */
export const defaultCcrStore: CcrStore = createCcrStore();

// ── Back-compatible function API ──────────────────────────────────────────────
// packages/tools/src/lib/ccr-store.ts re-exports these, so its call sites and its
// existing test suite keep working against exactly one implementation.

export function ccrStash(chunks: StashedChunk[]): void {
  defaultCcrStore.stash(chunks);
}

export function ccrRetrieve(markerOrHash: string): string | null {
  return defaultCcrStore.retrieve(markerOrHash);
}

/** Test-only: reset the shared store between cases. */
export function ccrClearForTesting(): void {
  defaultCcrStore.clear();
}

/** Exported for tests/telemetry — exposes occupancy for eviction verification. */
export function ccrStoreSizeForTesting(): { entries: number; bytes: number } {
  return defaultCcrStore.size();
}
