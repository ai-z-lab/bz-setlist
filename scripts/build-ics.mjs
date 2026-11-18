// 購読用のICSファイル(bz-*.ics)を index.html のデータから生成する。
// 使い方: node scripts/build-ics.mjs   (データを変えたら実行してコミットする。tests/ics-feeds.test.mjs が古さを検出する)
process.env.TZ = "Asia/Tokyo";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const FEEDS = [
  { file: "bz-live.ics", name: "B'z 公演", types: ["live"] },
  { file: "bz-ticket.ics", name: "B'z チケット", types: ["entry_start","entry_deadline","lottery_result","general_sale","resale","door_sale"] },
  { file: "bz-goods.ics", name: "B'z グッズ", types: ["goods"] },
  { file: "bz-all.ics", name: "B'z すべて", types: null }
];

export function buildFeeds(htmlPath = path.join(root, "index.html")) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const m = html.match(/window\.BZ_DATA = (\{.*\});/);
  if (!m) throw new Error("window.BZ_DATA が見つかりません");
  const BZ = JSON.parse(m[1]);
  const a = html.indexOf("const CALENDAR_TYPE_LABELS");
  const b = html.indexOf("function calendarIcsExportableEvents");
  if (a < 0 || b < 0) throw new Error("ICS生成の関数が見つかりません");
  const api = new Function("data", html.slice(a, b) + ";return {calendarEvents, calendarIcsTiming, buildCalendarIcs};")(BZ);
  const dtstamp = `${String(BZ.updated || "2026-01-01").replace(/-/g, "")}T000000Z`;
  // 購読で古い予定が散らからないよう、データの更新日の30日前以降のものだけ入れる(実行日に依存しない)
  const cutoff = new Date(`${BZ.updated || "2026-01-01"}T00:00:00+09:00`);
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const all = api.calendarEvents().filter(e => api.calendarIcsTiming(e) && (e.endDate || e.date) >= cutoffStr);
  const out = {};
  for (const f of FEEDS) {
    const events = f.types ? all.filter(e => f.types.includes(e.type)) : all;
    out[f.file] = api.buildCalendarIcs(events, { name: f.name, dtstamp });
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const feeds = buildFeeds();
  for (const [file, text] of Object.entries(feeds)) {
    fs.writeFileSync(path.join(root, file), text);
    console.log(file, (text.match(/BEGIN:VEVENT/g) || []).length + "件");
  }
}
