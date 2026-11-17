import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const a = html.indexOf('function escapeIcsText');
const b = html.indexOf('function calendarGoogleUrl');
const c = html.indexOf('function buildCalendarIcs');
const d = html.indexOf('function calendarIcsExportableEvents');

test('ICSの説明文の改行は \\n にエスケープされ、実際の改行を含まない', () => {
  const { escapeIcsText, foldIcsLine } = new Function(
    html.slice(a, b) + ';return {escapeIcsText,foldIcsLine}'
  )();
  const line = foldIcsLine('DESCRIPTION:' + escapeIcsText('1行目\n2行目;x,y'));
  assert.equal(line, 'DESCRIPTION:1行目\\n2行目\\;x\\,y');
  assert.ok(!/[\r\n]/.test(line));
});

test('ICSにTZID=Asia/TokyoのVTIMEZONEが含まれる', () => {
  const src = html.slice(c, d);
  assert.match(src, /BEGIN:VTIMEZONE/);
  assert.match(src, /TZID:Asia\/Tokyo/);
  assert.match(src, /END:VTIMEZONE/);
});
