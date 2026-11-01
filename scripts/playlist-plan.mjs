#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBzData, orderedSetlist, playlistSignature, signatureId, validateBzData } from "./lib/bz-data.mjs";

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

export function buildPlaylistPlan(data, { tour = "", showIds = [] } = {}) {
  validateBzData(data);
  const selectedIds = new Set(showIds);
  const shows = data.shows.filter((show) =>
    (!tour || show.tour === tour)
    && (!selectedIds.size || selectedIds.has(show.id)),
  );
  const groups = new Map();

  for (const show of shows) {
    const tracks = orderedSetlist(data, show.id);
    if (!tracks.length) continue;
    const signature = playlistSignature(data, show.id);
    const id = signatureId(signature);
    if (!groups.has(id)) groups.set(id, { id, signature, tracks: tracks.map((row) => ({ order: row.order, song: row.song, section: row.section || "main" })), shows: [] });
    groups.get(id).shows.push({
      id: show.id,
      date: show.date,
      tour: show.tour,
      series: show.series,
      venue: show.venue,
      area: show.area,
      playlists: show.playlists || {},
    });
  }

  const plannedGroups = [...groups.values()].map((group) => {
    return {
      id: group.id,
      tracks: group.tracks,
      shows: group.shows,
      needs: {
        spotify: group.shows.filter((show) => !show.playlists.spotify).map((show) => show.id),
        youtubeMusic: group.shows.filter((show) => !show.playlists.youtubeMusic).map((show) => show.id),
      },
    };
  });

  const missingShows = shows.filter((show) => !show.playlists?.spotify || !show.playlists?.youtubeMusic);
  return {
    generatedAt: new Date().toISOString(),
    sourceUpdated: data.updated,
    filter: { tour: tour || null },
    summary: {
      shows: shows.length,
      completeShows: shows.length - missingShows.length,
      missingShows: missingShows.length,
      uniqueSetlists: plannedGroups.length,
      playlistsToCreate: {
        spotify: plannedGroups.reduce((count, group) => count + group.needs.spotify.length, 0),
        youtubeMusic: plannedGroups.reduce((count, group) => count + group.needs.youtubeMusic.length, 0),
      },
      linksReusableWithoutCreation: {
        spotify: 0,
        youtubeMusic: 0,
      },
    },
    groups: plannedGroups.filter((group) => group.needs.spotify.length || group.needs.youtubeMusic.length),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const document = await loadBzData(argValue("index", "index.html"));
  const plan = buildPlaylistPlan(document.data, { tour: argValue("tour") });
  const output = `${JSON.stringify(plan, null, 2)}\n`;
  const outputFile = argValue("output");
  if (outputFile) await writeFile(outputFile, output, "utf8");
  else process.stdout.write(output);
}
