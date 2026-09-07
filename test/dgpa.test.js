import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHtmlForKaohsiung, parseSuspensionForCity } from '../lib/dgpa.js';

// ── 向後相容的舊介面測試 ────────────────────────────────────────────────────

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

// ── 新的多縣市介面測試 ──────────────────────────────────────────────────────

test('parseSuspensionForCity - detects New Taipei City suspension', () => {
  const html = `
    <tr>
      <td class="table-city">新北市</td>
      <td class="table-status">停止上班、停止上課。</td>
    </tr>
  `;
  assert.equal(parseSuspensionForCity(html, '新北市'), true);
  assert.equal(parseSuspensionForCity(html, '高雄市'), false);
});

test('parseSuspensionForCity - detects Taoyuan City suspension', () => {
  const html = `
    <tr>
      <td class="table-city">桃園市</td>
      <td class="table-status">全天停止上班、全天停止上課。</td>
    </tr>
  `;
  assert.equal(parseSuspensionForCity(html, '桃園市'), true);
  assert.equal(parseSuspensionForCity(html, '新北市'), false);
});

test('parseSuspensionForCity - multiple cities suspended', () => {
  const html = `
    <tr>
      <td class="table-city">新北市</td>
      <td class="table-status">停止上班、停止上課。</td>
    </tr>
    <tr>
      <td class="table-city">桃園市</td>
      <td class="table-status">停止上班、停止上課。</td>
    </tr>
    <tr>
      <td class="table-city">高雄市</td>
      <td class="table-status">照常上班、照常上課。</td>
    </tr>
  `;
  assert.equal(parseSuspensionForCity(html, '新北市'), true);
  assert.equal(parseSuspensionForCity(html, '桃園市'), true);
  assert.equal(parseSuspensionForCity(html, '高雄市'), false);
});

test('parseSuspensionForCity - exclusion pattern per city', () => {
  const html = `
    <div>北部地區受颱風影響，除新北市外，其餘縣市停止上班、停止上課。</div>
  `;
  assert.equal(parseSuspensionForCity(html, '新北市'), false);
});

test('parseSuspensionForCity - returns false for null/empty inputs', () => {
  assert.equal(parseSuspensionForCity(null, '高雄市'), false);
  assert.equal(parseSuspensionForCity('', '高雄市'), false);
  assert.equal(parseSuspensionForCity('some html', ''), false);
  assert.equal(parseSuspensionForCity('some html', null), false);
});
