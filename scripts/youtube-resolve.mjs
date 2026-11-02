#!/usr/bin/env node
// data/playlist-track-map.json の曲に、YouTube Musicの公式Art Track（Topic）の曲IDを割り当てる。
// 優先順: 公演アーティスト本人名義 → 本人名義が無い場合だけ原曲アーティスト。MV・ライブ映像は採用しない。
// 採用前に曲名・アーティスト・Topicチャンネル・アルバム・再生時間を検証する（期待値はSpotifyの公開曲情報）。
//
//   node scripts/youtube-resolve.mjs [--apply] [--verify-all]
//        [--extra-playlist-title=<自分のプレイリスト名>]   YouTube Musicで手動保存した曲を候補に加える
// 候補の探索順: 固定指定 → 手動保存プレイリスト → 登録アルバム → Topicのリリース一覧 → 公開検索結果
import { readFile, writeFile } from "node:fs/promises";
import { ARTIST_ALIASES, artistCandidates, looseTitleKey, parseArtTrack, refreshYouTubeAccessToken, verifyArtTrack } from "./lib/youtube.mjs";

const mapFile = "data/playlist-track-map.json";
const apply = process.argv.includes("--apply");
const verifyAll = process.argv.includes("--verify-all");
const extraTitle = process.argv.find((arg) => arg.startsWith("--extra-playlist-title="))?.slice("--extra-playlist-title=".length);
const trackMap = JSON.parse(await readFile(mapFile, "utf8"));
const sources = JSON.parse(await readFile("data/youtube-music-sources.json", "utf8")).artists;
const token = await refreshYouTubeAccessToken();
const headers = { Authorization: `Bearer ${token}` };

async function get(path) {
  const response = await fetch(`https://www.googleapis.com/youtube/v3/${path}`, { headers });
  const body = await response.json();
  if (!response.ok) throw new Error(`GET ${path} failed (${response.status}): ${JSON.stringify(body.error?.errors || body)}`);
  return body;
}

async function pages(path) {
  const items = [];
  let pageToken = "";
  do {
    const body = await get(`${path}&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ""}`);
    items.push(...(body.items || []));
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return items;
}

const playlistCache = new Map();
async function playlistItems(playlistId) {
  if (!playlistCache.has(playlistId)) {
    const items = await pages(`playlistItems?part=snippet&playlistId=${playlistId}`);
    playlistCache.set(playlistId, items.map((item) => ({ videoId: item.snippet.resourceId?.videoId, title: item.snippet.title, channelId: item.snippet.videoOwnerChannelId })));
  }
  return playlistCache.get(playlistId);
}

const videoCache = new Map();
async function videos(ids) {
  const missing = [...new Set(ids)].filter((id) => !videoCache.has(id));
  for (let index = 0; index < missing.length; index += 50) {
    const body = await get(`videos?part=snippet,contentDetails&id=${missing.slice(index, index + 50).join(",")}`);
    for (const video of body.items || []) videoCache.set(video.id, parseArtTrack(video));
  }
  return ids.map((id) => videoCache.get(id)).filter(Boolean);
}

// 設定済みアルバムで見つからない場合だけ、Topicチャンネルの公開リリース一覧からアルバムを補う（クォータ消費なし）
const releaseCache = new Map();
async function channelReleases(channelId) {
  if (!releaseCache.has(channelId)) {
    const response = await fetch(`https://www.youtube.com/channel/${channelId}/releases`, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "ja", Cookie: "SOCS=CAI" } }).catch(() => null);
    const html = response?.ok ? await response.text() : "";
    releaseCache.set(channelId, [...new Set(html.match(/OLAK5uy_[\w-]{33}/g) || [])]);
  }
  return releaseCache.get(channelId);
}

// アルバム・リリース一覧で見つからない場合の最終手段。YouTubeの公開検索結果から候補IDだけを集め、採否は公式APIで検証する
async function webSearchIds(query) {
  const response = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en", Cookie: "SOCS=CAI; CONSENT=YES+" } }).catch(() => null);
  const html = response?.ok ? await response.text() : "";
  return [...new Set([...html.matchAll(/"videoId":"([\w-]{11})"/g)].map((match) => match[1]))].slice(0, 30);
}

async function spotifyExpectation(uri) {
  const id = String(uri || "").split(":")[2];
  if (!id) return {};
  const html = await (await fetch(`https://open.spotify.com/track/${id}`, { headers: { "User-Agent": "Mozilla/5.0" } })).text();
  const description = html.match(/<meta property="og:description" content="([^"]*)"/)?.[1] || "";
  const [artist, album] = description.split(" · ");
  return { artist, album, durationSec: Number(html.match(/<meta name="music:duration" content="(\d+)"/)?.[1] || 0) };
}

function aliasesFor(artist) {
  return [...new Set([...(ARTIST_ALIASES[artist] || []), ...(sources[artist]?.aliases || []), artist].filter(Boolean))];
}

// Spotifyの期待値は同じアーティスト名義のときだけ照合に使う（本人版とカバー元でアルバムが異なるため）
function expectationFor(aliases, expected) {
  return aliases.some((name) => looseTitleKey(name) === looseTitleKey(expected.artist)) ? expected : {};
}

let extraPlaylist = "";
if (extraTitle) {
  const own = await pages("playlists?part=snippet&mine=true");
  const matches = own.filter((item) => item.snippet.title === extraTitle);
  if (matches.length !== 1) throw new Error(`playlist titled "${extraTitle}" found ${matches.length} times`);
  extraPlaylist = matches[0].id;
}

async function resolveFor(track, artist, expected) {
  const source = sources[artist];
  if (!source) return { reasons: [`no source for ${artist}`] };
  const aliases = aliasesFor(artist);
  const rules = { song: track.song, aliases, channelIds: source.channelIds, expected: expectationFor(aliases, expected) };
  const rejected = [];
  const tryIds = async (ids) => {
    for (const candidate of await videos(ids)) {
      const result = verifyArtTrack(candidate, rules);
      if (result.ok) return candidate;
      rejected.push(`${candidate.videoId}: ${result.reasons.join("; ")}`);
    }
    return null;
  };
  const titled = (items) => items
    .filter((item) => source.channelIds.includes(item.channelId) && looseTitleKey(item.title) === looseTitleKey(track.song))
    .map((item) => item.videoId);
  const pinned = source.videos?.[track.song];
  let hit = pinned ? await tryIds([pinned]) : null;
  for (const playlistId of [...(extraPlaylist ? [extraPlaylist] : []), ...(source.albums || [])]) {
    if (hit) break;
    hit = await tryIds(titled(await playlistItems(playlistId)));
  }
  for (const channelId of hit ? [] : source.channelIds) {
    for (const album of (await channelReleases(channelId)).filter((id) => !(source.albums || []).includes(id))) {
      if (hit) break;
      hit = await tryIds(titled(await playlistItems(album)));
    }
  }
  for (const query of hit ? [] : [`${aliases[0]} ${track.song} ${rules.expected.album || ""}`.trim(), `${aliases[0]} ${track.song} Topic`]) {
    if (hit) break;
    hit = await tryIds((await videos(await webSearchIds(query))).filter((item) => looseTitleKey(item.title) === looseTitleKey(track.song)).map((item) => item.videoId));
  }
  return hit ? { hit } : { reasons: rejected.length ? rejected : [`not found in ${artist} sources`] };
}

const resolved = [];
const verified = [];
const unresolved = [];
for (const track of Object.values(trackMap.tracks)) {
  if (track.youtubeVideoId && !verifyAll) continue;
  const expected = await spotifyExpectation(track.spotifyUri);
  if (track.youtubeVideoId) {
    const [current] = await videos([track.youtubeVideoId]);
    const artist = artistCandidates(track.artist, track.lookupArtist).find((name) => sources[name]?.channelIds.includes(current?.channelId));
    const aliases = aliasesFor(artist);
    const result = current && artist
      ? verifyArtTrack(current, { song: track.song, aliases, channelIds: sources[artist].channelIds, expected: expectationFor(aliases, expected) })
      : { ok: false, reasons: ["video unavailable or not from a configured Topic channel"] };
    const entry = { artist: artist || track.artist, song: track.song, videoId: track.youtubeVideoId, album: current?.album, durationSec: current?.durationSec };
    if (result.ok) verified.push(entry); else unresolved.push({ ...entry, reasons: result.reasons });
    continue;
  }
  const reasons = [];
  let hit = null;
  for (const artist of artistCandidates(track.artist, track.lookupArtist)) {
    const result = await resolveFor(track, artist, expected);
    if (result.hit) { hit = { ...result.hit, artist }; break; }
    reasons.push(...result.reasons);
  }
  if (!hit) { unresolved.push({ artist: track.artist, song: track.song, reasons }); continue; }
  track.youtubeVideoId = hit.videoId;
  resolved.push({ artist: hit.artist, song: track.song, videoId: hit.videoId, album: hit.album, durationSec: hit.durationSec });
}

if (apply && resolved.length) await writeFile(mapFile, `${JSON.stringify(trackMap, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ apply, resolved, verified: verified.length, unresolved, verifiedTracks: verified }, null, 2)}\n`);
if (unresolved.length) process.exitCode = 1;
