import test from "node:test";
import assert from "node:assert/strict";
import { artistCandidates, isQuotaError, isoDurationSeconds, looseTitleKey, parseArtTrack, resumePlan, verifyArtTrack } from "../scripts/lib/youtube.mjs";

function video(id, description, duration = "PT4M40S", channelId = "tmg-topic") {
  return { id, snippet: { channelId, title: "x", description }, contentDetails: { duration } };
}

const wmggw = video("tmg", "Provided to YouTube by Being\n\nWHILE MY GUITAR GENTLY WEEPS · TMG\n\nTMG Ⅲ SAYONARA\n\n℗ 2026");
const rules = { song: "WHILE MY GUITAR GENTLY WEEPS", aliases: ["TMG", "TAK MATSUMOTO GROUP"], channelIds: ["tmg-topic"], expected: { album: "TMG Ⅲ SAYONARA", durationSec: 279 } };

test("tries the performing artist before the original artist", () => {
  assert.deepEqual(artistCandidates("TMG", "Mr. Big"), ["TMG", "Mr. Big"]);
  assert.deepEqual(artistCandidates("稲葉浩志", "稲葉浩志"), ["稲葉浩志"]);
});

test("parses Art Track credits, album and duration", () => {
  assert.deepEqual(parseArtTrack(wmggw), { videoId: "tmg", artTrack: true, channelId: "tmg-topic", title: "WHILE MY GUITAR GENTLY WEEPS", artists: ["TMG"], album: "TMG Ⅲ SAYONARA", durationSec: 280 });
  assert.equal(isoDurationSeconds("PT1H2M3S"), 3723);
});

test("accepts only verified official Art Tracks", () => {
  assert.ok(verifyArtTrack(parseArtTrack(wmggw), rules).ok);
  const mv = video("mv", "稲葉浩志 / YELLOW Music Video", "PT4M0S", "official");
  assert.ok(!verifyArtTrack(parseArtTrack(mv), { ...rules, song: "YELLOW", channelIds: ["topic"] }).ok);
  const beatles = video("b", "Provided to YouTube by Apple\n\nWhile My Guitar Gently Weeps · The Beatles\n\nLove\n\n℗ 2006", "PT3M46S");
  const single = video("s", "Provided to YouTube by Being\n\nStray Hearts · 稲葉浩志\n\nStray Hearts\n\n℗ 2023", "PT4M5S", "topic");
  const inaba = { song: "Stray Hearts", aliases: ["稲葉浩志"], channelIds: ["topic"] };
  assert.ok(verifyArtTrack(parseArtTrack(single), { ...inaba, expected: { album: "只者", durationSec: 246 } }).ok);
  assert.ok(!verifyArtTrack(parseArtTrack(single), { ...inaba, expected: { album: "只者", durationSec: 260 } }).ok);
  assert.deepEqual(verifyArtTrack(parseArtTrack(beatles), rules).reasons, ["artist mismatch: The Beatles", "album mismatch: Love != TMG Ⅲ SAYONARA", "duration mismatch: 226s != 279s"]);
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
