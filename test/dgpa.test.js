import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHtmlForKaohsiung } from '../lib/dgpa.js';

test('parseHtmlForKaohsiung - normal day returns false', () => {
  const normalHtml = `
    <html>
      <body>
        <div>今日各縣市均照常上班、照常上課。</div>
        <div>更新時間：2026/09/02 17:00:00</div>
      </body>
    </html>
  `;
  assert.equal(parseHtmlForKaohsiung(normalHtml), false);
});

test('parseHtmlForKaohsiung - Kaohsiung suspension returns true', () => {
  const typhoonHtml = `
    <tr>
      <td class="table-city">高雄市</td>
      <td class="table-status">停止上班、停止上課。</td>
    </tr>
  `;
  assert.equal(parseHtmlForKaohsiung(typhoonHtml), true);
});

test('parseHtmlForKaohsiung - exclusion wording returns false', () => {
  const exclusionHtml = `
    <div>南部地區受颱風影響，除高雄市外，其餘縣市停止上班、停止上課。</div>
  `;
  assert.equal(parseHtmlForKaohsiung(exclusionHtml), false);
});

test('parseHtmlForKaohsiung - Kaohsiung normal work returns false', () => {
  const normalKaohsiungHtml = `
    <tr>
      <td class="table-city">高雄市</td>
      <td class="table-status">照常上班、照常上課。</td>
    </tr>
  `;
  assert.equal(parseHtmlForKaohsiung(normalKaohsiungHtml), false);
});
