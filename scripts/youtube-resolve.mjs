#!/usr/bin/env node
// data/youtube-music-sources.json の公式Topicアルバム・公式チャンネルから曲IDを解決し、
// data/playlist-track-map.json の youtubeVideoId へ登録する。検索APIは使わない。
import { readFile, writeFile } from "node:fs/promises";
import { pickVideo, refreshYouTubeAccessToken } from "./lib/youtube.mjs";

const mapFile = "data/playlist-track-map.json";
const apply = process.argv.includes("--apply");
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

const albumCache = new Map();
async function albumItems(playlistId) {
  if (!albumCache.has(playlistId)) {
    const items = [];
    let pageToken = "";
    do {
      const body = await get(`playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}${pageToken ? `&pageToken=${pageToken}` : ""}`);
      for (const item of body.items || []) {
        items.push({ videoId: item.snippet.resourceId?.videoId, title: item.snippet.title, channelId: item.snippet.videoOwnerChannelId, album: playlistId });
      }
      pageToken = body.nextPageToken || "";
    } while (pageToken);
    albumCache.set(playlistId, items);
  }
  return albumCache.get(playlistId);
}

// --extra-playlist=<ID>: YouTube Musicで手動保存した配信音源を候補に加える（全アーティスト共通）
const extraPlaylist = process.argv.find((arg) => arg.startsWith("--extra-playlist="))?.split("=")[1];

const resolved = [];
const unresolved = [];
for (const track of Object.values(trackMap.tracks)) {
  if (track.youtubeVideoId) continue;
  const source = sources[track.lookupArtist];
  if (!source) { unresolved.push({ ...track, reason: "no source" }); continue; }
  let hit = null;
  const pinned = source.videos?.[track.song];
  if (pinned) {
    const video = (await get(`videos?part=snippet&id=${pinned}`)).items?.[0];
    hit = video ? pickVideo(track.song, [{ videoId: pinned, title: video.snippet.title, channelId: video.snippet.channelId }], source.channelIds, source.aliases) : null;
  }
  for (const album of [...(extraPlaylist ? [extraPlaylist] : []), ...source.albums]) {
    if (hit) break;
    hit = pickVideo(track.song, await albumItems(album), source.channelIds, source.aliases);
  }
  if (!hit) { unresolved.push({ artist: track.lookupArtist, song: track.song }); continue; }
  resolved.push({ track, artist: track.lookupArtist, song: track.song, videoId: hit.videoId, title: hit.title });
}

// MV・ライブ映像を除外するため、公式TopicチャンネルのArt Track（"Provided to YouTube by"）だけを採用する
for (let index = 0; index < resolved.length; index += 50) {
  const batch = resolved.slice(index, index + 50);
  const videos = new Map(((await get(`videos?part=snippet&id=${batch.map((item) => item.videoId).join(",")}`)).items || []).map((video) => [video.id, video.snippet]));
  for (const item of batch) {
    const snippet = videos.get(item.videoId);
    item.artTrack = Boolean(snippet && sources[item.artist].channelIds.includes(snippet.channelId) && /^Provided to YouTube by/.test(snippet.description || ""));
  }
}
for (const item of resolved.filter((entry) => !entry.artTrack)) unresolved.push({ artist: item.artist, song: item.song, reason: "not an official Art Track", videoId: item.videoId });
for (const item of resolved.filter((entry) => entry.artTrack)) item.track.youtubeVideoId = item.videoId;
resolved.splice(0, resolved.length, ...resolved.filter((entry) => entry.artTrack).map(({ track, artTrack, ...rest }) => rest));

if (apply && resolved.length) await writeFile(mapFile, `${JSON.stringify(trackMap, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ apply, resolved, unresolved }, null, 2)}\n`);
if (unresolved.length) process.exitCode = 1;
