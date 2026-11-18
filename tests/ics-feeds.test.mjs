import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildFeeds } from '../scripts/build-ics.mjs';

const feeds = buildFeeds();

for (const [file, expected] of Object.entries(feeds)) {
  test(`${file} は index.html のデータと一致している(古ければ node scripts/build-ics.mjs を実行)`, () => {
    const actual = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(actual, expected);
  });

  test(`${file} は規格どおり(生の改行なし・VTIMEZONEあり・BEGIN/ENDが対応)`, () => {
    assert.ok(!/[^\r]\n/.test(expected));
    assert.match(expected, /BEGIN:VTIMEZONE/);
    assert.equal(expected.split('BEGIN:VEVENT').length, expected.split('END:VEVENT').length);
    assert.match(expected, /X-WR-CALNAME:/);
  });
}
