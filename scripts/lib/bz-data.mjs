import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const DATA_MARKER = "window.BZ_DATA = ";

function findDataRange(html) {
  const markerStart = html.indexOf(DATA_MARKER);
  if (markerStart < 0) throw new Error("window.BZ_DATA was not found");
  const start = markerStart + DATA_MARKER.length;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1 };
    }
  }
  throw new Error("window.BZ_DATA JSON is not terminated");
}

export async function loadBzData(file = "index.html") {
  const html = await readFile(file, "utf8");
  const range = findDataRange(html);
  const data = JSON.parse(html.slice(range.start, range.end));
  return { data, html, range, file };
}

export async function saveBzData(document, data) {
  const json = JSON.stringify(data);
  const html = `${document.html.slice(0, document.range.start)}${json}${document.html.slice(document.range.end)}`;
  await writeFile(document.file, html, "utf8");
}

export function orderedSetlist(data, showId) {
  return data.setlists
    .filter((row) => row.showId === showId)
    .sort((left, right) => left.order - right.order);
}

export function playlistSignature(data, showId) {
  return orderedSetlist(data, showId)
    .map((row) => `${row.section || "main"}\u0000${row.song}`)
    .join("\u0001");
}

export function signatureId(signature) {
  return createHash("sha256").update(signature).digest("hex").slice(0, 16);
}

export function validateBzData(data) {
  const errors = [];
  const showIds = new Set();
  const eventIds = new Set();
  const setlistKeys = new Set();

  for (const show of data.shows) {
    if (showIds.has(show.id)) errors.push(`duplicate show id: ${show.id}`);
    showIds.add(show.id);
  }
  for (const event of data.calendarEvents) {
    if (eventIds.has(event.id)) errors.push(`duplicate calendar event id: ${event.id}`);
    eventIds.add(event.id);
  }
  for (const row of data.setlists) {
    const key = `${row.showId}#${row.order}`;
    if (setlistKeys.has(key)) errors.push(`duplicate setlist order: ${key}`);
    setlistKeys.add(key);
    if (!showIds.has(row.showId)) errors.push(`dangling setlist showId: ${row.showId}`);
  }
  for (const show of data.shows) {
    const rows = orderedSetlist(data, show.id);
    rows.forEach((row, index) => {
      if (row.order !== index + 1) errors.push(`non-contiguous order: ${show.id}`);
    });
  }
  if (errors.length) throw new Error(errors.join("\n"));
}
