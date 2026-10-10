export const TYPES = Object.freeze({
  fortress: { name: 'ギルド要塞', short: '要塞', size: 2 },
  resource: { name: 'ギルド資源', short: '資源', size: 2 },
  trap: { name: 'スピーカートラップ', short: '罠', size: 2 },
  warehouse: { name: 'ギルド倉庫', short: '倉庫', size: 2 },
  hospital: { name: 'ギルド病院', short: '病院', size: 2 },
  shelter: { name: '避難所', short: '避難所', size: 2 },
});

export const LAB = [[244, 512], [256, 524], [268, 512], [256, 500]];
export const WASTELAND = [[218, 511], [256, 472], [292, 512], [256, 550]];

export function validCell(x, y) {
  return Number.isInteger(x) && Number.isInteger(y) &&
    x >= 0 && x <= 511 && y >= 0 && y <= 1023 && x % 2 === y % 2;
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
  return state.facilities.filter(object => object.type === 'fortress' &&
    Math.abs(object.x - x) <= 12 && Math.abs(object.y - y) <= 12).map(object => object.guildId);
}

export function placementError(state, object, ignoreId = null) {
  if (object.type !== 'mountain' && !Object.hasOwn(TYPES, object.type)) return '施設の種類が不正です。';
  if (object.size !== 2) return 'この施設のサイズは 2×2 です。';
  const cells = footprint(object);
  if (cells.some(cell => !validCell(cell.x, cell.y))) return '施設全体をマップ内に配置してください。';
  if (object.type !== 'mountain' && cells.some(cell => terrain(cell.x, cell.y) !== 'grass')) {
    return 'ギルド施設は緑地にのみ配置できます。';
  }
  if (object.type === 'mountain' && cells.some(cell => terrain(cell.x, cell.y) === 'lab')) {
    return '実験基地外囲には山岳を配置できません。';
  }
  const occupied = new Set(cells.map(cellKey));
  if ([...state.facilities, ...state.mountains].some(other => other.id !== ignoreId &&
      footprint(other).some(cell => occupied.has(cellKey(cell))))) return '他の施設または山岳と重なっています。';
  if (object.type === 'mountain') return null;
  const guild = state.guilds.find(g => g.id === object.guildId);
  if (!guild) return 'ギルドを選択してください。';
  if (object.type === 'shelter') {
    if (!guild.members.some(member => member.id === object.memberId)) return '所属メンバーを選択してください。';
    if (state.facilities.some(other => other.id !== ignoreId && other.type === 'shelter' &&
        other.guildId === object.guildId && other.memberId === object.memberId)) return 'このメンバーの避難所は配置済みです。';
  } else if (state.facilities.some(other => other.id !== ignoreId &&
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

export function addMember(state, guildId, id, name) {
  const guild = state.guilds.find(g => g.id === guildId);
  if (!guild) throw new Error('ギルドを選択してください。');
  const cleanName = text(name, 'メンバー名');
  if (guild.members.length >= 100) throw new Error('メンバーは最大100名です。');
  if (guild.members.some(m => m.name === cleanName || m.id === id)) throw new Error('同じメンバーが存在します。');
  guild.members.push({ id, name: cleanName });
}

export function placeObject(state, object, ignoreId = null) {
  const error = placementError(state, object, ignoreId);
  if (error) throw new Error(error);
  const target = object.type === 'mountain' ? state.mountains : state.facilities;
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
  if (raw.guilds.length > 100 || raw.facilities.length > 10500 || raw.mountains.length > 10000) {
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
    for (const member of guild.members) addMember(result, guild.id, id(member.id), member.name);
  }
  if (raw.ownGuildId !== null && !result.guilds.some(g => g.id === raw.ownGuildId)) throw new Error('自ギルドが不正です。');
  if (result.guilds.length && raw.ownGuildId === null) throw new Error('自ギルドを指定してください。');
  result.ownGuildId = raw.ownGuildId;
  for (const [list, mountain] of [[raw.mountains, true], [raw.facilities, false]]) {
    for (const source of list) {
      if (!source || (mountain ? source.type !== 'mountain' : !Object.hasOwn(TYPES, source.type))) {
        throw new Error('施設の種類が不正です。');
      }
      const object = { id: id(source.id), type: source.type, size: source.size, x: source.x, y: source.y };
      if (!mountain) object.guildId = source.guildId;
      if (source.type === 'shelter') object.memberId = source.memberId;
      placeObject(result, object);
    }
  }
  return result;
}
