import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPack } from '../tools/pack-skin.mjs';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const meta = { id: 'fish-skin', name: 'Fish', author: 'me', license: 'MIT', version: '1.0.0', kind: 'sprites' };

function dir(files) {
  const d = mkdtempSync(join(tmpdir(), 'skin-'));
  for (const [name, data] of Object.entries(files)) writeFileSync(join(d, name), data);
  return d;
}

test('sprites pack embeds images as data URIs that decode back to the same bytes', () => {
  const p = buildPack(dir({ 'skin.json': JSON.stringify(meta), 'idle.png': PNG_1x1, 'blink.png': PNG_1x1 }));
  assert.equal(p.schema, 1);
  assert.deepEqual(Object.keys(p.sprites).sort(), ['blink', 'idle']);
  const b64 = p.sprites.idle.replace('data:image/png;base64,', '');
  assert.ok(Buffer.from(b64, 'base64').equals(PNG_1x1));
});

test('palette pack requires palette.json', () => {
  assert.throws(() => buildPack(dir({ 'skin.json': JSON.stringify({ ...meta, kind: 'palette' }) })), /palette.json/);
  const p = buildPack(dir({ 'skin.json': JSON.stringify({ ...meta, kind: 'palette' }), 'palette.json': '{"furColor":"#fff"}' }));
  assert.equal(p.palette.furColor, '#fff');
});

test('rejects missing license, bad id, missing idle and unknown kind', () => {
  assert.throws(() => buildPack(dir({ 'skin.json': JSON.stringify({ ...meta, license: '' }), 'idle.png': PNG_1x1 })), /license/);
  assert.throws(() => buildPack(dir({ 'skin.json': JSON.stringify({ ...meta, id: 'Bad_ID' }), 'idle.png': PNG_1x1 })), /id/);
  assert.throws(() => buildPack(dir({ 'skin.json': JSON.stringify(meta) })), /idle/);
  assert.throws(() => buildPack(dir({ 'skin.json': JSON.stringify({ ...meta, kind: 'script' }) })), /kind/);
});

test('example palette skin in docs builds', () => {
  const p = buildPack(fileURLToPath(new URL('../docs/skins/examples/sunny-palette/', import.meta.url)));
  assert.equal(p.kind, 'palette');
  assert.equal(p.palette.furColor, '#f2c14e');
});
