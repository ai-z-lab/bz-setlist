import test from "node:test";
import assert from "node:assert/strict";
import { buildPlaylistPlan } from "../scripts/playlist-plan.mjs";

function fixture() {
  return {
    updated: "2026-10-29",
    shows: [
      { id: "a", date: "2026/10/1", tour: "TEST", venue: "A", status: "入力済", playlists: { spotify: "https://open.spotify.com/playlist/existing" } },
      { id: "b", date: "2026/10/2", tour: "TEST", venue: "B", status: "入力済" },
      { id: "c", date: "2026/10/3", tour: "TEST", venue: "C", status: "入力済" },
    ],
    calendarEvents: [],
    setlists: [
      { showId: "a", order: 1, song: "ONE", section: "main" },
      { showId: "a", order: 2, song: "TWO", section: "encore" },
      { showId: "b", order: 1, song: "ONE", section: "main" },
      { showId: "b", order: 2, song: "TWO", section: "encore" },
      { showId: "c", order: 1, song: "ONE", section: "main" },
      { showId: "c", order: 2, song: "THREE", section: "encore" },
    ],
  };
}

test("groups identical setlists and reuses an existing provider link", () => {
  const plan = buildPlaylistPlan(fixture());
  assert.equal(plan.summary.shows, 3);
  assert.equal(plan.summary.uniqueSetlists, 2);
  assert.equal(plan.summary.playlistsToCreate.spotify, 1);
  assert.equal(plan.summary.playlistsToCreate.youtubeMusic, 2);
  assert.equal(plan.summary.linksReusableWithoutCreation.spotify, 1);
});

test("keeps different encore songs in different groups", () => {
  const plan = buildPlaylistPlan(fixture());
  const groups = plan.groups.map((group) => group.tracks.map((track) => track.song).join(","));
  assert.deepEqual(groups.sort(), ["ONE,THREE", "ONE,TWO"]);
});
