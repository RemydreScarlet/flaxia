import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  applyReward,
  computeScore,
  createProjection,
  createState,
  deserializeState,
  eventReward,
  parseBanditConfig,
  project,
  serializeState,
} from '../functions/lib/linucb.ts';

describe('linucb', () => {
  it('state starts as identity with zero accumulators', () => {
    const s = createState(4);
    assert.equal(s.b.length, 4);
    assert.equal(s.aInv.length, 16);
    assert.equal(s.t, 0);
    for (let i = 0; i < 4; i++) assert.equal(s.aInv[i * 4 + i], 1);
  });

  it('computeScore is finite and grows with exploration alpha', () => {
    const s = createState(4);
    const x = [1, 0, 0, 0];
    const base = computeScore(s, x, 0);
    const ucb = computeScore(s, x, 1);
    assert.ok(Number.isFinite(ucb));
    assert.ok(ucb >= base);
  });

  it('projection is deterministic and matches output dimension', () => {
    const p1 = createProjection(8, 4, 42);
    const p2 = createProjection(8, 4, 42);
    assert.deepEqual(p1, p2);
    const out = project([1, 2, 3, 4, 5, 6, 7, 8], p1);
    assert.equal(out.length, 4);
    assert.ok(out.every((v) => Number.isFinite(v)));
  });

  it('positive reward on a feature raises its estimated score', () => {
    const s = createState(4);
    const x = [1, 0, 0, 0];
    applyReward(s, x, 1);
    const before = computeScore(s, x, 0);
    applyReward(s, x, 1);
    const after = computeScore(s, x, 0);
    assert.ok(after >= before);
  });

  it('negative reward lowers the estimated score', () => {
    const s = createState(4);
    const x = [1, 0, 0, 0];
    applyReward(s, x, 1);
    const before = computeScore(s, x, 0);
    applyReward(s, x, 0);
    const after = computeScore(s, x, 0);
    assert.ok(after <= before);
  });

  it('serialize/deserialize round-trips the state', () => {
    const s = createState(4);
    applyReward(s, [1, 2, 3, 4], 1);
    const json = serializeState(s);
    const back = deserializeState(json, 4);
    assert.equal(back.t, s.t);
    assert.deepEqual(
      back.b,
      s.b.map((v) => Math.round(v / 1e-6) * 1e-6),
    );
    assert.deepEqual(
      back.aInv,
      s.aInv.map((v) => Math.round(v / 1e-6) * 1e-6),
    );
  });

  it('deserializeState rejects malformed payloads', () => {
    assert.throws(() => deserializeState('{}', 4));
    assert.throws(() => deserializeState(JSON.stringify({ v: 1, aInv: [], b: [] }), 4));
    assert.throws(() => deserializeState(JSON.stringify({ v: 1, aInv: [1, 2, 3], b: [1, 2] }), 4));
  });

  it('eventReward maps engagement events to rewards', () => {
    assert.equal(eventReward('fresh', 0), 1);
    assert.equal(eventReward('reply', 0), 1);
    assert.equal(eventReward('share', 0), 0.8);
    assert.equal(eventReward('fullscreen', 0), 0.6);
    assert.equal(eventReward('view', 30000), 1);
    assert.equal(eventReward('view', 1000), 1000 / 30000);
    assert.equal(eventReward('view', 0), 0);
    assert.equal(eventReward('bogus', 5000), 5000 / 30000);
  });

  it('parseBanditConfig defaults to disabled', () => {
    const c = parseBanditConfig(null);
    assert.equal(c.enabled, false);
    assert.equal(c.dim, 64);
    assert.equal(c.alpha, 0.6);
    assert.equal(c.lambda, 0.6);
  });

  it('parseBanditConfig clamps out-of-range values', () => {
    const c = parseBanditConfig('{"enabled":true,"dim":100000,"lambda":9,"alpha":-3}');
    assert.equal(c.enabled, true);
    assert.ok(c.dim <= 256);
    assert.ok(c.dim >= 8);
    assert.ok(c.lambda <= 1 && c.lambda >= 0);
    assert.ok(c.alpha >= 0);
  });

  it('parseBanditConfig falls back on invalid JSON', () => {
    const c = parseBanditConfig('not json');
    assert.equal(c.enabled, false);
  });
});
