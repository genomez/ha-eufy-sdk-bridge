import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlaybackSessions } from "../src/recordings-playback-sessions.mjs";

test("two viewers, idempotent opens/releases and exact last-viewer cancellation", () => {
  const emptied = [],
    job = { generation: "first", expectedMs: 10000 };
  const sessions = createPlaybackSessions({ empty: (j) => emptied.push(j) });
  const a = sessions.open("a", "request-a", job),
    b = sessions.open("b", "request-b", job);
  assert.equal(sessions.open("a", "request-a", job), a);
  assert.throws(() => sessions.get(a.sessionId, "first", "b"));
  assert.throws(() => sessions.release(a.sessionId, "replacement", "a"));
  sessions.release(a.sessionId, "first", "a");
  sessions.release(a.sessionId, "first", "a");
  assert.equal(emptied.length, 0);
  assert.equal(sessions.count(job), 1);
  sessions.release(b.sessionId, "first", "b");
  assert.deepEqual(emptied, [job]);
});

test("startup grace, renew, idle expiry and hard deadline never revive sessions", () => {
  let now = 0,
    cancels = 0;
  const sessions = createPlaybackSessions({ now: () => now, empty: () => cancels++ });
  const job = { generation: "first", expectedMs: 10000 };
  const a = sessions.open("a", "request", job);
  now = 179999;
  sessions.renew(a.sessionId, "first", "a");
  now += 29999;
  assert.equal(sessions.count(job), 1);
  now++;
  assert.throws(() => sessions.renew(a.sessionId, "first", "a"));
  assert.equal(cancels, 1);
  const b = sessions.open("a", "replacement", job);
  for (; now < b.hardExpiresAtMs; now += 1000) sessions.renew(b.sessionId, "first", "a");
  assert.throws(() => sessions.renew(b.sessionId, "first", "a"));
  assert.equal(cancels, 2);
});

test("disconnect grace, limits and stale generation cannot affect replacement", () => {
  let now = 0;
  const sessions = createPlaybackSessions({ now: () => now, limit: 1 });
  const old = { generation: "old", expectedMs: 10000 };
  const a = sessions.open("a", "request", old);
  assert.throws(() => sessions.open("b", "request", old));
  assert.throws(() => sessions.open("a", "request", { ...old }));
  sessions.ownerLost("a");
  now = 30000;
  sessions.expire();
  const next = { generation: "next", expectedMs: 10000 };
  const b = sessions.open("a", "request", next);
  sessions.release(a.sessionId, "old", "a");
  assert.equal(sessions.get(b.sessionId, "next", "a").job, next);
  sessions.clear();
  assert.throws(() => sessions.get(b.sessionId, "next", "a"));
});
