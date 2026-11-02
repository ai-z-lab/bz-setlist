import { execFileSync } from "node:child_process";

export const KEYCHAIN_SERVICE = "bz-setlist-youtube";
export const CREDENTIAL_NAMES = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"];

function compact(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

// "(Remastered 2009)" "(2018 Mix)" "(feat. X)" などの版表記を除いた比較キー
export function looseTitleKey(value) {
  const title = String(value || "").normalize("NFKC")
    .replace(/\s*[([（【][^)\]）】]*(remaster|mix|feat\.?|ver\.?|version|edit)[^)\]）】]*[)\]）】]/gi, "")
    .replace(/\s+-\s+.*(remaster|mix|version).*$/i, "");
  return compact(title);
}

// 公演アーティスト本人の名義。カバー曲でも本人名義の配信音源を最優先し、無い場合だけ原曲アーティストを使う
export const ARTIST_ALIASES = {
  "B'z": ["B'z", "B’z", "Bz"],
  "稲葉浩志": ["稲葉浩志", "Koshi Inaba", "Inaba Koshi"],
  TMG: ["TMG", "TAK MATSUMOTO GROUP", "Tak Matsumoto Group"],
  "松本孝弘": ["松本孝弘", "Tak Matsumoto"],
};

export function artistCandidates(performer, original) {
  return [...new Set([performer, original].filter(Boolean))];
}

export function isoDurationSeconds(value) {
  const match = String(value || "").match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return match ? (Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3] || 0) : 0;
}

// Art Trackの説明文: "Provided to YouTube by …" / "曲名 · アーティスト" / "アルバム"
export function parseArtTrack(video) {
  const lines = String(video?.snippet?.description || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const credit = (lines[1] || "").split(" · ");
  return {
    videoId: video?.id,
    artTrack: /^Provided to YouTube by/.test(lines[0] || ""),
    channelId: video?.snippet?.channelId,
    title: credit[0] || video?.snippet?.title || "",
    artists: credit.slice(1),
    album: lines[2] || "",
    durationSec: isoDurationSeconds(video?.contentDetails?.duration),
  };
}

function albumKey(value) {
  return compact(String(value || "").normalize("NFKC").replace(/\s+-\s+(EP|Single)$/i, "").replace(/\s*[([（【][^)\]）】]*(edition|remaster|deluxe|anniversary)[^)\]）】]*[)\]）】]/gi, ""));
}

// 採用前の検証。曲名・アーティスト・公式Topicチャンネル・Art Trackは必須、アルバムと再生時間は期待値がある場合に照合する
export function verifyArtTrack(track, { song, aliases, channelIds, expected = {} }) {
  const reasons = [];
  if (!track.artTrack) reasons.push("not an Art Track");
  if (!channelIds.includes(track.channelId)) reasons.push("not an official Topic channel");
  if (looseTitleKey(track.title) !== looseTitleKey(song)) reasons.push(`title mismatch: ${track.title}`);
  const names = aliases.map(compact);
  if (!track.artists.some((name) => names.includes(compact(name)))) reasons.push(`artist mismatch: ${track.artists.join(", ")}`);
  // 同名シングル収録の同一音源（再生時間が一致）は、アルバム違いでも同じ音源として認める
  const sameNameSingle = looseTitleKey(track.album) === looseTitleKey(song) && expected.durationSec && Math.abs(expected.durationSec - track.durationSec) <= 3;
  if (expected.album && albumKey(expected.album) !== albumKey(track.album) && !sameNameSingle) reasons.push(`album mismatch: ${track.album} != ${expected.album}`);
  if (expected.durationSec && Math.abs(expected.durationSec - track.durationSec) > 3) reasons.push(`duration mismatch: ${track.durationSec}s != ${expected.durationSec}s`);
  return { ok: !reasons.length, reasons };
}

export function resumePlan(existing, desired) {
  if (existing.length > desired.length || existing.some((id, index) => id !== desired[index])) return { action: "conflict" };
  if (existing.length === desired.length) return { action: "complete" };
  return { action: "append", start: existing.length };
}

export function isQuotaError(error) {
  return /quotaExceeded|rateLimitExceeded|dailyLimitExceeded|RATE_LIMIT_EXCEEDED/.test(String(error?.message || error));
}

export function loadYouTubeCredentials(env = process.env) {
  const values = {};
  for (const name of CREDENTIAL_NAMES) {
    values[name] = env[name] || "";
    if (!values[name] && process.platform === "darwin") {
      try {
        values[name] = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch { /* not stored */ }
    }
  }
  const missing = CREDENTIAL_NAMES.filter((name) => !values[name]);
  if (missing.length) throw new Error(`YouTube credentials are not configured: ${missing.join(", ")}`);
  return values;
}

export async function refreshYouTubeAccessToken(env = process.env) {
  const credentials = loadYouTubeCredentials(env);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.YOUTUBE_CLIENT_ID,
      client_secret: credentials.YOUTUBE_CLIENT_SECRET,
      refresh_token: credentials.YOUTUBE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`YouTube token refresh failed (${response.status}): ${body.error || "unknown"}`);
  return body.access_token;
}
