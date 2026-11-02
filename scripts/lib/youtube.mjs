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

function withoutArtist(title, aliases) {
  const text = String(title || "").normalize("NFKC");
  const alias = aliases.find((name) => text.toLowerCase().startsWith(`${name.toLowerCase()} `) || text.toLowerCase().startsWith(`${name.toLowerCase()}/`));
  return alias ? text.slice(alias.length).replace(/^\s*[/-]\s*/, "") : text;
}

// channelIdsは優先順（Topic、公式チャンネルの順）。曲名は完全一致を版表記の除去より優先する
export function pickVideo(song, candidates, channelIds, aliases = []) {
  for (const channelId of [].concat(channelIds)) {
    const own = candidates.filter((item) => item.channelId === channelId).map((item) => ({ ...item, bare: withoutArtist(item.title, aliases) }));
    const hit = own.find((item) => compact(item.bare) === compact(song))
      || own.find((item) => looseTitleKey(item.bare) === looseTitleKey(song));
    if (hit) return hit;
  }
  return null;
}

export function resumePlan(existing, desired) {
  if (existing.length > desired.length || existing.some((id, index) => id !== desired[index])) return { action: "conflict" };
  if (existing.length === desired.length) return { action: "complete" };
  return { action: "append", start: existing.length };
}

export function isQuotaError(error) {
  return /quotaExceeded|rateLimitExceeded|dailyLimitExceeded/.test(String(error?.message || error));
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
