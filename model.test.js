import test from 'node:test';
import assert from 'node:assert/strict';
import { EditHistory } from './persistence.js';
import { emptyMap, addGuild, addMember, snapCell, validCell, footprint, terrain,
  objectAt, placeObject, placementError, territoryGuilds, importMap,
  addMembers, renameMember, renameGuild, orderedMembers, setMemberRank, setMemberRanks, territorySources,
  territoryContains, territoryBoundary, territorySourceBoundaries, territoryGuildBoundaries, cellBoundary, placedFacility, mapOutline, shelterColor, SHELTER_RANK_COLORS,
  TYPES, WASTELAND, BASE, BASE_CELLS, TURRETS, parseMapView, initialMapView, membersFor,
  changeMembership, objectGuildId, deleteGuild, reorderMember, edgeVelocity, DEFAULT_SCALE, MAX_SCALE } from './model.js';

test('map outline is one closed jagged boundary around the valid parity grid', () => {
  const outlines = mapOutline();
  const [outline] = outlines;
  assert.equal(outlines.length, 1);
  assert.deepEqual(outline[0], outline.at(-1));
  assert.ok(outline.length > 300);
  assert.ok(outline.slice(1).every(([x, y], index) =>
    Math.abs(x - outline[index][0]) === 1 && Math.abs(y - outline[index][1]) === 1));
  assert.ok(outline.some(([x]) => x === -1));
  assert.ok(outline.some(([x]) => x === 512));
  assert.ok(outline.some(([, y]) => y === -1));
  assert.ok(outline.some(([, y]) => y === 1024));
});

test('shelter rank marker colors provide six distinct colors including unset', () => {
  const colors = [null, 1, 2, 3, 4, 5].map(shelterColor);
  assert.equal(new Set(colors).size, 6);
  assert.deepEqual(colors, [SHELTER_RANK_COLORS.unset, ...[1, 2, 3, 4, 5].map(rank => SHELTER_RANK_COLORS[rank])]);
  assert.ok(colors.every(color => /^#[0-9a-f]{6}$/.test(color)));
  assert.deepEqual(
    [5, 4, 3, 2, 1].map(shelterColor),
    ['#ff4d4d', '#ffd34e', '#c879ff', '#4be08a', '#45bfff'],
  );
});

test('selected source boundary excludes terrain and mountains but ignores other guild coverage', () => {
  const state = fixture();
  const source = facility('f', 'fortress', 214, 452);
  placeObject(state, source);
  const original = territoryBoundary(state, source);
  assert.equal(original.length, 52);
  addGuild(state, 'other', 'OTH');
  placeObject(state, facility('other-f', 'fortress', 218, 452, { guildId: 'other' }));
  assert.deepEqual(territoryBoundary(state, source), original);
  placeObject(state, { id: 'mount', type: 'mountain', size: 2, x: 210, y: 452 });
  const carved = territoryBoundary(state, source);
  assert.ok(carved.length > original.length);
  assert.ok(carved.some(edge => JSON.stringify(edge) === JSON.stringify([[209,452],[210,453]])));
  const outpost = facility('o', 'outpost1', 224, 452, { size: 1 });
  placeObject(state, outpost);
  assert.ok(territoryBoundary(state, outpost).length);
  const detached = facility('d', 'outpost2', 300, 450, { size: 1 });
  placeObject(state, detached);
  assert.deepEqual(territoryBoundary(state, detached), []);
  const south = { ...source, x: 256, y: 552 };
  const clipped = territoryBoundary({ ...state, facilities: [south] }, south);
  assert.ok(clipped.length);
  assert.ok(clipped.every(edge => edge.every(([, y]) => y > 539)));
  assert.ok(clipped.some(edge => edge.some(([x, y]) => x === 256 && y === 551)));
});

test('guild territory boundary unions its active sources without carving mountains', () => {
  const state = fixture();
  const fortress = facility('f', 'fortress', 214, 452);
  placeObject(state, fortress);
  const beforeMountain = territoryGuildBoundaries(state).get('g1');
  assert.ok(beforeMountain.length > 0);
  assert.equal(territoryGuildBoundaries(state).has('g2'), false);

  placeObject(state, { id: 'mount', type: 'mountain', size: 2, x: 210, y: 452 });
  assert.deepEqual(territoryGuildBoundaries(state).get('g1'), beforeMountain);

  const outpost = facility('o', 'outpost1', 224, 452, { size: 1 });
  placeObject(state, outpost);
  const withOutpost = territoryGuildBoundaries(state).get('g1');
  assert.ok(withOutpost.length > 0);
  assert.notDeepEqual(withOutpost, beforeMountain);

  addGuild(state, 'g2', '他ギルド');
  placeObject(state, facility('other-f', 'fortress', 300, 450, { guildId: 'g2' }));
  assert.ok(territoryGuildBoundaries(state).has('g2'));
});

test('individual range boundaries are available for every active fortress and connected outpost', () => {
  const state = fixture();
  const fortress = facility('f', 'fortress', 214, 452);
  const outpost = facility('o', 'outpost1', 224, 452, { size: 1 });
  const detached = facility('d', 'outpost2', 300, 450, { size: 1 });
  placeObject(state, fortress);
  placeObject(state, outpost);
  placeObject(state, detached);
  const boundaries = territorySourceBoundaries(state);
  assert.deepEqual([...boundaries.keys()], ['f', 'o']);
  assert.deepEqual(boundaries.get('f'), territoryBoundary(state, fortress));
  assert.deepEqual(boundaries.get('o'), territoryBoundary(state, outpost));
  assert.ok(boundaries.get('o').length > 0);
  assert.equal(boundaries.has('d'), false);
});

test('replacing a singleton keeps its identity and validates with only itself excluded', () => {
  const state = fixture();
  const source = facility('f', 'fortress', 214, 452);
  placeObject(state, source);
  const candidate = { ...source, id: 'draft', x: 216, y: 452 };
  assert.equal(placedFacility(state, candidate).id, 'f');
  assert.equal(placementError(state, candidate, source.id), null);
  placeObject(state, { ...source, x: 216, y: 452 }, source.id);
  assert.equal(state.facilities.length, 1);
  assert.equal(state.facilities[0].id, 'f');
  assert.equal(state.facilities[0].x, 216);
  assert.equal(placedFacility(state, { type: 'mountain' }), null);
  assert.equal(placedFacility(state, { ...candidate, guildId: 'other' }), null);
  assert.equal(placedFacility(state, { ...candidate, type: 'outpost1' }), null);
});

test('map links validate server, guild and scale and focus only the requested fortress', () => {
  assert.deepEqual(parseMapView(''), { server: null, guild: null, scale: 14, code: null, revision: null, x: null, y: null });
  assert.deepEqual(parseMapView('?server=1047&guild=ABC&scale=20'), { server: 'S1047', guild: 'ABC', scale: 20, code: null, revision: null, x: null, y: null });
  assert.equal(parseMapView('?map=Abc123_-xyzQ&guild=AbC&revision=12').revision, 12);
  assert.equal(parseMapView('?map=Abc123_-xyzQ&guild=AbC').code, 'Abc123_-xyzQ');
  assert.equal(parseMapView('?server=S1063&scale=0.3').scale, .3);
  assert.equal(parseMapView('?scale=40').scale, 40);
  assert.equal(parseMapView('?scale=42').scale, MAX_SCALE);
  assert.equal(MAX_SCALE / DEFAULT_SCALE * 100, 300);
  for (const query of ['?server=', '?server=foo', '?server=1&server=2', '?guild=AB', '?guild=日本語', '?scale=', '?scale=NaN', '?scale=0.2', '?scale=42.1', '?hash=abc', '?map=abc', '?map=Abc123_-xyzQ&server=1063', '?map=Abc123_-xyzQ&map=Abc123_-xyzQ', '?revision=0', '?revision=-1', '?revision=1&revision=2', '?revision=1000000000']) {
    assert.throws(() => parseMapView(query), /URL/);
  }
  const state = fixture();
  renameGuild(state, 'g1', 'ABC');
  placeObject(state, facility('f', 'fortress', 264, 448));
  assert.deepEqual(initialMapView(state, 'ABC', 20), { x: 264, y: 448, scale: 20 });
  addGuild(state, 'lower', 'abc');
  placeObject(state, facility('lower-f', 'fortress', 280, 450, { guildId: 'lower' }));
  assert.deepEqual(initialMapView(state, parseMapView('?guild=abc').guild, 20), { x: 280, y: 450, scale: 20 });
  assert.deepEqual(initialMapView(state, 'Abc', 20), { x: 256, y: 512, scale: 20 });
  assert.deepEqual(initialMapView(state, null, 14), { x: 256, y: 512, scale: 14 });
  assert.deepEqual(initialMapView(state, 'XYZ', 14), { x: 256, y: 512, scale: 14 });
  state.facilities = [];
  assert.deepEqual(initialMapView(state, 'ABC', 14), { x: 256, y: 512, scale: 14 });
});

test('map links accept a coordinate pair that overrides fortress focus without requiring cell parity', () => {
  const state = fixture();
  const link = parseMapView('?x=0&y=1023&scale=42');
  assert.deepEqual(initialMapView(state, 'ABC', link.scale, link.x, link.y), { x: 0, y: 1023, scale: 42 });
  const fractional = parseMapView('?x=123.5&y=456.25');
  assert.deepEqual(initialMapView(state, null, fractional.scale, fractional.x, fractional.y),
    { x: 123.5, y: 456.25, scale: 14 });
  for (const query of ['?x=1', '?y=1', '?x=&y=1', '?x=1&y=', '?x=NaN&y=1', '?x=1&y=Infinity',
    '?x=-1&y=1', '?x=512&y=1', '?x=1&y=1024', '?x=1&y=-1', '?x=1&x=2&y=3', '?x=1&y=2&y=3']) {
    assert.throws(() => parseMapView(query), /URL/);
  }
});

test('member reordering preserves other ranks, guilds, IDs, placements and saved order', () => {
  const state = fixture();
  addGuild(state, 'other', 'OTH');
  addMember(state, 'g1', 'a', 'A', 3);
  addMember(state, 'other', 'other-member', 'Other', 3);
  addMember(state, 'g1', 'leader', 'Leader', 5);
  addMember(state, 'g1', 'b', 'B', 3);
  addMember(state, 'g1', 'c', 'C', 3);
  placeObject(state, facility('s', 'shelter', 214, 452, { playerId: 'c' }));
  const original = structuredClone(state);
  const history = new EditHistory(state);
  history.record(state);
  reorderMember(state, 'g1', 'c', 'a');
  assert.deepEqual(membersFor(state, 'g1').filter(member => member.rank === 3).map(member => member.id), ['c', 'a', 'b']);
  for (const player of original.players.filter(player => !['a', 'b', 'c'].includes(player.id))) {
    assert.deepEqual(state.players[original.players.findIndex(entry => entry.id === player.id)], player);
  }
  assert.deepEqual(state.facilities, original.facilities);
  assert.deepEqual(importMap(state).players, state.players);
  assert.deepEqual(history.undo(state), original);
  reorderMember(state, 'g1', 'c');
  assert.deepEqual(membersFor(state, 'g1').filter(member => member.rank === 3).map(member => member.id), ['a', 'b', 'c']);
  const unchanged = structuredClone(state);
  reorderMember(state, 'g1', 'a', 'a');
  assert.deepEqual(state, unchanged);
  for (const [guildId, id, target] of [['g1', 'a', 'leader'], ['g1', 'a', 'other-member'], ['other', 'a', null], ['g1', 'missing', null]]) {
    assert.throws(() => reorderMember(state, guildId, id, target), /メンバー|所属/);
    assert.deepEqual(state, unchanged);
  }
  addMember(state, null, 'unaffiliated-a', 'Unattached A');
  addMember(state, null, 'unaffiliated-b', 'Unattached B');
  reorderMember(state, null, 'unaffiliated-b', 'unaffiliated-a');
  assert.deepEqual(membersFor(state, null).map(member => member.id), ['unaffiliated-b', 'unaffiliated-a']);
});

test('edge scrolling is directional, accelerates near boundaries and stops away from the viewport', () => {
  assert.equal(edgeVelocity(150, 300), 0);
  assert.equal(edgeVelocity(56, 300), 0);
  assert.equal(edgeVelocity(244, 300), 0);
  assert.equal(edgeVelocity(0, 300), -360);
  assert.equal(edgeVelocity(300, 300), 360);
  assert.equal(edgeVelocity(28, 300), -90);
  assert.equal(edgeVelocity(272, 300), 90);
  assert.equal(edgeVelocity(-57, 300), 0);
  assert.equal(edgeVelocity(357, 300), 0);
  assert.equal(edgeVelocity(5, 0), 0);
  assert.equal(edgeVelocity(50, 100), 0);
});

test('bulk registration is atomic and rename preserves shelter identity and coordinates', () => {
  const state = fixture();
  let n = 0;
  addMembers(state, 'g1', 'One\r\nTwo\n\nThree', () => `bulk-${++n}`);
  assert.equal(state.players.length, 4);
  addMembers(state, 'g1', 'Planned', () => `bulk-${++n}`, null);
  assert.equal(state.players.at(-1).rank ?? null, null);
  assert.deepEqual(addMembers(state, 'g1', 'Four\nOne\nFour\nプレイヤー', () => `bulk-${++n}`, 4),
    { added: 1, skipped: 3 });
  assert.equal(state.players.at(-1).rank, 4);
  const before = structuredClone(state);
  assert.throws(() => addMembers(state, 'g1', `Five\n${'x'.repeat(81)}`, () => `bulk-${++n}`), /80/);
  assert.deepEqual(state, before);
  placeObject(state, facility('s', 'shelter', 270, 450, { playerId: 'm1' }));
  renameMember(state, 'g1', 'm1', 'Renamed');
  renameGuild(state, 'g1', 'ABC');
  assert.equal(state.facilities[0].playerId, 'm1');
  assert.equal(state.facilities[0].x, 270);
  assert.equal(importMap(state).players[0].name, 'Renamed');
  assert.throws(() => renameMember(state, 'g1', 'm1', 'One'), /同じ/);
});

test('bulk duplicates preserve IDs, ranks and ordering, including a full guild', () => {
  const state = fixture();
  let n = 0;
  const id = () => `bulk-${++n}`;
  assert.deepEqual(addMembers(state, 'g1', 'B\nA\nB', id, 3), { added: 2, skipped: 1 });
  const before = structuredClone(state);
  assert.deepEqual(addMembers(state, 'g1', ' A \nB\nプレイヤー', id, 5), { added: 0, skipped: 3 });
  assert.deepEqual(state, before);
  assert.deepEqual(state.players.map(m => m.name), ['プレイヤー', 'B', 'A']);
  assert.throws(() => addMembers(state, 'g1', 'C', id, 6), /ランク/);
  assert.throws(() => addMembers(state, 'missing', 'C', id), /ギルド/);
  assert.throws(() => addMembers(state, 'g1', ' \n ', id), /1行/);
  for (let i = 3; i < 100; i++) addMember(state, 'g1', `m${i}`, `P${i}`);
  const full = structuredClone(state);
  assert.deepEqual(addMembers(state, 'g1', 'B\nB', id, 4), { added: 0, skipped: 2 });
  assert.deepEqual(addMembers(state, 'g1', 'B\nC\nD', id, 4), { added: 2, skipped: 1 });
  assert.equal(state.players.length, 102);
  assert.deepEqual(state.players.slice(0, 100), full.players);
  assert.deepEqual(importMap(state), state);
});

test('batch rank changes are atomic, allow multiple R5 members and preserve placement and order', () => {
  const state = fixture();
  addMember(state, 'g1', 'a', 'A', 3);
  addMember(state, 'g1', 'b', 'B', 4);
  placeObject(state, facility('s', 'shelter', 270, 450, { playerId: 'a' }));
  const facilities = structuredClone(state.facilities);
  const ids = state.players.map(member => member.id);
  assert.equal(setMemberRanks(state, 'g1', ['a', 'b', 'a'], 5), 2);
  assert.equal(state.players.filter(member => member.rank === 5).length, 2);
  assert.deepEqual(state.facilities, facilities);
  assert.deepEqual(state.players.map(member => member.id), ids);
  assert.deepEqual(importMap(state), state);
  const before = structuredClone(state);
  for (const [guildId, selectedIds, rank] of [
    ['g1', ['a', 'missing'], 3], ['missing', ['a'], 3], ['g1', [], 3], ['g1', ['a'], 6],
  ]) {
    assert.throws(() => setMemberRanks(state, guildId, selectedIds, rank));
    assert.deepEqual(state, before);
  }
  assert.equal(setMemberRanks(state, 'g1', ['a', 'b'], null), 2);
  assert.equal(state.players.some(member => Object.hasOwn(member, 'rank')), false);
  assert.deepEqual(state.facilities, facilities);
});

test('rank edits round-trip without relocating shelters and rank groups retain insertion order', () => {
  const state = fixture();
  addMember(state, 'g1', 'b', 'B', 3);
  addMember(state, 'g1', 'a', 'A', 3);
  addMember(state, 'g1', 'leader', 'Leader', 5);
  placeObject(state, facility('s', 'shelter', 270, 450, { playerId: 'b' }));
  const shelter = structuredClone(state.facilities[0]);
  setMemberRank(state, 'g1', 'b', 4);
  assert.deepEqual(orderedMembers(state.players).map(m => m.id), ['leader', 'b', 'a', 'm1']);
  assert.deepEqual(importMap(state), state);
  assert.deepEqual(state.facilities[0], shelter);
  setMemberRank(state, 'g1', 'b', 3);
  assert.deepEqual(orderedMembers(state.players).map(m => m.id), ['leader', 'b', 'a', 'm1']);
  setMemberRank(state, 'g1', 'b', null);
  assert.equal(Object.hasOwn(state.players[1], 'rank'), false);
  const bad = structuredClone(state);
  bad.players[0].rank = '3';
  assert.throws(() => importMap(bad), /ランク/);
});

test('five numbered 1x1 outposts validate and extend only fortress-connected territory', () => {
  const state = fixture();
  const outpost = (n, x, y) => facility(`o${n}`, `outpost${n}`, x, y, { size: 1 });
  placeObject(state, facility('f', 'fortress', 214, 452));
  placeObject(state, outpost(2, 234, 452));
  placeObject(state, outpost(1, 224, 452));
  placeObject(state, outpost(3, 260, 440));
  placeObject(state, outpost(4, 270, 440));
  placeObject(state, outpost(5, 300, 440));
  assert.equal(TYPES.outpost6, undefined);
  assert.throws(() => placeObject(state, outpost(6, 310, 440)), /種類/);
  assert.deepEqual(territorySources(state).detached.map(o => o.id), ['o3', 'o4', 'o5']);
  assert.deepEqual(territoryGuilds(state, 244, 452), ['g1']);
  assert.deepEqual(territoryGuilds(state, 246, 452), []);
  assert.deepEqual(territoryGuilds(state, 270, 440), []);
  assert.deepEqual(footprint(state.facilities[1]), [{ x: 234, y: 452 }]);
  assert.throws(() => placeObject(state, outpost(1, 280, 450)), /一つ/);
  assert.match(placementError(state, { ...outpost(1, 280, 450), size: 2 }), /1×1/);
  assert.match(placementError(state, outpost(1, 224, 452)), /重な/);
  assert.deepEqual(importMap(state), state);
  state.facilities = state.facilities.filter(o => o.id !== 'o1');
  assert.ok(territorySources(state).detached.some(o => o.id === 'o2'));
  state.facilities = state.facilities.filter(o => o.id !== 'f');
  assert.equal(territorySources(state).active.length, 0);
  assert.equal(territorySources(state).detached.length, 4);
  assert.equal(new Set(['fortress','resource','trap','warehouse','hospital','shelter','outpost1']
    .map(type => TYPES[type].color)).size, 7);
});

test('updated wasteland and fixed facility coordinates match specified vertices', () => {
  assert.deepEqual(WASTELAND, [[217,511],[256,472],[295,511],[256,550]]);
  for (let i = 0; i < WASTELAND.length; i++) {
    const [x, y] = WASTELAND[i];
    const [nextX, nextY] = WASTELAND[(i + 1) % WASTELAND.length];
    assert.equal(Math.abs(nextX - x), Math.abs(nextY - y));
  }
  for (const [x, y] of WASTELAND) assert.equal(terrain(x, y), 'wasteland');
  assert.deepEqual(BASE, [[253,511],[256,508],[259,511],[256,514]]);
  assert.deepEqual(BASE_CELLS.map(({ x, y }) => `${x},${y}`), [
    '253,511', '254,510', '254,512', '255,509', '255,511', '255,513',
    '256,508', '256,510', '256,512', '256,514',
    '257,509', '257,511', '257,513', '258,510', '258,512', '259,511',
  ]);
  assert.ok(BASE_CELLS.every(({ x, y }) => validCell(x, y)));
  assert.deepEqual(TURRETS, [[256,502],[246,512],[256,522],[266,512]]);
});

test('observed western boundary cells and west turret footprint match the game', () => {
  const outerCells = [[244,512],[245,513],[246,514],[247,509],[247,515],[247,513],[248,512]];
  const wastelandCells = [[245,515],[244,510],[245,509],[246,508],[246,516],[247,507],[247,517]];
  for (const [x, y] of outerCells) assert.equal(terrain(x, y), 'lab', `${x},${y}`);
  for (const [x, y] of wastelandCells) assert.equal(terrain(x, y), 'wasteland', `${x},${y}`);
  const [x, y] = TURRETS[1];
  const turretCells = footprint({ x, y, size: 2 }).map(({ x, y }) => `${x},${y}`).sort();
  assert.deepEqual(turretCells, ['245,511', '247,511', '246,510', '246,512'].sort());
  for (const [x, y] of outerCells) assert.ok(!turretCells.includes(`${x},${y}`));
});

test('every complete turret footprint is inside the lab terrain region', () => {
  for (const [x, y] of TURRETS) {
    for (const cell of footprint({ x, y, size: 2 })) {
      assert.equal(terrain(cell.x, cell.y), 'lab', `turret cell ${cell.x},${cell.y}`);
    }
  }
});

function fixture() {
  const state = emptyMap();
  addGuild(state, 'g1', '自ギルド');
  addMember(state, 'g1', 'm1', 'プレイヤー');
  return state;
}
const facility = (id, type, x = 264, y = 448, extra = {}) =>
  ({ id, type, x, y, size: 2, ...(type === 'shelter' ? {} : { guildId: 'g1' }), ...extra });

test('coordinates snap to the nearest same-parity cell, including map edges', () => {
  assert.equal(validCell(1, 2), false);
  assert.deepEqual(snapCell(265, 449), { x: 265, y: 449 });
  assert.deepEqual(snapCell(264, 447.8), { x: 264, y: 448 });
  assert.deepEqual(snapCell(0, 1023), { x: 0, y: 1022 });
  assert.deepEqual(snapCell(900, -10), { x: 510, y: 0 });
  assert.deepEqual(snapCell(265, 448), { x: 264, y: 448 });
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

test('terrain includes polygon boundaries and limits non-grass placement to wasteland shelters', () => {
  assert.equal(terrain(256, 512), 'lab');
  assert.equal(terrain(244, 512), 'lab');
  assert.equal(terrain(256, 472), 'wasteland');
  assert.equal(terrain(218, 511), 'wasteland');
  assert.equal(terrain(264, 448), 'grass');
  assert.match(placementError(fixture(), facility('f', 'fortress', 256, 512)), /緑地/);
  assert.match(placementError(fixture(), facility('f', 'fortress', 256, 472)), /緑地/);
  assert.match(placementError(fixture(), { id: 'mount', type: 'mountain', size: 2, x: 246, y: 508 }), /緑地/);
  assert.equal(placementError(fixture(), facility('s', 'shelter', 246, 508, { playerId: 'm1' })), null);
  assert.match(placementError(fixture(), facility('s', 'shelter', 245, 515, { playerId: 'm1' })), /実験基地外囲/);
  assert.match(placementError(fixture(), facility('f', 'fortress', 0, 0)), /マップ内/);
});

test('mountains retain their anchor but occupy only non-wasteland cells and restore on relocation', () => {
  const state = fixture();
  const mountain = { id: 'clipped', type: 'mountain', size: 2, x: 254, y: 474 };
  assert.deepEqual(footprint(mountain), [{ x: 253, y: 473 }, { x: 254, y: 472 }]);
  assert.equal(placementError(state, mountain), null);
  placeObject(state, mountain);
  assert.equal(objectAt(state, 253, 473).id, 'clipped');
  assert.equal(objectAt(state, 254, 474), undefined);
  assert.equal(objectAt(state, 255, 473), undefined);
  assert.deepEqual(importMap(JSON.parse(JSON.stringify(state))).mountains, state.mountains);
  assert.equal(placementError(state, facility('s', 'shelter', 256, 474, { playerId: 'm1' })), null);
  const restored = { ...mountain, x: 280, y: 440 };
  placeObject(state, facility('occupied', 'hospital', 280, 440));
  assert.match(placementError(state, restored, mountain.id), /重な/);
  assert.equal(state.mountains[0].x, 254);
  state.facilities = [];
  placeObject(state, restored, mountain.id);
  assert.equal(footprint(state.mountains[0]).length, 4);
  assert.equal(state.mountains[0].id, mountain.id);
  assert.match(placementError(state, { ...mountain, x: 256, y: 512 }), /実験基地外囲/);
});

test('cell boundaries exclude internal edges for one, two and three connected mountain cells', () => {
  const cells = [{ x: 254, y: 472 }, { x: 253, y: 473 }, { x: 255, y: 473 }];
  for (let count = 1; count <= 3; count++) {
    const boundary = cellBoundary(cells.slice(0, count));
    assert.equal(boundary.length, 2 * count + 2);
    for (const [, end] of boundary) {
      assert.equal(boundary.filter(([start]) => start[0] === end[0] && start[1] === end[1]).length, 1);
    }
  }
});

test('overlaps, mountains, singleton facilities and member shelters are enforced', () => {
  const state = fixture();
  placeObject(state, facility('f', 'fortress'));
  assert.throws(() => placeObject(state, facility('h', 'hospital', 265, 449)), /重な/);
  assert.throws(() => placeObject(state, facility('f2', 'fortress', 280, 440)), /一つ/);
  placeObject(state, facility('r', 'resource', 280, 440));
  assert.throws(() => placeObject(state, facility('r2', 'resource', 290, 440)), /一つ/);
  placeObject(state, facility('s', 'shelter', 270, 450, { playerId: 'm1' }));
  assert.throws(() => placeObject(state, facility('s2', 'shelter', 276, 450, { playerId: 'm1' })), /配置済み/);
  assert.throws(() => placeObject(state, facility('s3', 'shelter', 276, 450, { playerId: 'other' })), /プレイヤー/);
  placeObject(state, { id: 'mount', type: 'mountain', size: 2, x: 290, y: 460 });
  assert.throws(() => placeObject(state, facility('w', 'warehouse', 291, 461)), /重な/);
  placeObject(state, facility('f', 'fortress', 266, 448), 'f');
  assert.equal(state.facilities.find(f => f.id === 'f').x, 266);
});

test('territory uses south-anchor offsets, clips wasteland and returns all overlapping guilds', () => {
  const state = fixture();
  placeObject(state, facility('f', 'fortress', 214, 452));
  for (const [x, y] of [[202, 452], [226, 452], [214, 440], [214, 464], [220, 458]]) {
    assert.deepEqual(territoryGuilds(state, x, y), ['g1']);
  }
  assert.deepEqual(territoryGuilds(state, 200, 452), []);
  for (const [x, y] of [[202, 440], [226, 440], [226, 464], [202, 464], [222, 458]]) {
    assert.deepEqual(territoryGuilds(state, x, y), []);
  }
  addGuild(state, 'g2', '他ギルド');
  placeObject(state, facility('f2', 'fortress', 224, 452, { guildId: 'g2' }));
  assert.deepEqual(territoryGuilds(state, 220, 452), ['g1', 'g2']);
  assert.deepEqual(territoryGuilds(state, 224, 506), []);
  placeObject(state, { id: 'mount', type: 'mountain', size: 2, x: 220, y: 454 });
  assert.deepEqual(territoryGuilds(state, 220, 454), []);
  const edge = fixture();
  placeObject(edge, facility('f', 'fortress', 256, 462));
  assert.deepEqual(territoryGuilds(edge, 256, 470), ['g1']);
  assert.deepEqual(territoryGuilds(edge, 256, 472), []);
});

test('diamond territory includes cardinal vertices and excludes corners for rendering and outpost chains', () => {
  const state = fixture();
  const fortress = facility('f', 'fortress', 214, 452);
  placeObject(state, fortress);
  for (let dx = -14; dx <= 14; dx++) {
    for (let dy = -14; dy <= 14; dy++) {
      assert.equal(territoryContains(fortress, 214 + dx, 452 + dy), Math.abs(dx) + Math.abs(dy) <= 12);
    }
  }
  placeObject(state, facility('corner', 'outpost1', 224, 462, { size: 1 }));
  placeObject(state, facility('edge', 'outpost2', 224, 454, { size: 1 }));
  assert.deepEqual(territorySources(state).detached.map(object => object.id), []);
  const outpost = state.facilities.find(object => object.id === 'edge');
  for (const [dx, dy] of [[-10,0],[10,0],[0,-10],[0,10],[4,6]]) {
    assert.equal(territoryContains(outpost, outpost.x + dx, outpost.y + dy), true);
  }
  assert.equal(territoryContains(outpost, outpost.x + 10, outpost.y + 10), false);
  state.facilities = state.facilities.filter(object => object.id !== 'edge');
  assert.deepEqual(territorySources(state).detached.map(object => object.id), ['corner']);
  assert.deepEqual(territoryGuilds(state, 224, 462), []);
});

test('member counts may exceed game limits while names and duplicates remain validated', () => {
  const state = fixture();
  assert.throws(() => addGuild(state, 'g2', '  '), /ギルド名/);
  assert.throws(() => addMember(state, 'g1', 'm2', 'プレイヤー'), /同じ/);
  for (let i = 2; i <= 100; i++) addMember(state, 'g1', `m${i}`, `P${i}`);
  addMember(state, 'g1', 'm101', 'P101', 5);
  addMember(state, 'g1', 'm102', 'P102', 5);
  assert.equal(state.players.length, 102);
  assert.deepEqual(importMap(state), state);
});

test('JSON sharing round-trips and rejects invalid data without changing current state', () => {
  const state = fixture();
  placeObject(state, facility('f', 'fortress'));
  placeObject(state, facility('s', 'shelter', 270, 450, { playerId: 'm1' }));
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

test('legacy guild members migrate to independent players without losing IDs, rank or shelters', () => {
  const legacy = { version: 1, ownGuildId: 'g', guilds: [
    { id: 'g', name: 'ABC', members: [{ id: 'p', name: 'Player', rank: 4 }] },
  ], facilities: [{ id: 's', type: 'shelter', guildId: 'g', memberId: 'p', size: 2, x: 220, y: 452 }], mountains: [] };
  const migrated = importMap(legacy);
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.players, [{ id: 'p', name: 'Player', guildId: 'g', rank: 4 }]);
  assert.deepEqual(migrated.guilds, [{ id: 'g', name: 'ABC' }]);
  assert.deepEqual(migrated.facilities, [{ id: 's', type: 'shelter', playerId: 'p', size: 2, x: 220, y: 452 }]);
  assert.deepEqual(importMap(migrated), migrated);
  assert.equal(legacy.version, 1);
  legacy.facilities[0].guildId = 'missing';
  assert.throws(() => importMap(legacy), /所属メンバー/);
});

test('joining, transferring, leaving and deleting guilds preserve player and shelter identity', () => {
  const state = fixture();
  addGuild(state, 'g2', 'OTH');
  placeObject(state, facility('s', 'shelter', 270, 450, { playerId: 'm1' }));
  const shelter = structuredClone(state.facilities[0]);
  setMemberRank(state, 'g1', 'm1', 5);
  changeMembership(state, 'm1', 'g2', 3);
  assert.equal(membersFor(state, 'g1').length, 0);
  assert.equal(membersFor(state, 'g2')[0].rank, 3);
  assert.equal(objectGuildId(state, shelter), 'g2');
  assert.deepEqual(state.facilities[0], shelter);
  changeMembership(state, 'm1', null);
  assert.equal(state.players[0].guildId, null);
  assert.equal(Object.hasOwn(state.players[0], 'rank'), false);
  assert.equal(objectGuildId(state, shelter), null);
  assert.deepEqual(importMap({ ...state, ownGuildId: null }).players, state.players);
  assert.match(placementError(state, { ...shelter, id: 'duplicate', x: 280 }), /配置済み/);
  changeMembership(state, 'm1', 'g1', 4);
  placeObject(state, facility('f', 'fortress', 214, 452));
  deleteGuild(state, 'g1');
  assert.equal(state.players[0].guildId, null);
  assert.deepEqual(state.facilities, [shelter]);
  assert.deepEqual(importMap(state), state);
});

test('unaffiliated registration and invalid membership changes are atomic', () => {
  const state = emptyMap();
  let count = 0;
  addMembers(state, null, 'Solo\nOther', () => `p${++count}`, null);
  placeObject(state, { id: 's', type: 'shelter', playerId: 'p1', size: 2, x: 220, y: 452 });
  assert.deepEqual(importMap(state), state);
  renameMember(state, null, 'p1', 'Renamed');
  addGuild(state, 'g', 'ABC');
  addMember(state, 'g', 'p3', 'Renamed', 3);
  const before = structuredClone(state);
  for (const operation of [
    () => changeMembership(state, 'p1', 'missing'),
    () => changeMembership(state, 'missing', 'g'),
    () => changeMembership(state, 'p1', null, 3),
    () => changeMembership(state, 'p1', 'g'),
    () => changeMembership(state, 'p3', null),
    () => setMemberRanks(state, null, ['p1'], 3),
    () => addMembers(state, null, 'Valid\n' + 'x'.repeat(81), () => `p${++count}`),
    () => deleteGuild(state, 'g'),
  ]) {
    assert.throws(operation);
    assert.deepEqual(state, before);
  }
  const bad = structuredClone(state);
  bad.players[0].guildId = 'missing';
  assert.throws(() => importMap(bad), /ギルド/);
  bad.players[0].guildId = null;
  bad.players[0].rank = 3;
  assert.throws(() => importMap(bad), /未所属/);
  bad.players[0].rank = null;
  bad.players[1].id = bad.players[0].id;
  assert.throws(() => importMap(bad), /ID/);
  const history = new EditHistory(state);
  history.record(state);
  changeMembership(state, 'p2', 'g', 4);
  const changed = structuredClone(state);
  assert.equal(history.dirty(state), true);
  const undone = history.undo(state);
  assert.deepEqual(undone, before);
  assert.deepEqual(history.redo(undone), changed);
});

test('large mountain maps import and placement cannot exceed restorable limits', () => {
  const state = emptyMap();
  for (let x = 2; x <= 98; x += 4) {
    for (let y = 2; y <= 1022; y += 4) {
      state.mountains.push({ id: `mount-${x}-${y}`, type: 'mountain', size: 2, x, y });
    }
  }
  for (let x = 102; state.mountains.length < 10000; x += 4) {
    for (let y = 2; y <= 1022 && state.mountains.length < 10000; y += 4) {
      state.mountains.push({ id: `mount-${x}-${y}`, type: 'mountain', size: 2, x, y });
    }
  }
  assert.deepEqual(importMap(state), state);
  assert.throws(() => placeObject(state, { id: 'extra', type: 'mountain', size: 2, x: 400, y: 400 }), /上限/);
  placeObject(state, { ...state.mountains[0], x: 400, y: 400 }, state.mountains[0].id);
  assert.equal(importMap(state).mountains.length, 10000);
  const overlapping = structuredClone(state);
  overlapping.mountains[1].x = overlapping.mountains[0].x;
  overlapping.mountains[1].y = overlapping.mountains[0].y;
  assert.throws(() => importMap(overlapping), /重な/);
});
