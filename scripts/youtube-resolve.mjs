#!/usr/bin/env node
// data/youtube-music-sources.json の公式Topicアルバムから曲IDを解決し、
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
    hit = video ? pickVideo(track.song, [{ videoId: pinned, title: video.snippet.title, channelId: video.snippet.channelId }], source.channelId) : null;
  }
  for (const album of source.albums) {
    if (hit) break;
    hit = pickVideo(track.song, await albumItems(album), source.channelId);
  }
  if (!hit) { unresolved.push({ artist: track.lookupArtist, song: track.song }); continue; }
  track.youtubeVideoId = hit.videoId;
  resolved.push({ artist: track.lookupArtist, song: track.song, videoId: hit.videoId, title: hit.title });
}

if (apply && resolved.length) await writeFile(mapFile, `${JSON.stringify(trackMap, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ apply, resolved, unresolved }, null, 2)}\n`);
if (unresolved.length) process.exitCode = 1;
