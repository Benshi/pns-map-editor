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
function validateRank(rank) {
  if (!RANKS.includes(rank)) throw new Error('ランクは R5〜R1 または未設定を選択してください。');
}
export function setMemberRank(state, guildId, memberId, rank) {
  setMemberRanks(state, guildId, [memberId], rank);
}
export function setMemberRanks(state, guildId, memberIds, rank) {
  validateRank(rank);
  const guild = state.guilds.find(g => g.id === guildId);
  if (!guild) throw new Error('ギルドを選択してください。');
  const ids = new Set(memberIds);
  if (!ids.size) throw new Error('メンバーを選択してください。');
  const members = guild.members.filter(member => ids.has(member.id));
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
  for (const key of ['server', 'guild', 'scale', 'map', 'revision']) {
    if (params.getAll(key).length > 1) throw new Error(`URLの${key}は1つだけ指定してください。`);
  }
  if (server !== null && !/^(?:S)?[0-9]{1,10}$/.test(server)) throw new Error('URLのserverはサーバー番号で指定してください。');
  if (guild !== null && !/^[\x21-\x7e]{3}$/.test(guild)) throw new Error('URLのguildはASCII3文字で指定してください。');
  if (params.has('hash')) throw new Error('旧共有URLは使用できません。編集者から短い共有URLを受け取ってください。');
  if (code !== null && (!/^[A-Za-z0-9_-]{12}$/.test(code) || server !== null)) {
    throw new Error('URLのmapは12文字の共有コードで、serverとは別に指定してください。');
  }
  if (scale !== null && (!scale.trim() || !Number.isFinite(Number(scale)) || Number(scale) < .3 || Number(scale) > 40)) {
    throw new Error('URLのscaleは0.3〜40で指定してください。');
  }
  if (revision !== null && !/^[1-9][0-9]{0,8}$/.test(revision)) {
    throw new Error('URLのrevisionは1〜999999999の版番号で指定してください。');
  }
  return { server: server === null ? null : server.startsWith('S') ? server : `S${server}`,
    guild, scale: scale === null ? 14 : Number(scale), code,
    revision: revision === null ? null : Number(revision) };
}

export function initialMapView(state, code, scale) {
  const guild = state.guilds.find(g => g.name === code);
  const fortress = guild && state.facilities.find(o => o.type === 'fortress' && o.guildId === guild.id);
  return { x: fortress?.x ?? 256, y: fortress?.y ?? 512, scale };
}

export function renameGuild(state, guildId, name) {
  const guild = state.guilds.find(g => g.id === guildId);
  if (!guild) throw new Error('ギルドを選択してください。');
  const clean = text(name, 'ギルド名');
  if (state.guilds.some(g => g.id !== guildId && g.name === clean)) throw new Error('同じギルドが存在します。');
  guild.name = clean;
}

export function renameMember(state, guildId, memberId, name) {
  const guild = state.guilds.find(g => g.id === guildId);
  const member = guild?.members.find(m => m.id === memberId);
  if (!member) throw new Error('メンバーを選択してください。');
  const clean = text(name, 'メンバー名');
  if (guild.members.some(m => m.id !== memberId && m.name === clean)) throw new Error('同じメンバーが存在します。');
  member.name = clean;
}

export function addMembers(state, guildId, names, createId, rank = null) {
  validateRank(rank);
  const next = structuredClone(state);
  const guild = next.guilds.find(g => g.id === guildId);
  if (!guild) throw new Error('ギルドを選択してください。');
  const lines = names.split(/\r?\n/).map(n => n.trim()).filter(Boolean);
  if (!lines.length) throw new Error('メンバー名を1行に1人ずつ入力してください。');
  let added = 0;
  let skipped = 0;
  const known = new Set(guild.members.map(member => member.name));
  for (const line of lines) {
    const name = text(line, 'メンバー名');
    if (known.has(name)) { skipped++; continue; }
    addMember(next, guildId, createId(), name, rank);
    known.add(name);
    added++;
  }
  state.guilds = next.guilds;
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
  return object.size === 1 ? [{ x, y }] :
    [{ x, y }, { x: x - 1, y: y - 1 }, { x, y: y - 2 }, { x: x + 1, y: y - 1 }];
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
  return { version: 1, ownGuildId: null, guilds: [], facilities: [], mountains: [] };
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
  const edges = [
    [1, -1, 0, -1, 1, 0], [1, 1, 1, 0, 0, 1],
    [-1, 1, 0, 1, -1, 0], [-1, -1, -1, 0, 0, -1],
  ];
  return [...cells.values()].flatMap(({ x, y }) => edges
    .filter(([dx, dy]) => !cells.has(`${x + dx},${y + dy}`))
    .map(([, , ax, ay, bx, by]) => [[x + ax, y + ay], [x + bx, y + by]]));
}

export function placedFacility(state, candidate) {
  if (candidate.type === 'mountain') return null;
  return state.facilities.find(object => object.type === candidate.type
    && object.guildId === candidate.guildId
    && (candidate.type !== 'shelter' || object.memberId === candidate.memberId)) ?? null;
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
  if (cells.some(cell => !validCell(cell.x, cell.y))) return '施設全体をマップ内に配置してください。';
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
  const guild = state.guilds.find(g => g.id === object.guildId);
  if (!guild) return 'ギルドを選択してください。';
  if (object.type === 'shelter') {
    if (!guild.members.some(member => member.id === object.memberId)) return '所属メンバーを選択してください。';
    const duplicate = index ? index.unique.has(JSON.stringify([object.guildId, object.type, object.memberId])) :
      state.facilities.some(other => other.id !== ignoreId && other.type === 'shelter' &&
        other.guildId === object.guildId && other.memberId === object.memberId);
    if (duplicate) return 'このメンバーの避難所は配置済みです。';
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
  state.guilds.push({ id, name: cleanName, members: [] });
  if (state.ownGuildId === null) state.ownGuildId = id;
}

export function addMember(state, guildId, id, name, rank = null) {
  validateRank(rank);
  const guild = state.guilds.find(g => g.id === guildId);
  if (!guild) throw new Error('ギルドを選択してください。');
  const cleanName = text(name, 'メンバー名');
  if (guild.members.some(m => m.name === cleanName || m.id === id)) throw new Error('同じメンバーが存在します。');
  guild.members.push({ id, name: cleanName, ...(rank === null ? {} : { rank }) });
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
  if (!raw || raw.version !== 1 || !Array.isArray(raw.guilds) ||
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
    if (!Array.isArray(guild.members)) throw new Error('メンバー一覧が不正です。');
    for (const member of guild.members) addMember(result, guild.id, id(member.id), member.name, member.rank ?? null);
  }
  if (raw.ownGuildId !== null && !result.guilds.some(g => g.id === raw.ownGuildId)) throw new Error('自ギルドが不正です。');
  if (result.guilds.length && raw.ownGuildId === null) throw new Error('自ギルドを指定してください。');
  result.ownGuildId = raw.ownGuildId;
  const index = { occupied: new Set(), unique: new Set() };
  for (const [list, mountain] of [[raw.mountains, true], [raw.facilities, false]]) {
    for (const source of list) {
      if (!source || (mountain ? source.type !== 'mountain' : !Object.hasOwn(TYPES, source.type))) {
        throw new Error('施設の種類が不正です。');
      }
      const object = { id: id(source.id), type: source.type, size: source.size, x: source.x, y: source.y };
      if (!mountain) object.guildId = source.guildId;
      if (source.type === 'shelter') object.memberId = source.memberId;
      const error = placementError(result, object, null, index);
      if (error) throw new Error(error);
      for (const cell of footprint(object)) index.occupied.add(cellKey(cell));
      if (!mountain) index.unique.add(JSON.stringify([object.guildId, object.type, object.memberId ?? null]));
      (mountain ? result.mountains : result.facilities).push(object);
    }
  }
  return result;
}
