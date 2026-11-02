import test from "node:test";
import assert from "node:assert/strict";
import { isQuotaError, looseTitleKey, pickVideo, resumePlan } from "../scripts/lib/youtube.mjs";

test("picks only videos from the official channel, exact title first", () => {
  const candidates = [
    { videoId: "fake", title: "SAYONARA", channelId: "other" },
    { videoId: "loose", title: "SAYONARA (2026 Mix)", channelId: "topic" },
    { videoId: "exact", title: "SAYONARA", channelId: "topic" },
  ];
  assert.equal(pickVideo("SAYONARA", candidates, "topic").videoId, "exact");
  assert.equal(pickVideo("SAYONARA", candidates.slice(0, 2), "topic").videoId, "loose");
  assert.equal(pickVideo("SAYONARA", candidates.slice(0, 1), "topic"), null);
});

test("ignores edition suffixes but not different songs", () => {
  assert.equal(looseTitleKey("While My Guitar Gently Weeps (Remastered 2009)"), looseTitleKey("WHILE MY GUITAR GENTLY WEEPS"));
  assert.equal(looseTitleKey("ETERNAL FLAMES (feat. BABYMETAL)"), looseTitleKey("ETERNAL FLAMES"));
  assert.notEqual(looseTitleKey("Touch"), looseTitleKey("タッチ"));
  assert.notEqual(looseTitleKey("(You Can Still) Rock in America"), looseTitleKey("Rock in America"));
});

test("resumes a partially filled playlist and refuses different contents", () => {
  assert.deepEqual(resumePlan([], ["a", "b"]), { action: "append", start: 0 });
  assert.deepEqual(resumePlan(["a"], ["a", "b"]), { action: "append", start: 1 });
  assert.deepEqual(resumePlan(["a", "b"], ["a", "b"]), { action: "complete" });
  assert.deepEqual(resumePlan(["b"], ["a", "b"]), { action: "conflict" });
  assert.deepEqual(resumePlan(["a", "b", "c"], ["a", "b"]), { action: "conflict" });
});

test("detects quota errors", () => {
  assert.ok(isQuotaError(new Error('POST failed (403): {"reason":"quotaExceeded"}')));
  assert.ok(!isQuotaError(new Error("403 forbidden")));
});
