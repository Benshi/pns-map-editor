export const TYPES = Object.freeze({
  fortress: { name: 'ギルド要塞', short: '要塞', size: 2, color: '#c99524' },
  resource: { name: 'ギルド資源', short: '資源', size: 2, color: '#287d53' },
  trap: { name: 'スピーカートラップ', short: '響罠', size: 2, color: '#b34d3d' },
  warehouse: { name: 'ギルド倉庫', short: '倉庫', size: 2, color: '#7956a6' },
  hospital: { name: 'ギルド病院', short: '病院', size: 2, color: '#258b91' },
  shelter: { name: '避難所', short: '避難所', size: 2, color: '#385a88' },
  ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [
    `outpost${i + 1}`, { name: `ギルド前哨${i + 1}`, short: `前哨${i + 1}`, size: 1, color: '#b36c2e' },
  ])),
});

export const RANKS = [5, 4, 3, 2, 1, null];
export const SHELTER_RANK_COLORS = Object.freeze({
  unset: '#f5f5f5',
  1: '#45bfff',
  2: '#4be08a',
  3: '#c879ff',
  4: '#ffd34e',
  5: '#ff4d4d',
});
export function shelterColor(rank) {
  return SHELTER_RANK_COLORS[rank ?? 'unset'];
}
export const rankName = rank => rank == null ? 'ランク未設定' : `R${rank}`;
export function orderedMembers(members) {
  return RANKS.flatMap(rank => members.filter(member => (member.rank ?? null) === rank));
}
export function membersFor(state, guildId) {
  return state.players.filter(player => player.guildId === guildId);
}
export function reorderMember(state, guildId, memberId, beforeId = null) {
  const member = membersFor(state, guildId).find(player => player.id === memberId);
  if (!member) throw new Error('移動するメンバーが見つかりません。');
  const group = membersFor(state, guildId).filter(player => (player.rank ?? null) === (member.rank ?? null));
  if (beforeId !== null && !group.some(player => player.id === beforeId)) {
    throw new Error('移動先は同じ所属・ランクのメンバーを選択してください。');
  }
  if (beforeId === memberId) return;
  const reordered = group.filter(player => player.id !== memberId);
  reordered.splice(beforeId === null ? reordered.length : reordered.findIndex(player => player.id === beforeId), 0, member);
  const ids = new Set(group.map(player => player.id));
  let index = 0;
  state.players = state.players.map(player => ids.has(player.id) ? reordered[index++] : player);
}

export const DEFAULT_SCALE = 14;
export const MIN_SCALE = .3;
export const MAX_SCALE = 42;
export function edgeVelocity(position, size) {
  const margin = Math.min(56, size / 4);
  if (margin <= 0 || position < -margin || position > size + margin) return 0;
  if (position < margin) return -360 * Math.min(1, (margin - position) / margin) ** 2;
  if (position > size - margin) return 360 * Math.min(1, (position - size + margin) / margin) ** 2;
  return 0;
}
export function objectGuildId(state, object) {
  return object.type === 'shelter'
    ? state.players.find(player => player.id === object.playerId)?.guildId ?? null : object.guildId;
}
function validateMembership(state, guildId, rank) {
  validateRank(rank);
  if (guildId !== null && !state.guilds.some(guild => guild.id === guildId)) {
    throw new Error('ギルドを選択してください。');
  }
  if (guildId === null && rank !== null) throw new Error('未所属プレイヤーにランクは設定できません。');
}
export function changeMembership(state, playerId, guildId, rank = null) {
  validateMembership(state, guildId, rank);
  const player = state.players.find(entry => entry.id === playerId);
  if (!player) throw new Error('プレイヤーが見つかりません。');
  if (membersFor(state, guildId).some(entry => entry.id !== playerId && entry.name === player.name)) {
    throw new Error('変更先に同名のプレイヤーが存在します。名前を確認してください。');
  }
  player.guildId = guildId;
  if (rank === null) delete player.rank;
  else player.rank = rank;
}
export function deleteGuild(state, guildId) {
  if (!state.guilds.some(guild => guild.id === guildId)) throw new Error('ギルドを選択してください。');
  const next = structuredClone(state);
  for (const player of membersFor(next, guildId)) changeMembership(next, player.id, null);
  next.guilds = next.guilds.filter(guild => guild.id !== guildId);
  next.facilities = next.facilities.filter(object => object.type === 'shelter' || object.guildId !== guildId);
  if (next.ownGuildId === guildId) next.ownGuildId = next.guilds[0]?.id ?? null;
  Object.assign(state, next);
}
function validateRank(rank) {
  if (!RANKS.includes(rank)) throw new Error('ランクは R5〜R1 または未設定を選択してください。');
}
export function setMemberRank(state, guildId, memberId, rank) {
  setMemberRanks(state, guildId, [memberId], rank);
}
export function setMemberRanks(state, guildId, memberIds, rank) {
  validateMembership(state, guildId, rank);
  const ids = new Set(memberIds);
  if (!ids.size) throw new Error('メンバーを選択してください。');
  const members = membersFor(state, guildId).filter(member => ids.has(member.id));
  if (members.length !== ids.size) throw new Error('選択メンバーが見つかりません。');
  for (const member of members) {
    if (rank === null) delete member.rank;
    else member.rank = rank;
  }
  return members.length;
}

export const LAB = [[244, 512], [256, 524], [268, 512], [256, 500]];
export const WASTELAND = [[217, 511], [256, 472], [295, 511], [256, 550]];
export const BASE = [[254, 512], [256, 514], [258, 512], [256, 508]];
export const TURRETS = [[256, 502], [246, 512], [256, 522], [266, 512]];

export function parseMapView(search) {
  const params = new URLSearchParams(search);
  const server = params.get('server');
  const guild = params.get('guild');
  const scale = params.get('scale');
  const code = params.get('map');
  const revision = params.get('revision');
  const x = params.get('x');
  const y = params.get('y');
  for (const key of ['server', 'guild', 'scale', 'map', 'revision', 'x', 'y']) {
    if (params.getAll(key).length > 1) throw new Error(`URLの${key}は1つだけ指定してください。`);
  }
  if (server !== null && !/^(?:S)?[0-9]{1,10}$/.test(server)) throw new Error('URLのserverはサーバー番号で指定してください。');
  if (guild !== null && !/^[\x21-\x7e]{3}$/.test(guild)) throw new Error('URLのguildはASCII3文字で指定してください。');
  if (params.has('hash')) throw new Error('旧共有URLは使用できません。編集者から短い共有URLを受け取ってください。');
  if (code !== null && (!/^[A-Za-z0-9_-]{12}$/.test(code) || server !== null)) {
    throw new Error('URLのmapは12文字の共有コードで、serverとは別に指定してください。');
  }
  if (scale !== null && (!scale.trim() || !Number.isFinite(Number(scale)) || Number(scale) < MIN_SCALE || Number(scale) > MAX_SCALE)) {
    throw new Error('URLのscaleは0.3〜42（最大300%）で指定してください。');
  }
  if ((x === null) !== (y === null) || (x !== null && (
    !x.trim() || !y.trim() || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))
    || Number(x) < 0 || Number(x) > 511 || Number(y) < 0 || Number(y) > 1023))) {
    throw new Error('URLの中心座標はx（0〜511）とy（0〜1023）を組で指定してください。');
  }
  if (revision !== null && !/^[1-9][0-9]{0,8}$/.test(revision)) {
    throw new Error('URLのrevisionは1〜999999999の版番号で指定してください。');
  }
  return { server: server === null ? null : server.startsWith('S') ? server : `S${server}`,
    guild, scale: scale === null ? DEFAULT_SCALE : Number(scale), code,
    x: x === null ? null : Number(x), y: y === null ? null : Number(y),
    revision: revision === null ? null : Number(revision) };
}

export function initialMapView(state, code, scale, x = null, y = null) {
  const guild = state.guilds.find(g => g.name === code);
  const fortress = guild && state.facilities.find(o => o.type === 'fortress' && o.guildId === guild.id);
  return { x: x ?? fortress?.x ?? 256, y: y ?? fortress?.y ?? 512, scale };
}

export function renameGuild(state, guildId, name) {
  const guild = state.guilds.find(g => g.id === guildId);
  if (!guild) throw new Error('ギルドを選択してください。');
  const clean = text(name, 'ギルド名');
  if (state.guilds.some(g => g.id !== guildId && g.name === clean)) throw new Error('同じギルドが存在します。');
  guild.name = clean;
}

export function renameMember(state, guildId, memberId, name) {
  const members = membersFor(state, guildId);
  const member = members.find(m => m.id === memberId);
  if (!member) throw new Error('メンバーを選択してください。');
  const clean = text(name, 'メンバー名');
  if (members.some(m => m.id !== memberId && m.name === clean)) throw new Error('同じメンバーが存在します。');
  member.name = clean;
}

export function addMembers(state, guildId, names, createId, rank = null) {
  validateMembership(state, guildId, rank);
  const next = structuredClone(state);
  const lines = names.split(/\r?\n/).map(n => n.trim()).filter(Boolean);
  if (!lines.length) throw new Error('メンバー名を1行に1人ずつ入力してください。');
  let added = 0;
  let skipped = 0;
  const known = new Set(membersFor(next, guildId).map(member => member.name));
  for (const line of lines) {
    const name = text(line, 'メンバー名');
    if (known.has(name)) { skipped++; continue; }
    addMember(next, guildId, createId(), name, rank);
    known.add(name);
    added++;
  }
  state.players = next.players;
  return { added, skipped };
}

export function validCell(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) &&
    x >= 0 && x <= 511 && y >= 0 && y <= 1023 && x % 2 === y % 2;
}

export function mapOutline() {
  const edgeVertices = [
    [[0, -1], [1, 0], [1, -1]],
    [[1, 0], [0, 1], [1, 1]],
    [[0, 1], [-1, 0], [-1, 1]],
    [[-1, 0], [0, -1], [-1, -1]],
  ];
  const edges = [];
  for (let x = 0; x <= 511; x++) {
    for (let y = x % 2; y <= 1023; y += 2) {
    for (const [[ax, ay], [bx, by], [nx, ny]] of edgeVertices) {
      if (validCell(x + nx, y + ny)) continue;
      edges.push([[x + ax, y + ay], [x + bx, y + by]]);
    }
    }
  }
  const starts = new Map();
  edges.forEach((edge, index) => {
    const key = edge[0].join(',');
    const list = starts.get(key) ?? [];
    list.push(index);
    starts.set(key, list);
  });
  const used = new Set();
  const paths = [];
  for (let index = 0; index < edges.length; index++) {
    if (used.has(index)) continue;
    const path = [edges[index][0]];
    let current = index;
    while (!used.has(current)) {
      used.add(current);
      const [, end] = edges[current];
      path.push(end);
      if (end[0] === path[0][0] && end[1] === path[0][1]) break;
      current = (starts.get(end.join(',')) ?? []).find(next => !used.has(next));
      if (current === undefined) throw new Error('マップ外周の描画経路を作成できません。');
    }
    if (path.length > 3 && path.at(-1)[0] === path[0][0] && path.at(-1)[1] === path[0][1]) paths.push(path);
  }
  return paths;
}

export function snapCell(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('座標を数値で入力してください。');
  const cx = Math.max(0, Math.min(511, x));
  const cy = Math.max(0, Math.min(1023, y));
  let best;
  let distance = Infinity;
  for (const px of [Math.floor(cx) - 1, Math.floor(cx), Math.ceil(cx), Math.ceil(cx) + 1]) {
    for (const py of [Math.floor(cy) - 1, Math.floor(cy), Math.ceil(cy), Math.ceil(cy) + 1]) {
      const d = (px - cx) ** 2 + (py - cy) ** 2;
      if (validCell(px, py) && d < distance) {
        best = { x: px, y: py };
        distance = d;
      }
    }
  }
  return best;
}

export function footprint(object) {
  const { x, y } = object;
  const cells = object.size === 1 ? [{ x, y }] :
    [{ x, y }, { x: x - 1, y: y - 1 }, { x, y: y - 2 }, { x: x + 1, y: y - 1 }];
  return object.type === 'mountain' ? cells.filter(cell => terrain(cell.x, cell.y) !== 'wasteland') : cells;
}

export function inPolygon(x, y, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const [ax, ay] = vertices[j];
    const [bx, by] = vertices[i];
    const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
    if (Math.abs(cross) < 1e-9 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx) &&
        y >= Math.min(ay, by) && y <= Math.max(ay, by)) return true;
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

export function terrain(x, y) {
  if (inPolygon(x, y, LAB)) return 'lab';
  return inPolygon(x, y, WASTELAND) ? 'wasteland' : 'grass';
}

export function emptyMap() {
  return { version: 2, ownGuildId: null, guilds: [], players: [], facilities: [], mountains: [] };
}

export const cellKey = ({ x, y }) => `${x},${y}`;

export function objectAt(state, x, y) {
  return [...state.facilities, ...state.mountains].find(object =>
    footprint(object).some(cell => cell.x === x && cell.y === y));
}

export function territoryGuilds(state, x, y) {
  if (!validCell(x, y) || terrain(x, y) !== 'grass') return [];
  if (state.mountains.some(object => footprint(object).some(cell => cell.x === x && cell.y === y))) return [];
  return [...new Set(territorySources(state).active.filter(object => territoryContains(object, x, y))
    .map(object => object.guildId))];
}

export const isOutpost = object => /^outpost[1-5]$/.test(object.type);
export const territoryRadius = object => object.type === 'fortress' ? 12 : 10;
export const territoryContains = (object, x, y) =>
  Math.abs(object.x - x) + Math.abs(object.y - y) <= territoryRadius(object);

export function territoryBoundary(state, source) {
  if (!territorySources(state).active.some(object => object.id === source.id)) return [];
  const mountains = new Set(state.mountains.flatMap(footprint).map(cellKey));
  const cells = new Map();
  const radius = territoryRadius(source);
  for (let x = source.x - radius; x <= source.x + radius; x++) {
    for (let y = source.y - radius; y <= source.y + radius; y++) {
      if (validCell(x, y) && territoryContains(source, x, y)
        && terrain(x, y) === 'grass' && !mountains.has(`${x},${y}`)) {
        cells.set(`${x},${y}`, { x, y });
      }
    }
  }
  return cellBoundary([...cells.values()]);
}

export function cellBoundary(occupiedCells) {
  const cells = new Set(occupiedCells.map(cellKey));
  const edges = [
    [1, -1, 0, -1, 1, 0], [1, 1, 1, 0, 0, 1],
    [-1, 1, 0, 1, -1, 0], [-1, -1, -1, 0, 0, -1],
  ];
  return occupiedCells.flatMap(({ x, y }) => edges
    .filter(([dx, dy]) => !cells.has(`${x + dx},${y + dy}`))
    .map(([, , ax, ay, bx, by]) => [[x + ax, y + ay], [x + bx, y + by]]));
}

export function placedFacility(state, candidate) {
  if (candidate.type === 'mountain') return null;
  return state.facilities.find(object => object.type === candidate.type
    && (candidate.type === 'shelter' ? object.playerId === candidate.playerId
      : object.guildId === candidate.guildId)) ?? null;
}

export function territorySources(state) {
  const active = state.facilities.filter(object => object.type === 'fortress');
  let detached = state.facilities.filter(isOutpost);
  const mountains = new Set(state.mountains.flatMap(footprint).map(cellKey));
  let changed;
  do {
    changed = false;
    detached = detached.filter(object => {
      if (terrain(object.x, object.y) !== 'grass' || mountains.has(cellKey(object))
        || !active.some(source => source.guildId === object.guildId && territoryContains(source, object.x, object.y))) return true;
      active.push(object);
      changed = true;
      return false;
    });
  } while (changed);
  return { active, detached };
}

export function placementError(state, object, ignoreId = null, index = null) {
  if (object.type !== 'mountain' && !Object.hasOwn(TYPES, object.type)) return '施設の種類が不正です。';
  const size = object.type === 'mountain' ? 2 : TYPES[object.type].size;
  if (object.size !== size) return `この施設のサイズは ${size}×${size} です。`;
  const cells = footprint(object);
  if (footprint({ x: object.x, y: object.y, size: object.size }).some(cell => !validCell(cell.x, cell.y))) return '施設全体をマップ内に配置してください。';
  if (!cells.length) return '山岳の一部は緑地に配置してください。';
  if (object.type === 'shelter' && cells.some(cell => terrain(cell.x, cell.y) === 'lab')) {
    return '避難所は実験基地外囲には配置できません。';
  }
  if (object.type !== 'mountain' && object.type !== 'shelter'
    && cells.some(cell => terrain(cell.x, cell.y) !== 'grass')) {
    return 'ギルド施設は緑地にのみ配置できます。';
  }
  if (object.type === 'mountain' && cells.some(cell => terrain(cell.x, cell.y) !== 'grass')) {
    return cells.some(cell => terrain(cell.x, cell.y) === 'lab')
      ? '実験基地外囲には山岳を配置できません。' : '荒地には山岳を配置できません。';
  }
  const occupied = new Set(cells.map(cellKey));
  const overlaps = index ? cells.some(cell => index.occupied.has(cellKey(cell))) :
    [...state.facilities, ...state.mountains].some(other => other.id !== ignoreId &&
      footprint(other).some(cell => occupied.has(cellKey(cell))));
  if (overlaps) return '他の施設または山岳と重なっています。';
  if (object.type === 'mountain') return null;
  if (object.type === 'shelter') {
    if (!state.players.some(player => player.id === object.playerId)) return 'プレイヤーを選択してください。';
    const duplicate = index ? index.unique.has(JSON.stringify([null, object.type, object.playerId])) :
      state.facilities.some(other => other.id !== ignoreId && other.type === 'shelter' &&
        other.playerId === object.playerId);
    if (duplicate) return 'このメンバーの避難所は配置済みです。';
  } else if (!state.guilds.some(guild => guild.id === object.guildId)) {
    return 'ギルドを選択してください。';
  } else if (index ? index.unique.has(JSON.stringify([object.guildId, object.type, null])) :
    state.facilities.some(other => other.id !== ignoreId &&
      other.guildId === object.guildId && other.type === object.type)) {
    return 'この施設は各ギルドに一つだけ配置できます。';
  }
  return null;
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) {
    throw new Error(`${label}は1〜80文字で入力してください。`);
  }
  return value.trim();
}

export function addGuild(state, id, name) {
  const cleanName = text(name, 'ギルド名');
  if (state.guilds.length >= 100) throw new Error('ギルドは最大100件です。');
  if (state.guilds.some(g => g.name === cleanName || g.id === id)) throw new Error('同じギルドが存在します。');
  state.guilds.push({ id, name: cleanName });
  if (state.ownGuildId === null) state.ownGuildId = id;
}

export function addMember(state, guildId, id, name, rank = null) {
  validateMembership(state, guildId, rank);
  const cleanName = text(name, 'メンバー名');
  if (state.players.some(m => m.id === id || (m.guildId === guildId && m.name === cleanName))) {
    throw new Error('同じメンバーが存在します。');
  }
  state.players.push({ id, name: cleanName, guildId, ...(rank === null ? {} : { rank }) });
}

export function placeObject(state, object, ignoreId = null) {
  const target = object.type === 'mountain' ? state.mountains : state.facilities;
  const limit = object.type === 'mountain' ? 10000 : 11100;
  if (ignoreId === null && target.length >= limit) throw new Error('配置件数が上限を超えています。');
  const error = placementError(state, object, ignoreId);
  if (error) throw new Error(error);
  if (ignoreId !== null) {
    const index = target.findIndex(o => o.id === ignoreId);
    if (index < 0) throw new Error('移動対象が見つかりません。');
    target[index] = { ...object };
  } else {
    if ([...state.facilities, ...state.mountains].some(o => o.id === object.id)) throw new Error('IDが重複しています。');
    target.push({ ...object });
  }
}

export function importMap(raw) {
  if (!raw || ![1, 2].includes(raw.version) || !Array.isArray(raw.guilds) ||
      !Array.isArray(raw.facilities) || !Array.isArray(raw.mountains)) throw new Error('対応するマップJSONではありません。');
  if (raw.guilds.length > 100 || raw.facilities.length > 11100 || raw.mountains.length > 10000) {
    throw new Error('データの件数が上限を超えています。');
  }
  const result = emptyMap();
  const ids = new Set();
  const id = value => {
    const clean = text(value, 'ID');
    if (ids.has(clean)) throw new Error('IDが重複しています。');
    ids.add(clean);
    return clean;
  };
  for (const guild of raw.guilds) {
    addGuild(result, id(guild.id), guild.name);
  }
  if (raw.version === 1) {
    for (const guild of raw.guilds) {
      if (!Array.isArray(guild.members)) throw new Error('メンバー一覧が不正です。');
      for (const member of guild.members) addMember(result, guild.id, id(member.id), member.name, member.rank ?? null);
    }
  } else {
    if (!Array.isArray(raw.players)) throw new Error('プレイヤー一覧が不正です。');
    for (const player of raw.players) {
      addMember(result, player.guildId, id(player.id), player.name, player.rank ?? null);
    }
  }
  if (raw.ownGuildId !== null && !result.guilds.some(g => g.id === raw.ownGuildId)) throw new Error('自ギルドが不正です。');
  result.ownGuildId = raw.ownGuildId;
  const index = { occupied: new Set(), unique: new Set() };
  for (const [list, mountain] of [[raw.mountains, true], [raw.facilities, false]]) {
    for (const source of list) {
      if (!source || (mountain ? source.type !== 'mountain' : !Object.hasOwn(TYPES, source.type))) {
        throw new Error('施設の種類が不正です。');
      }
      const object = { id: id(source.id), type: source.type, size: source.size, x: source.x, y: source.y };
      if (source.type === 'shelter') {
        object.playerId = raw.version === 1 ? source.memberId : source.playerId;
        if (raw.version === 1 && objectGuildId(result, object) !== source.guildId) {
          throw new Error('所属メンバーが不正です。');
        }
      } else if (!mountain) object.guildId = source.guildId;
      const error = placementError(result, object, null, index);
      if (error) throw new Error(error);
      for (const cell of footprint(object)) index.occupied.add(cellKey(cell));
      if (!mountain) index.unique.add(JSON.stringify([
        object.type === 'shelter' ? null : object.guildId, object.type, object.playerId ?? null]));
      (mountain ? result.mountains : result.facilities).push(object);
    }
  }
  return result;
}
