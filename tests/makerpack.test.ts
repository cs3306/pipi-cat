import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPack, imageError, paletteErrors, suggestId } from '../src/makerPack.ts';

const meta = { id: 'sunny-cat', name: 'Sunny', author: 'Ray', license: 'CC-BY-4.0', version: '1.0.0' };

function png(w: number, h: number): string {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return 'data:image/png;base64,' + Buffer.from(b).toString('base64');
}

test('palette pack builds and keeps fields', () => {
  const r = buildPack({ meta, kind: 'palette', palette: { furColor: '#ffcc66', eyeColorTop: '#222' } });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal((r.pack as any).schema, 1);
    assert.equal((r.pack as any).palette.furColor, '#ffcc66');
  }
});

test('palette errors: bad colour, missing fur, too many spots', () => {
  assert.deepEqual(paletteErrors({ furColor: 'red' }), ['bad-color']);
  assert.deepEqual(paletteErrors({}), ['palette-needs-furColor']);
  const spots = Array.from({ length: 25 }, () => ({ color: '#fff' }));
  assert.ok(paletteErrors({ furColor: '#fff', spots }).includes('too-many-spots'));
  assert.deepEqual(paletteErrors({ furColor: '#fff', spots: [{ color: 'javascript:1' }] }), ['bad-color']);
});

test('metadata is required and id is checked', () => {
  const r = buildPack({ meta: { ...meta, id: 'AB', author: ' ', license: '' }, kind: 'palette', palette: { furColor: '#fff' } });
  assert.ok(!r.ok);
  if (!r.ok) assert.deepEqual(r.errors.sort(), ['bad-id', 'missing-author', 'missing-license'].sort());
});

test('sprite pack: needs idle, checks real header and PNG size', () => {
  assert.equal(imageError(png(100, 100)), null);
  assert.equal(imageError(png(3000, 10)), 'image-dimensions');
  assert.equal(imageError('data:image/png;base64,' + Buffer.from('not a png at all, just text........').toString('base64')), 'not-an-image');
  assert.equal(imageError('data:image/gif;base64,AAAA'), 'not-an-image');
  const none = buildPack({ meta, kind: 'sprites', sprites: {} });
  assert.ok(!none.ok && none.errors.includes('missing-idle-image'));
  const ok = buildPack({ meta, kind: 'sprites', sprites: { idle: png(64, 64), blink: png(64, 64) } });
  assert.ok(ok.ok);
});

test('suggestId only produces legal characters', () => {
  assert.equal(suggestId('  Sunny Cat!! '), 'sunny-cat');
  assert.equal(suggestId('小猫'), '');
});

test('layered pack: minimal torso+head passes; limbs, segments and tail are checked', () => {
  const img = png(64, 64);
  const ok = { scale: 1, parts: { torso: { image: img, pivot: [0.5, 1], attach: [0, 0], z: 10 }, head: { image: img, pivot: [0.5, 0.9], attach: [0, -100], z: 20 } } };
  assert.ok(buildPack({ meta, kind: 'layered', rig: ok }).ok);
  const seg = { image: img, pivot: [0.5, 0.1], end: [0.5, 0.9] };
  const full = { ...ok, parts: { ...ok.parts, limbs: { fl: { image: img, end: [0.5, 0.95] } }, tail: { image: img, segments: [seg, seg] } } };
  assert.ok(buildPack({ meta, kind: 'layered', rig: full }).ok);
});

test('layered pack errors: missing parts, geometry, unknown limb, too many segments', () => {
  const img = png(64, 64);
  const seg = { image: img, pivot: [0.5, 0.1], end: [0.5, 0.9] };
  const e = (rig: unknown) => { const r = buildPack({ meta, kind: 'layered', rig: rig as Record<string, unknown> }); return r.ok ? [] : r.errors; };
  assert.ok(e({ parts: { head: { image: img } } }).includes('missing-torso'));
  assert.ok(e({ parts: { torso: { image: img } } }).includes('missing-head'));
  assert.ok(e(undefined).includes('rig-missing'));
  const bad = e({ scale: 9, parts: { torso: { image: img, pivot: [2, 0], z: 500, attach: [9999, 0] }, head: { image: img }, limbs: { xx: { image: img } }, tail: { image: img, segments: [seg, seg, seg, seg] } } });
  for (const want of ['bad-scale', 'bad-pivot:torso', 'bad-z:torso', 'bad-attach:torso', 'unknown-limb:xx', 'too-many-segments:tail']) assert.ok(bad.includes(want), want);
  assert.ok(e({ parts: { torso: { image: img }, head: { image: img }, limbs: { fl: { image: img, pivot: [0.5, 0.5], end: [0.5, 0.52] } } } }).includes('bad-end:limb.fl'));
  assert.ok(e({ parts: { torso: { image: 'data:image/png;base64,AAAA' }, head: { image: img } } }).includes('not-an-image:torso'));
});
