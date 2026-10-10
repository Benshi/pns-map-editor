import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMap, addGuild, addMember, snapCell, validCell, footprint, terrain,
  objectAt, placeObject, placementError, territoryGuilds, importMap } from './model.js';

function fixture() {
  const state = emptyMap();
  addGuild(state, 'g1', '自ギルド');
  addMember(state, 'g1', 'm1', 'プレイヤー');
  return state;
}
const facility = (id, type, x = 264, y = 448, extra = {}) =>
  ({ id, type, x, y, size: 2, guildId: 'g1', ...extra });

test('coordinates snap to the nearest same-parity cell, including map edges', () => {
  assert.equal(validCell(1, 2), false);
  assert.deepEqual(snapCell(265, 449), { x: 265, y: 449 });
  assert.deepEqual(snapCell(264, 447.8), { x: 264, y: 448 });
  assert.deepEqual(snapCell(0, 1023), { x: 0, y: 1022 });
  assert.deepEqual(snapCell(900, -10), { x: 511, y: 1 });
  for (let x = 0; x < 12; x += 0.3) {
    const cell = snapCell(x, x * 2.7);
    assert.ok(validCell(cell.x, cell.y));
  }
  assert.throws(() => snapCell(NaN, 0));
});

test('south anchor footprints and selection work for both parities', () => {
  for (const [x, y] of [[264, 448], [265, 449]]) {
    const object = facility('f', 'fortress', x, y);
    assert.deepEqual(footprint(object), [{ x, y }, { x: x - 1, y: y - 1 },
      { x, y: y - 2 }, { x: x + 1, y: y - 1 }]);
    const state = fixture();
    placeObject(state, object);
    for (const cell of footprint(object)) assert.equal(objectAt(state, cell.x, cell.y).id, 'f');
  }
  assert.deepEqual(footprint({ x: 2, y: 2, size: 1 }), [{ x: 2, y: 2 }]);
});

test('terrain includes polygon boundaries and excludes guild facilities from all non-grass cells', () => {
  assert.equal(terrain(256, 512), 'lab');
  assert.equal(terrain(244, 512), 'lab');
  assert.equal(terrain(256, 472), 'wasteland');
  assert.equal(terrain(218, 511), 'wasteland');
  assert.equal(terrain(264, 448), 'grass');
  assert.match(placementError(fixture(), facility('f', 'fortress', 256, 512)), /緑地/);
  assert.match(placementError(fixture(), facility('f', 'fortress', 256, 472)), /緑地/);
  assert.match(placementError(fixture(), facility('f', 'fortress', 0, 0)), /マップ内/);
});

test('overlaps, mountains, singleton facilities and member shelters are enforced', () => {
  const state = fixture();
  placeObject(state, facility('f', 'fortress'));
  assert.throws(() => placeObject(state, facility('h', 'hospital', 265, 449)), /重な/);
  assert.throws(() => placeObject(state, facility('f2', 'fortress', 280, 440)), /一つ/);
  placeObject(state, facility('r', 'resource', 280, 440));
  assert.throws(() => placeObject(state, facility('r2', 'resource', 290, 440)), /一つ/);
  placeObject(state, facility('s', 'shelter', 270, 450, { memberId: 'm1' }));
  assert.throws(() => placeObject(state, facility('s2', 'shelter', 276, 450, { memberId: 'm1' })), /配置済み/);
  assert.throws(() => placeObject(state, facility('s3', 'shelter', 276, 450, { memberId: 'other' })), /メンバー/);
  placeObject(state, { id: 'mount', type: 'mountain', size: 2, x: 290, y: 460 });
  assert.throws(() => placeObject(state, facility('w', 'warehouse', 291, 461)), /重な/);
  placeObject(state, facility('f', 'fortress', 266, 448), 'f');
  assert.equal(state.facilities.find(f => f.id === 'f').x, 266);
});

test('territory uses south-anchor offsets, clips wasteland and returns all overlapping guilds', () => {
  const state = fixture();
  placeObject(state, facility('f', 'fortress', 214, 452));
  for (const [x, y] of [[202, 452], [226, 452], [210, 440], [214, 464]]) {
    assert.deepEqual(territoryGuilds(state, x, y), ['g1']);
  }
  assert.deepEqual(territoryGuilds(state, 200, 452), []);
  addGuild(state, 'g2', '他ギルド');
  placeObject(state, facility('f2', 'fortress', 224, 452, { guildId: 'g2' }));
  assert.deepEqual(territoryGuilds(state, 220, 452), ['g1', 'g2']);
  assert.deepEqual(territoryGuilds(state, 224, 506), []);
  const edge = fixture();
  placeObject(edge, facility('f', 'fortress', 256, 462));
  assert.deepEqual(territoryGuilds(edge, 256, 470), ['g1']);
  assert.deepEqual(territoryGuilds(edge, 256, 472), []);
});

test('member limits, names and duplicate members are validated', () => {
  const state = fixture();
  assert.throws(() => addGuild(state, 'g2', '  '), /ギルド名/);
  assert.throws(() => addMember(state, 'g1', 'm2', 'プレイヤー'), /同じ/);
  for (let i = 2; i <= 100; i++) addMember(state, 'g1', `m${i}`, `P${i}`);
  assert.throws(() => addMember(state, 'g1', 'm101', 'P101'), /最大100/);
});

test('JSON sharing round-trips and rejects invalid data without changing current state', () => {
  const state = fixture();
  placeObject(state, facility('f', 'fortress'));
  placeObject(state, facility('s', 'shelter', 270, 450, { memberId: 'm1' }));
  assert.deepEqual(importMap(JSON.parse(JSON.stringify(state))), state);
  const bad = structuredClone(state);
  bad.facilities[1].x = 264;
  bad.facilities[1].y = 448;
  assert.throws(() => importMap(bad), /重な/);
  bad.facilities[1].type = 'toString';
  assert.throws(() => importMap(bad), /種類/);
  bad.facilities[1].type = 'mountain';
  assert.throws(() => importMap(bad), /種類/);
  assert.throws(() => importMap({ ...state, ownGuildId: 'missing' }), /自ギルド/);
  assert.equal(state.facilities[1].x, 270);
});
