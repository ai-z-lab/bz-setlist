#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { loadBzData, saveBzData, validateBzData } from "./lib/bz-data.mjs";
import { buildPlaylistPlan } from "./playlist-plan.mjs";

const PROVIDERS = new Set(["spotify", "youtubeMusic"]);

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/official\s*(music\s*)?(video|audio)|lyrics?|mv|pv|hd|remaster(ed)?|full/gi, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function artistForShow(show) {
  if (show.tour === "TMG SAYONARA") return "TMG";
  if (show.tour === "enV" || show.tour === "1CHANCE FESTIVAL 2026") return "稲葉浩志";
  if (["FYOP+", "FYOP naked", "FYOP", "FYOD", "SHOWCASE"].includes(show.tour)) return "B'z";
  return "";
}

function artistAliases(artist) {
  if (artist === "稲葉浩志") return ["稲葉浩志", "koshi inaba", "inaba koshi"];
  if (artist === "B'z") return ["b'z", "bz"];
  if (artist === "TMG") return ["tmg", "tak matsumoto group"];
  return [artist];
}

function mapKey(artist, song) {
  return `${artist}\u0000${song}`;
}

function playlistTitle(group) {
  const show = group.shows[0];
  const suffix = group.shows.length === 1
    ? `${show.date} ${show.venue}`
    : `${group.shows.length}公演共通 ${group.id.slice(0, 8)}`;
  return `${show.tour} ${suffix} セットリスト`.slice(0, 140);
}

function playlistDescription(group) {
  const shows = group.shows.map((show) => `${show.date} ${show.venue}`).join(" / ");
  return `B'z Live Setlist DB 自動生成。${shows}。bz-setlist:${group.id}`.slice(0, 290);
}

function marker(group) {
  return `bz-setlist:${group.id}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`${options.method || "GET"} ${url} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

async function refreshSpotifyToken() {
  const required = ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REFRESH_TOKEN"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Spotify credentials are not configured: ${missing.join(", ")}`);
  const authorization = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: process.env.SPOTIFY_REFRESH_TOKEN });
  const result = await fetchJson("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${authorization}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return result.access_token;
}

async function refreshYouTubeToken() {
  const required = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`YouTube credentials are not configured: ${missing.join(", ")}`);
  const body = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID,
    client_secret: process.env.YOUTUBE_CLIENT_SECRET,
    refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const result = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return result.access_token;
}

class SpotifyAdapter {
  constructor(token) { this.token = token; }
  headers(extra = {}) { return { Authorization: `Bearer ${this.token}`, ...extra }; }

  async resolve(song, artist) {
    const query = encodeURIComponent(`track:${song} artist:${artist}`);
    const body = await fetchJson(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=10`, { headers: this.headers() });
    const aliases = artistAliases(artist).map(normalize);
    const candidates = (body.tracks?.items || []).filter((track) =>
      normalize(track.name) === normalize(song)
      && track.artists?.some((item) => aliases.includes(normalize(item.name))),
    );
    return candidates.length === 1 ? candidates[0].uri : "";
  }

  async findByMarker(value) {
    let url = "https://api.spotify.com/v1/me/playlists?limit=50";
    while (url) {
      const body = await fetchJson(url, { headers: this.headers() });
      const found = (body.items || []).find((item) => item.description?.includes(value));
      if (found) return { id: found.id, url: found.external_urls.spotify };
      url = body.next || "";
    }
    return null;
  }

  async listItems(id) {
    const uris = [];
    let url = `https://api.spotify.com/v1/playlists/${id}/items?limit=100`;
    while (url) {
      const body = await fetchJson(url, { headers: this.headers() });
      for (const item of body.items || []) if (item.track?.uri) uris.push(item.track.uri);
      url = body.next || "";
    }
    return uris;
  }

  async create(group, uris) {
    let playlist = await this.findByMarker(marker(group));
    if (playlist) {
      const existing = await this.listItems(playlist.id);
      if (existing.length && JSON.stringify(existing) !== JSON.stringify(uris)) throw new Error(`Spotify marker exists with different contents: ${marker(group)}`);
      if (!existing.length) await this.addItems(playlist.id, uris);
      return playlist.url;
    }
    const body = await fetchJson("https://api.spotify.com/v1/me/playlists", {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name: playlistTitle(group), public: true, description: playlistDescription(group) }),
    });
    await this.addItems(body.id, uris);
    return body.external_urls.spotify;
  }

  async addItems(id, uris) {
    for (let index = 0; index < uris.length; index += 100) {
      await fetchJson(`https://api.spotify.com/v1/playlists/${id}/items`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ uris: uris.slice(index, index + 100) }),
      });
    }
  }
}

class YouTubeAdapter {
  constructor(token) { this.token = token; }
  headers(extra = {}) { return { Authorization: `Bearer ${this.token}`, ...extra }; }

  async resolve(song, artist) {
    if (process.env.YOUTUBE_AUTO_MATCH !== "true") return "";
    const query = encodeURIComponent(`${artist} ${song} official audio`);
    const body = await fetchJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=10&q=${query}`, { headers: this.headers() });
    const aliases = artistAliases(artist).map(normalize);
    const candidates = (body.items || []).filter((item) => {
      const title = normalize(item.snippet?.title);
      const channel = normalize(item.snippet?.channelTitle);
      return title.includes(normalize(song)) && aliases.some((alias) => title.includes(alias) || channel.includes(alias));
    });
    return candidates.length === 1 ? candidates[0].id.videoId : "";
  }

  async findByMarker(value) {
    let pageToken = "";
    do {
      const tokenPart = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const body = await fetchJson(`https://www.googleapis.com/youtube/v3/playlists?part=snippet,status&mine=true&maxResults=50${tokenPart}`, { headers: this.headers() });
      const found = (body.items || []).find((item) => item.snippet?.description?.includes(value));
      if (found) return { id: found.id, url: `https://music.youtube.com/playlist?list=${found.id}` };
      pageToken = body.nextPageToken || "";
    } while (pageToken);
    return null;
  }

  async listItems(id) {
    const ids = [];
    let pageToken = "";
    do {
      const tokenPart = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const body = await fetchJson(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${encodeURIComponent(id)}&maxResults=50${tokenPart}`, { headers: this.headers() });
      for (const item of body.items || []) if (item.contentDetails?.videoId) ids.push(item.contentDetails.videoId);
      pageToken = body.nextPageToken || "";
    } while (pageToken);
    return ids;
  }

  async create(group, videoIds) {
    let playlist = await this.findByMarker(marker(group));
    if (playlist) {
      const existing = await this.listItems(playlist.id);
      if (existing.length && JSON.stringify(existing) !== JSON.stringify(videoIds)) throw new Error(`YouTube marker exists with different contents: ${marker(group)}`);
      if (!existing.length) await this.addItems(playlist.id, videoIds);
      return playlist.url;
    }
    const body = await fetchJson("https://www.googleapis.com/youtube/v3/playlists?part=snippet,status", {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ snippet: { title: playlistTitle(group), description: playlistDescription(group) }, status: { privacyStatus: "unlisted" } }),
    });
    await this.addItems(body.id, videoIds);
    return `https://music.youtube.com/playlist?list=${body.id}`;
  }

  async addItems(id, videoIds) {
    for (let position = 0; position < videoIds.length; position += 1) {
      await fetchJson("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet", {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ snippet: { playlistId: id, position, resourceId: { kind: "youtube#video", videoId: videoIds[position] } } }),
      });
    }
  }
}

async function loadTrackMap(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { version: 1, tracks: {} }; throw error; }
}

function applyLink(data, showIds, provider, url) {
  let changed = 0;
  data.shows = data.shows.map((show) => {
    if (!showIds.includes(show.id) || show.playlists?.[provider]) return show;
    changed += 1;
    return { ...show, playlists: { ...(show.playlists || {}), [provider]: url } };
  });
  return changed;
}

const indexFile = argValue("index", "index.html");
const mapFile = argValue("map", "data/playlist-track-map.json");
const reportFile = argValue("report", "playlist-sync-report.json");
const providerArg = argValue("provider", "both");
const providers = providerArg === "both" ? ["spotify", "youtubeMusic"] : [providerArg];
if (providers.some((provider) => !PROVIDERS.has(provider))) throw new Error(`Unsupported provider: ${providerArg}`);

const apply = hasFlag("apply");
const document = await loadBzData(indexFile);
const plan = buildPlaylistPlan(document.data, { tour: argValue("tour") });
const trackMap = await loadTrackMap(mapFile);
const adapters = {};
if (apply && providers.includes("spotify")) adapters.spotify = new SpotifyAdapter(await refreshSpotifyToken());
if (apply && providers.includes("youtubeMusic")) adapters.youtubeMusic = new YouTubeAdapter(await refreshYouTubeToken());

const report = { generatedAt: new Date().toISOString(), apply, provider: providerArg, tour: argValue("tour") || null, created: [], reused: [], unresolved: [], errors: [] };
let linkedShows = 0;

for (const group of plan.groups) {
  const representative = group.shows[0];
  const artist = artistForShow(representative);
  for (const provider of providers) {
    const needs = group.needs[provider];
    if (!needs.length) continue;
    try {
      if (group.existing[provider]) {
        if (apply) linkedShows += applyLink(document.data, needs, provider, group.existing[provider]);
        report.reused.push({ provider, group: group.id, shows: needs, url: group.existing[provider] });
        continue;
      }
      if (!artist) {
        report.unresolved.push({ provider, group: group.id, shows: needs, reason: "artist is not configured", tracks: group.tracks.map((track) => track.song) });
        continue;
      }
      const ids = [];
      const unresolvedSongs = [];
      for (const track of group.tracks) {
        const key = mapKey(artist, track.song);
        trackMap.tracks[key] ||= { artist, song: track.song };
        const field = provider === "spotify" ? "spotifyUri" : "youtubeVideoId";
        let id = trackMap.tracks[key][field] || "";
        if (!id && apply) {
          id = await adapters[provider].resolve(track.song, artist);
          if (id) trackMap.tracks[key][field] = id;
        }
        if (id) ids.push(id); else unresolvedSongs.push(track.song);
      }
      if (unresolvedSongs.length) {
        report.unresolved.push({ provider, group: group.id, shows: needs, artist, tracks: unresolvedSongs });
        continue;
      }
      if (!apply) {
        report.created.push({ provider, group: group.id, shows: needs, dryRun: true, tracks: ids.length });
        continue;
      }
      const url = await adapters[provider].create(group, ids);
      linkedShows += applyLink(document.data, needs, provider, url);
      report.created.push({ provider, group: group.id, shows: needs, url, tracks: ids.length });
    } catch (error) {
      report.errors.push({ provider, group: group.id, shows: needs, message: error.message });
    }
  }
}

if (apply) {
  await writeFile(mapFile, `${JSON.stringify(trackMap, null, 2)}\n`, "utf8");
  if (linkedShows) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    document.data.updated = today;
    document.data.updateHistory.unshift({ date: today, title: "プレイリスト更新", items: [`Spotify / YouTube Music のプレイリストリンクを${linkedShows}公演分追加`] });
    validateBzData(document.data);
    await saveBzData(document, document.data);
  }
}

report.linkedShows = linkedShows;
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ apply, plan: plan.summary, linkedShows, created: report.created.length, reused: report.reused.length, unresolved: report.unresolved.length, errors: report.errors.length }, null, 2)}\n`);
if (report.errors.length) process.exitCode = 1;
