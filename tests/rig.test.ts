import test from 'node:test';
import assert from 'node:assert/strict';
import { imageRefs, parseRig } from '../src/rig/rigTypes.ts';
import { clampRigPose, neutralRigPose, poseFromInput, type RigInput } from '../src/rig/rigPose.ts';
import { solveSingleLimb, solveTwoSegments, tailRelAngles } from '../src/rig/rigMath.ts';

const IMG = 'data:image/png;base64,AAAA';

test('parseRig keeps a minimal torso+head skin and fills defaults', () => {
  const r = parseRig({ parts: { torso: { image: IMG }, head: { image: IMG } } });
  assert.ok(r);
  assert.equal(r!.scale, 1);
  assert.deepEqual(r!.torso.attach, [0, 0]);
  assert.deepEqual(r!.limbs, {});
  assert.equal(r!.tail, undefined);
});

test('parseRig returns null without a drawable torso or head', () => {
  assert.equal(parseRig(null), null);
  assert.equal(parseRig({ parts: { torso: { image: IMG } } }), null);
  assert.equal(parseRig({ parts: { torso: { image: 'http://evil/x.png' }, head: { image: IMG } } }), null);
  assert.equal(parseRig({ parts: { torso: {}, head: { image: IMG } } }), null);
});

test('parseRig clamps numbers, drops bad optional parts, caps segments', () => {
  const seg = { image: IMG, pivot: [0.5, 0.1], end: [0.5, 0.9] };
  const r = parseRig({
    scale: 99,
    parts: {
      torso: { image: IMG, attach: [99999, -99999], z: 500 },
      head: { image: IMG, pivot: [2, -1] },
      limbs: { fl: { image: IMG, end: [0.5, 0.1], pivot: [0.5, 0.1] }, xx: { image: IMG }, fr: { image: 'nope' } },
      tail: { segments: [seg, seg, seg, seg, seg] },
    },
  })!;
  assert.equal(r.scale, 4);
  assert.deepEqual(r.torso.attach, [2000, -2000]);
  assert.equal(r.torso.z, 100);
  assert.deepEqual(r.head.pivot, [1, 0]);
  assert.deepEqual(Object.keys(r.limbs), ['fl']);
  assert.deepEqual(r.limbs.fl!.end, [0.5, 0.95]); // end 与 pivot 重合 → 换成默认
  assert.equal(r.tail!.segments!.length, 3);
});

test('imageRefs lists every image once with stable keys', () => {
  const r = parseRig({
    parts: {
      torso: { image: IMG },
      head: { image: IMG, eyesClosedImage: IMG, mouthOpenImage: IMG },
      limbs: { fl: { segments: [{ image: IMG, end: [0.5, 0.9] }, { image: IMG, end: [0.5, 0.9] }] } },
      tail: { image: IMG },
    },
  })!;
  assert.deepEqual(imageRefs(r).map(([k]) => k), ['torso', 'head', 'head.eyesClosed', 'head.mouthOpen', 'limb.fl.seg0', 'limb.fl.seg1', 'tail']);
});

test('clampRigPose repairs NaN and out-of-range values', () => {
  const p = neutralRigPose();
  p.headTilt = 9;
  p.squash = NaN;
  p.eyesClosed = -3;
  p.limbs.fl = { target: { x: NaN, y: 1 }, planted: true };
  const c = clampRigPose(p);
  assert.equal(c.headTilt, 1.2);
  assert.equal(c.squash, 1);
  assert.equal(c.eyesClosed, 0);
  assert.equal(c.limbs.fl.target, null);
});

const input = (over: Partial<RigInput> = {}): RigInput => ({
  now: 1000, breath: 0, typingEnergy: 0, sleep: 0, squint: 0, happy: false, shy: false, headTilt: 0, earL: 0, earR: 0,
  left: { active: false, x: 0, y: 0 }, right: { active: false, x: 0, y: 0 }, tail: { reach: 0, tipX: 0 }, anchorX: 200, ...over,
});

test('adapter: idle is calm; typing leans and aims limbs; sleep closes eyes', () => {
  const idle = poseFromInput(input());
  assert.equal(idle.limbs.fl.target, null);
  assert.equal(idle.eyesClosed, 0);
  const typing = poseFromInput(input({ typingEnergy: 1, left: { active: true, x: 150, y: 300 }, right: { active: true, x: 250, y: 300 } }));
  assert.ok(typing.lean > 0.2);
  assert.deepEqual(typing.limbs.fl.target, { x: 150, y: 300 });
  assert.equal(typing.limbs.hl.target, null);
  assert.equal(poseFromInput(input({ sleep: 0.8 })).eyesClosed, 1);
  assert.ok(poseFromInput(input({ tail: { reach: 1, tipX: 400 } })).tail.angle > 0.5);
});

test('single limb solver points at the target and limits stretch', () => {
  const a = solveSingleLimb(Math.PI / 2, 100, { x: 100, y: 0 }); // 静止向下，目标在右边
  assert.ok(Math.abs(a.rot - -Math.PI / 2) < 1e-9);
  assert.equal(a.stretch, 1);
  assert.equal(solveSingleLimb(0, 100, { x: 1000, y: 0 }).stretch, 1.25);
  assert.equal(solveSingleLimb(0, 100, { x: 1, y: 0 }).stretch, 0.8);
  assert.deepEqual(solveSingleLimb(0, 100, { x: 0, y: 0 }), { rot: 0, stretch: 1 });
});

test('two-segment solver reaches reachable targets and never returns NaN', () => {
  const r = solveTwoSegments(60, 60, Math.PI / 2, Math.PI / 2, { x: 0, y: 100 }, 1);
  assert.ok(Math.hypot(r.end.x, r.end.y - 100) < 1e-6);
  const far = solveTwoSegments(60, 60, Math.PI / 2, Math.PI / 2, { x: 0, y: 1000 }, -1);
  for (const v of [far.rot0, far.rot1, far.elbow.x, far.elbow.y]) assert.ok(Number.isFinite(v));
});

test('tail angles: one per segment, bounded, calmer sway when tail is busy', () => {
  const calm = tailRelAngles(3, { angle: 0, curl: 0, sway: 1 }, 1);
  assert.equal(calm.length, 3);
  const busy = tailRelAngles(3, { angle: 0, curl: 0, sway: 1 }, 0);
  assert.deepEqual(busy, [0, 0, 0]);
  for (const a of calm) assert.ok(Math.abs(a) <= 0.12 + 1e-9);
});
