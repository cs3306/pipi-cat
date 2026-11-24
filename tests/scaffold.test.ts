import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralPose, lerpPose, clampPose, twoBoneIK } from '../src/pose/pose.ts';
import { AnimationRegistry } from '../src/pose/animation.ts';
import { validateManifest, isSafeRelativeImagePath } from '../src/character/manifest.ts';
import { sanitizeSkinExt, resolveSkinExt, deriveApronColor } from '../src/skinExt.ts';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('IK: reachable target is hit exactly and segment lengths preserved', () => {
  const s = { x: 10, y: 20 };
  const t = { x: 40, y: 60 };
  const r = twoBoneIK(s, t, 30, 30, 1);
  assert.equal(r.clamped, false);
  close(r.end.x, t.x); close(r.end.y, t.y);
  close(Math.hypot(r.elbow.x - s.x, r.elbow.y - s.y), 30);
  close(Math.hypot(r.end.x - r.elbow.x, r.end.y - r.elbow.y), 30);
});

test('IK: bend flips the elbow to the other side', () => {
  const a = twoBoneIK({ x: 0, y: 0 }, { x: 40, y: 0 }, 30, 30, 1);
  const b = twoBoneIK({ x: 0, y: 0 }, { x: 40, y: 0 }, 30, 30, -1);
  close(a.elbow.y, -b.elbow.y);
  assert.ok(Math.abs(a.elbow.y) > 1);
});

test('IK: too far / too near is clamped, never NaN', () => {
  const far = twoBoneIK({ x: 0, y: 0 }, { x: 500, y: 0 }, 30, 30, 1);
  assert.equal(far.clamped, true);
  assert.ok(Number.isFinite(far.elbow.x) && Number.isFinite(far.end.x));
  assert.ok(far.end.x <= 60);
  const near = twoBoneIK({ x: 0, y: 0 }, { x: 0, y: 0 }, 40, 20, 1);
  assert.equal(near.clamped, true);
  assert.ok(Number.isFinite(near.elbow.x) && Number.isFinite(near.elbow.y));
  assert.throws(() => twoBoneIK({ x: 0, y: 0 }, { x: 1, y: 1 }, 0, 5, 1), RangeError);
});

test('pose lerp / clamp', () => {
  const a = neutralPose();
  const b = { ...neutralPose(), mouthOpen: 1, props: { head: 'hat' } };
  close(lerpPose(a, b, 0.5).mouthOpen, 0.5);
  assert.deepEqual(lerpPose(a, b, 0.2).props, {});
  assert.deepEqual(lerpPose(a, b, 0.8).props, { head: 'hat' });
  const c = clampPose({ ...a, mouthOpen: 9, headTilt: -9 });
  assert.equal(c.mouthOpen, 1);
  assert.equal(c.headTilt, -1.2);
});

test('animation registry: stance override with generic fallback', () => {
  const mk = (id: string, tag: number) => ({ id, duration: 1, sample: () => ({ ...neutralPose(), headTilt: tag }) });
  const reg = new AnimationRegistry();
  reg.register({ generic: mk('typing', 1) });
  reg.register({ generic: mk('snack.churu', 2), overrides: { upright: mk('snack.churu', 3) } });
  const ctx = (stance: 'quadruped' | 'upright') => ({ t: 0, anchors: {}, stance });
  assert.equal(reg.resolve('typing', 'upright')!.sample(ctx('upright')).headTilt, 1);
  assert.equal(reg.resolve('snack.churu', 'quadruped')!.sample(ctx('quadruped')).headTilt, 2);
  assert.equal(reg.resolve('snack.churu', 'upright')!.sample(ctx('upright')).headTilt, 3);
  assert.equal(reg.resolve('nope', 'upright'), null);
  assert.throws(() => reg.register({ generic: mk('typing', 9) }));
});

const goodManifest = () => ({
  schemaVersion: 1, id: 'miku-like', name: 'Test', stance: 'upright',
  layers: [
    { id: 'head', file: 'head.png', pivot: { x: 1, y: 1 }, z: 3 },
    { id: 'torso', file: 'body/torso.png', pivot: { x: 0, y: 0 }, z: 1 },
    { id: 'armL', file: 'armL.png', pivot: { x: 0, y: 0 }, z: 2 },
    { id: 'armR', file: 'armR.png', pivot: { x: 0, y: 0 }, z: 2 },
  ],
  head: 'head', torso: 'torso',
  leftArm: { upper: 'armL', shoulder: { x: 5, y: 5 }, bend: 1 },
  rightArm: { upper: 'armR', shoulder: { x: 9, y: 5 }, bend: -1 },
});

test('manifest: valid minimal manifest degrades gracefully', () => {
  const r = validateManifest(goodManifest());
  assert.ok(r.ok, r.errors.join('; '));
  assert.deepEqual([...r.degradations].sort(), ['no-blink', 'no-mouth', 'single-segment-arm']);
});

test('manifest: rejects path escapes and bad refs', () => {
  for (const bad of ['../x.png', '/etc/a.png', 'C:/a.png', 'a\\b.png', 'a/./b.png', 'a.exe', '', 'a//b.png']) {
    assert.equal(isSafeRelativeImagePath(bad), false, bad);
  }
  assert.equal(isSafeRelativeImagePath('a/b.WEBP'), true);
  const m: any = goodManifest();
  m.layers[0].file = '../../secret.png';
  m.head = 'nope';
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('layers[0].file')));
  assert.ok(r.errors.some((e) => e.startsWith('head')));
  assert.equal(validateManifest(42).ok, false);
});

test('skinExt: derive defaults, reject bad colors visibly', () => {
  assert.equal(deriveApronColor('#111111'), '#f4f1ea');
  assert.equal(deriveApronColor('#f0e0d0'), '#3b4a6b');
  const r = resolveSkinExt('#111111', undefined);
  assert.equal(r.schemaVersion, 1);
  const s = sanitizeSkinExt({ apronColor: '#AABBCC', tongueColor: 'red', schemaVersion: 7 });
  assert.equal(s.value.apronColor, '#aabbcc');
  assert.deepEqual(s.rejected.sort(), ['schemaVersion', 'tongueColor']);
});
