import { describe, it, expect, beforeEach } from "vitest";
import {
  createCcrStore,
  parseCcrHash,
  ccrStash,
  ccrRetrieve,
  ccrClearForTesting,
  ccrStoreSizeForTesting,
} from "../index.js";

const chunk = (hash: string, content: string) => ({ marker: `<<ccr:${hash}>>`, content });

describe("parseCcrHash", () => {
  it("accepts a marker or a bare hash, so callers can pass either", () => {
    expect(parseCcrHash("<<ccr:abc123>>")).toBe("abc123");
    expect(parseCcrHash("abc123")).toBe("abc123");
    expect(parseCcrHash("  abc123  ")).toBe("abc123");
  });

  it("extracts the marker even when it is embedded in surrounding text", () => {
    // Callers routinely paste the whole line back rather than the bare sentinel.
    expect(parseCcrHash("...tail <<ccr:deadbeef>> more...")).toBe("deadbeef");
  });

  it("returns null for anything that is not a CCR reference — it must NOT become its own key", () => {
    // The inherited implementation fell back to markerOrHash.trim(), so a malformed
    // marker was stashed under the literal marker text and could never be retrieved by
    // hash. That made a typo'd reference and an evicted one both surface as null, which
    // is the exact ambiguity this package exists to remove. Found by a test of this suite
    // that used non-hex ids and failed for a reason unrelated to what it claimed to check.
    expect(parseCcrHash("<<ccr:zz>>")).toBeNull(); // marker-shaped, non-hex body
    expect(parseCcrHash("not a marker")).toBeNull();
    expect(parseCcrHash("")).toBeNull();
    expect(parseCcrHash("<<ccr:>>")).toBeNull(); // empty body
  });
});

describe("labelled markers", () => {
  it("accepts a LABELLED marker and keys it by hash, so either form retrieves it", () => {
    // The store must not treat "<<ccr:aa11 | 12 context lines>>" as a different chunk
    // from "<<ccr:aa11>>" — the label is description, the hash is identity.
    const s = createCcrStore();
    s.stash([{ marker: "<<ccr:aa11 | 12 context lines · Hello>>", content: "body", label: "12 context lines · Hello" }]);
    expect(s.retrieve("<<ccr:aa11 | 12 context lines · Hello>>")).toBe("body");
    expect(s.retrieve("<<ccr:aa11>>")).toBe("body");
    expect(s.retrieve("aa11")).toBe("body");
  });

  it("retrieveEntry returns the label so a tool can NAME the span it hands back", () => {
    const s = createCcrStore();
    s.stash([{ marker: "<<ccr:bb22 | 4 boilerplate lines>>", content: "body", label: "4 boilerplate lines" }]);
    expect(s.retrieveEntry("bb22")).toEqual({ content: "body", label: "4 boilerplate lines" });
  });

  it("an unlabelled chunk yields no label rather than an empty string", () => {
    // A caller branching on `label` must not have to distinguish "" from absent.
    const s = createCcrStore();
    s.stash([chunk("cc33", "body")]);
    expect(s.retrieveEntry("cc33")).toEqual({ content: "body" });
  });

  it("the label is NOT charged to the byte budget — presentation must not move eviction", () => {
    const s = createCcrStore();
    s.stash([{ marker: "<<ccr:dd44 | " + "x".repeat(60) + ">>", content: "12345", label: "x".repeat(60) }]);
    expect(s.size()).toEqual({ entries: 1, bytes: 5 });
  });
});

describe("malformed markers", () => {
  it("stash() THROWS on an unparseable marker rather than hiding an unrecoverable chunk", () => {
    // Markers come from token-funnel, never a user, so this is a broken upstream
    // invariant. Stashing it quietly would leave text advertising a chunk that no
    // computable hash can reach — a lie with a receipt.
    const s = createCcrStore();
    expect(() => s.stash([{ marker: "<<ccr:zz>>", content: "x" }]))
      .toThrow(/not a <<ccr:HEX>> reference/);
    expect(s.size().entries).toBe(0);
  });

  it("retrieve() returns null on a malformed reference instead of throwing", () => {
    // Asymmetric on purpose: a bad marker reaching retrieve came from the model echoing
    // text back, which is untrusted input at a boundary — answer it, do not crash.
    const s = createCcrStore();
    expect(() => s.retrieve("<<ccr:zz>>")).not.toThrow();
    expect(s.retrieve("<<ccr:zz>>")).toBeNull();
  });
});

describe("round-trip", () => {
  it("stashes and expands by marker and by bare hash", () => {
    const s = createCcrStore();
    s.stash([chunk("aa11", "the removed content")]);
    expect(s.retrieve("<<ccr:aa11>>")).toBe("the removed content");
    expect(s.retrieve("aa11")).toBe("the removed content");
  });

  it("returns null — never throws — for an unknown but WELL-FORMED hash, because expiry is a NORMAL state", () => {
    // The caller must be able to distinguish "expired, re-run" from a crash. If this
    // threw, every honest caller would need a try/catch around a routine outcome.
    // Deliberately hex: a non-hex id would exercise the malformed path below instead,
    // which is how the first draft of this suite fooled itself.
    const s = createCcrStore();
    expect(() => s.retrieve("dead99")).not.toThrow();
    expect(s.retrieve("dead99")).toBeNull();
  });

  it("counts bytes by UTF-8 length, not string length", () => {
    const s = createCcrStore();
    s.stash([chunk("bb22", "€€€")]); // 3 chars, 9 bytes
    expect(s.size()).toEqual({ entries: 1, bytes: 9 });
  });
});

describe("eviction", () => {
  it("evicts the least-recently-used entry past maxEntries", () => {
    const s = createCcrStore({ maxEntries: 2 });
    s.stash([chunk("a", "A"), chunk("b", "B")]);
    s.retrieve("a"); // 'a' becomes most-recently-used, so 'b' is now the victim
    s.stash([chunk("c", "C")]);

    expect(s.retrieve("b")).toBeNull();
    expect(s.retrieve("a")).toBe("A");
    expect(s.retrieve("c")).toBe("C");
    expect(s.size().entries).toBe(2);
  });

  it("evicts on a byte budget and keeps the byte count honest afterwards", () => {
    const s = createCcrStore({ maxBytes: 10 });
    s.stash([chunk("a", "12345"), chunk("b", "67890")]);
    expect(s.size()).toEqual({ entries: 2, bytes: 10 });

    s.stash([chunk("c", "X")]); // pushes over 10 bytes → oldest ('a') goes
    expect(s.retrieve("a")).toBeNull();
    expect(s.size().bytes).toBe(6); // 5 ('b') + 1 ('c') — not a stale running total
  });

  it("re-stashing a known hash refreshes LRU position WITHOUT double-counting bytes", () => {
    // The budget-leak regression: adding byteCount again on every repeat stash would
    // shrink the effective cache toward zero while entries still fit.
    const s = createCcrStore({ maxEntries: 2 });
    s.stash([chunk("a", "12345")]);
    s.stash([chunk("a", "12345")]);
    s.stash([chunk("a", "12345")]);
    expect(s.size()).toEqual({ entries: 1, bytes: 5 });

    // ...and the refresh really moved it: 'a' must now outlive 'b'.
    s.stash([chunk("b", "B")]);
    s.stash([chunk("a", "12345")]);
    s.stash([chunk("c", "C")]);
    expect(s.retrieve("b")).toBeNull();
    expect(s.retrieve("a")).toBe("12345");
  });

  it("a single chunk larger than the whole budget does not wedge the store", () => {
    // evict() must terminate rather than spin trying to get under an impossible budget.
    const s = createCcrStore({ maxBytes: 4 });
    expect(() => s.stash([chunk("beef", "0123456789")])).not.toThrow();
    expect(s.size().entries).toBe(0); // it was admitted, then immediately evicted
    expect(s.size().bytes).toBe(0);
    expect(s.retrieve("beef")).toBeNull(); // and the caller is told, not misled
  });
});

describe("isolation", () => {
  it("separate stores do not share or evict each other's chunks", () => {
    // The reason createCcrStore exists: one tool's bulk output must not evict another's.
    const a = createCcrStore({ maxEntries: 1 });
    const b = createCcrStore({ maxEntries: 1 });
    a.stash([chunk("1a", "from A")]);
    b.stash([chunk("2b", "from B")]);
    expect(a.retrieve("2b")).toBeNull();
    expect(b.retrieve("1a")).toBeNull();
    expect(a.retrieve("1a")).toBe("from A");
    expect(b.retrieve("2b")).toBe("from B");
  });

  it("clear() empties one store and resets its byte count", () => {
    const s = createCcrStore();
    s.stash([chunk("a", "AAA")]);
    s.clear();
    expect(s.size()).toEqual({ entries: 0, bytes: 0 });
    expect(s.retrieve("a")).toBeNull();
  });
});

describe("back-compatible function API (what packages/tools re-exports)", () => {
  beforeEach(() => ccrClearForTesting());

  it("keeps the exact four-function surface working against the shared store", () => {
    ccrStash([chunk("f1", "shared")]);
    expect(ccrRetrieve("<<ccr:f1>>")).toBe("shared");
    expect(ccrStoreSizeForTesting()).toEqual({ entries: 1, bytes: 6 });
    ccrClearForTesting();
    expect(ccrStoreSizeForTesting()).toEqual({ entries: 0, bytes: 0 });
    expect(ccrRetrieve("f1")).toBeNull();
  });
});
