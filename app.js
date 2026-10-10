import { TYPES, LAB, WASTELAND, emptyMap, addGuild, addMember, snapCell, validCell,
  footprint, cellKey, terrain, objectAt, placeObject, placementError, importMap } from './model.js';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'pns-map-editor-v1';
const canvas = $('map');
const context = canvas.getContext('2d');
const colors = { grass: '#648448', own: '#b0df57', other: '#93493b', shared: '#ab9250',
  wasteland: '#41464b', lab: '#c3c7c9', mountain: '#635d54' };
let state = emptyMap();
let selectedId = '';
let hover = null;
let drag = null;
let width = 0;
let height = 0;
let frame = null;
const view = { x: 214, y: 452, scale: 14 };

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    state = importMap(JSON.parse(saved));
    status('保存したマップを復元しました。');
  }
} catch {
  status('保存データを復元できません。元の保存データは上書きせず、JSON バックアップの読み込みをお試しください。', true);
}

const guild = () => state.guilds.find(g => g.id === $('guild').value);
const objects = () => [...state.facilities, ...state.mountains];
const selected = () => objects().find(o => o.id === selectedId);
const newId = () => crypto.randomUUID();

function update(mutator, message) {
  try {
    const next = structuredClone(state);
    mutator(next);
    state = next;
    refresh();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      status(`${message} 自動保存しました。`);
    } catch {
      status(`${message} ブラウザーに保存できません。JSON をダウンロードしてバックアップしてください。`, true);
    }
  } catch (error) {
    status(error.message, true);
  }
}

function option(value, label) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

function objectName(object) {
  if (object.type === 'mountain') return '山岳';
  const owner = state.guilds.find(g => g.id === object.guildId);
  const name = object.type === 'shelter' ?
    owner?.members.find(m => m.id === object.memberId)?.name : TYPES[object.type].name;
  return `${owner?.name ?? ''} / ${name}`;
}

function refresh() {
  const guildId = $('guild').value;
  const memberId = $('member').value;
  $('guild').replaceChildren(...state.guilds.map(g => option(g.id, g.name)));
  if (state.guilds.some(g => g.id === guildId)) $('guild').value = guildId;
  const current = guild();
  $('member').replaceChildren(...(current?.members ?? []).map(m => {
    const placed = state.facilities.some(o => o.type === 'shelter' && o.memberId === m.id && o.guildId === current.id);
    return option(m.id, `${m.name}${placed ? '（配置済み）' : ''}`);
  }));
  if (current?.members.some(m => m.id === memberId)) $('member').value = memberId;
  $('member-count').textContent = `${current?.members.length ?? 0} / 100`;
  $('own-name').textContent = `自ギルド: ${state.guilds.find(g => g.id === state.ownGuildId)?.name ?? '未設定'}`;
  $('own-guild').disabled = !current;
  $('delete-guild').disabled = !current;
  $('delete-member').disabled = !$('member').value;
  $('object').replaceChildren(option('', '未選択'), ...objects().map(o =>
    option(o.id, `${objectName(o)} (${o.x}, ${o.y})`)));
  if (!selected()) selectedId = '';
  $('object').value = selectedId;
  const object = selected();
  $('selection').textContent = object ?
    `${objectName(object)} — 南セル X:${object.x} Y:${object.y} / 2×2` :
    'マップ上の施設をクリックして選択します。';
  $('move').disabled = !object;
  $('delete').disabled = !object;
  requestDraw();
}

function coordinates() {
  const cell = snapCell($('x').valueAsNumber, $('y').valueAsNumber);
  $('x').value = cell.x;
  $('y').value = cell.y;
  return cell;
}

function draft(cell, id = 'preview') {
  const type = $('type').value;
  const object = { id, type, size: 2, ...cell };
  if (type !== 'mountain') object.guildId = guild()?.id;
  if (type === 'shelter') object.memberId = $('member').value;
  return object;
}

function place(cell) {
  const object = draft(cell, newId());
  const error = placementError(state, object);
  if (error) return status(error, true);
  let name;
  if (object.type === 'fortress') {
    name = window.prompt('配置するギルド要塞のギルド名を入力してください。', guild().name);
    if (name === null) return;
    name = name.trim();
    if (!name || name.length > 80) return status('ギルド名は1〜80文字で入力してください。', true);
    if (state.guilds.some(g => g.id !== object.guildId && g.name === name)) {
      return status('同じギルド名が存在します。', true);
    }
  }
  update(next => {
    if (name) next.guilds.find(g => g.id === object.guildId).name = name;
    placeObject(next, object);
    selectedId = object.id;
  }, `X:${cell.x} Y:${cell.y} に配置しました。`);
}

$('guild-form').addEventListener('submit', event => {
  event.preventDefault();
  const id = newId();
  update(next => addGuild(next, id, $('guild-name').value), 'ギルドを追加しました。');
  if (state.guilds.some(g => g.id === id)) {
    $('guild').value = id;
    $('guild-name').value = '';
    refresh();
  }
});
$('member-form').addEventListener('submit', event => {
  event.preventDefault();
  const id = newId();
  update(next => addMember(next, $('guild').value, id, $('member-name').value), 'メンバーを追加しました。');
  if (guild()?.members.some(m => m.id === id)) {
    $('member').value = id;
    $('member-name').value = '';
  }
});
$('guild').addEventListener('change', refresh);
$('member').addEventListener('change', requestDraw);
$('type').addEventListener('change', requestDraw);
$('mode').addEventListener('change', requestDraw);
$('own-guild').addEventListener('click', () => {
  if (guild()) update(next => { next.ownGuildId = guild().id; }, '自ギルドを変更しました。');
});
$('delete-guild').addEventListener('click', () => {
  const current = guild();
  if (!current || !window.confirm(`「${current.name}」と所属メンバー・全施設を削除しますか？`)) return;
  update(next => {
    next.guilds = next.guilds.filter(g => g.id !== current.id);
    next.facilities = next.facilities.filter(o => o.guildId !== current.id);
    if (next.ownGuildId === current.id) next.ownGuildId = next.guilds[0]?.id ?? null;
  }, 'ギルドを削除しました。');
});
$('delete-member').addEventListener('click', () => {
  const memberId = $('member').value;
  if (!memberId || !window.confirm('選択メンバーとその避難所を削除しますか？')) return;
  update(next => {
    next.guilds.find(g => g.id === guild().id).members = guild().members.filter(m => m.id !== memberId);
    next.facilities = next.facilities.filter(o => o.memberId !== memberId || o.guildId !== guild().id);
  }, 'メンバーを削除しました。');
});
$('position-form').addEventListener('submit', event => {
  event.preventDefault();
  try { place(coordinates()); } catch (error) { status(error.message, true); }
});
$('go').addEventListener('click', () => {
  try {
    Object.assign(view, coordinates());
    requestDraw();
  } catch (error) { status(error.message, true); }
});
$('move').addEventListener('click', () => {
  const object = selected();
  if (!object) return;
  try {
    const cell = coordinates();
    update(next => placeObject(next, { ...object, ...cell }, object.id), `施設を X:${cell.x} Y:${cell.y} に移動しました。`);
  } catch (error) { status(error.message, true); }
});
$('delete').addEventListener('click', () => {
  if (!selected()) return;
  update(next => {
    next.facilities = next.facilities.filter(o => o.id !== selectedId);
    next.mountains = next.mountains.filter(o => o.id !== selectedId);
  }, '施設を削除しました。');
});

function selectObject(object, center = false) {
  selectedId = object?.id ?? '';
  if (object) {
    $('x').value = object.x;
    $('y').value = object.y;
    if (object.guildId) $('guild').value = object.guildId;
    if (center) Object.assign(view, { x: object.x, y: object.y });
  }
  refresh();
}
$('object').addEventListener('change', () => {
  selectObject(objects().find(o => o.id === $('object').value), true);
});
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'pns-guild-map.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('JSON をダウンロードしました。他の人は「JSON を読み込み」で同じマップを編集できます。');
});
$('import').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('JSON は5MB以下にしてください。');
    const next = importMap(JSON.parse(await file.text()));
    if (!window.confirm('現在のマップを読み込んだデータに置き換えますか？必要なら先に JSON を保存してください。')) return;
    update(target => Object.assign(target, next), 'マップを読み込みました。');
    home();
  } catch (error) {
    status(`読み込み失敗: ${error.message}`, true);
  } finally {
    event.target.value = '';
  }
});

function screen(x, y) {
  return { x: width / 2 + (x - view.x) * view.scale, y: height / 2 + (y - view.y) * view.scale };
}
function pointer(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
function world(point) {
  return { x: view.x + (point.x - width / 2) / view.scale,
    y: view.y + (point.y - height / 2) / view.scale };
}
function diamond(x, y, fill, stroke = null, lineWidth = 1) {
  const p = screen(x, y);
  const s = view.scale;
  context.beginPath();
  context.moveTo(p.x, p.y - s);
  context.lineTo(p.x + s, p.y);
  context.lineTo(p.x, p.y + s);
  context.lineTo(p.x - s, p.y);
  context.closePath();
  if (fill) { context.fillStyle = fill; context.fill(); }
  if (stroke) { context.strokeStyle = stroke; context.lineWidth = lineWidth; context.stroke(); }
}
function polygon(vertices, color) {
  context.beginPath();
  vertices.forEach(([x, y], i) => {
    const p = screen(x, y);
    if (i === 0) context.moveTo(p.x, p.y);
    else context.lineTo(p.x, p.y);
  });
  context.closePath();
  context.fillStyle = color;
  context.fill();
}
function requestDraw() {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => { frame = null; draw(); });
}
function draw() {
  context.clearRect(0, 0, width, height);
  const start = screen(-1, -1);
  context.fillStyle = colors.grass;
  context.fillRect(start.x, start.y, 513 * view.scale, 1025 * view.scale);
  polygon(WASTELAND, colors.wasteland);
  polygon(LAB, colors.lab);
  const minX = Math.max(0, Math.floor(view.x - width / (2 * view.scale) - 2));
  const maxX = Math.min(511, Math.ceil(view.x + width / (2 * view.scale) + 2));
  const minY = Math.max(0, Math.floor(view.y - height / (2 * view.scale) - 2));
  const maxY = Math.min(1023, Math.ceil(view.y + height / (2 * view.scale) + 2));
  const visible = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
  if (view.scale >= 5) {
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY + ((minY % 2 === x % 2) ? 0 : 1); y <= maxY; y += 2) {
        diamond(x, y, colors[terrain(x, y)], '#00000025', .5);
      }
    }
  }
  const mountainCells = new Set(state.mountains.flatMap(footprint).map(cellKey));
  const territories = new Map();
  for (const fortress of state.facilities.filter(o => o.type === 'fortress')) {
    for (let x = Math.max(minX, fortress.x - 12); x <= Math.min(maxX, fortress.x + 12); x++) {
      for (let y = Math.max(minY, fortress.y - 12); y <= Math.min(maxY, fortress.y + 12); y++) {
        if (!validCell(x, y) || terrain(x, y) !== 'grass' || mountainCells.has(`${x},${y}`)) continue;
        const key = `${x},${y}`;
        const entry = territories.get(key) ?? { x, y, count: 0, own: false };
        entry.count++;
        entry.own ||= fortress.guildId === state.ownGuildId;
        territories.set(key, entry);
      }
    }
  }
  for (const cell of territories.values()) {
    diamond(cell.x, cell.y, colors[cell.count > 1 ? 'shared' : cell.own ? 'own' : 'other'],
      view.scale >= 5 ? '#00000025' : null, .5);
  }
  const labels = [];
  for (const object of objects()) {
    const cells = footprint(object);
    if (!cells.some(c => visible(c.x, c.y))) continue;
    const fill = object.type === 'mountain' ? colors.mountain :
      object.guildId === state.ownGuildId ? '#306142' : '#693a36';
    for (const cell of cells) diamond(cell.x, cell.y, fill, '#efebc2', .8);
    if (object.id === selectedId) {
      for (const cell of cells) diamond(cell.x, cell.y, null, '#ffffff', 2.5);
    }
    if (view.scale >= 5) labels.push(object);
  }
  if (hover && $('mode').value === 'place') {
    const preview = draft(hover);
    const fill = placementError(state, preview) ? '#ff5e5e88' : '#ffffff66';
    for (const cell of footprint(preview)) diamond(cell.x, cell.y, fill, '#fff');
  }
  for (const object of labels) {
    const p = screen(object.x, object.y - 1);
    const owner = state.guilds.find(g => g.id === object.guildId);
    const text = object.type === 'mountain' ? '山岳' :
      object.type === 'shelter' ? owner.members.find(m => m.id === object.memberId).name :
      object.type === 'fortress' ? owner.name : TYPES[object.type].short;
    context.font = `${Math.max(10, Math.min(15, view.scale))}px system-ui`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineWidth = 3;
    context.strokeStyle = '#15211a';
    context.strokeText(text, p.x, p.y);
    context.fillStyle = '#fff';
    context.fillText(text, p.x, p.y);
  }
  if (view.scale >= 10) {
    context.font = '10px system-ui';
    context.textAlign = 'left';
    context.textBaseline = 'top';
    for (let x = Math.ceil(minX / 10) * 10; x <= maxX; x += 10) {
      for (let y = Math.ceil(minY / 10) * 10; y <= maxY; y += 10) {
        const p = screen(x, y);
        context.fillStyle = '#192519';
        context.fillText(`${x},${y}`, p.x + 2, p.y + 2);
      }
    }
  }
}

function zoom(factor, point = { x: width / 2, y: height / 2 }) {
  const before = world(point);
  view.scale = Math.max(.3, Math.min(40, view.scale * factor));
  const after = world(point);
  view.x += before.x - after.x;
  view.y += before.y - after.y;
  requestDraw();
}
function home() {
  const fortress = state.facilities.find(o => o.type === 'fortress' && o.guildId === state.ownGuildId);
  Object.assign(view, { x: fortress?.x ?? 214, y: fortress?.y ?? 452, scale: 14 });
  requestDraw();
}
$('zoom-in').addEventListener('click', () => zoom(1.25));
$('zoom-out').addEventListener('click', () => zoom(.8));
$('home').addEventListener('click', home);
$('fit').addEventListener('click', () => {
  Object.assign(view, { x: 255.5, y: 511.5, scale: Math.max(.3, Math.min(width / 530, height / 1040)) });
  requestDraw();
});
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  zoom(Math.exp(-event.deltaY * .001), pointer(event));
}, { passive: false });
canvas.addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0) return;
  const point = pointer(event);
  drag = { id: event.pointerId, start: point, point, moved: false };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  const point = pointer(event);
  if (drag && drag.id === event.pointerId) {
    if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 4) drag.moved = true;
    if (drag.moved) {
      view.x -= (point.x - drag.point.x) / view.scale;
      view.y -= (point.y - drag.point.y) / view.scale;
    }
    drag.point = point;
  }
  const raw = world(point);
  hover = raw.x >= 0 && raw.x <= 511 && raw.y >= 0 && raw.y <= 1023 ? snapCell(raw.x, raw.y) : null;
  $('cursor').textContent = hover ? `X:${hover.x} Y:${hover.y}` : 'マップ外';
  requestDraw();
});
canvas.addEventListener('pointerup', event => {
  if (!drag || drag.id !== event.pointerId) return;
  const moved = drag.moved;
  drag = null;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (moved) return;
  const raw = world(pointer(event));
  if (raw.x < 0 || raw.x > 511 || raw.y < 0 || raw.y > 1023) return;
  const cell = snapCell(raw.x, raw.y);
  $('x').value = cell.x;
  $('y').value = cell.y;
  if ($('mode').value === 'place') place(cell);
  else selectObject(objectAt(state, cell.x, cell.y));
});
canvas.addEventListener('pointercancel', () => { drag = null; });
canvas.addEventListener('pointerleave', () => { hover = null; requestDraw(); });
canvas.addEventListener('keydown', event => {
  const deltas = { ArrowLeft: [-2, 0], ArrowRight: [2, 0], ArrowUp: [0, -2], ArrowDown: [0, 2] };
  if (!Object.hasOwn(deltas, event.key)) return;
  event.preventDefault();
  view.x += deltas[event.key][0];
  view.y += deltas[event.key][1];
  requestDraw();
});
new ResizeObserver(() => {
  const rect = $('canvas-container').getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  requestDraw();
}).observe($('canvas-container'));

refresh();
home();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(async registration => {
    await navigator.serviceWorker.ready;
    $('offline').textContent = 'オフライン利用の準備ができました。この URL を再度開いて利用できます。';
    registration.addEventListener('updatefound', () => {
      $('offline').textContent = 'アプリを更新中です。更新後はページを再読み込みしてください。';
    });
  }).catch(() => {
    $('offline').textContent = 'オフライン機能は利用できません。HTTPS または localhost で開いてください。';
  });
} else {
  $('offline').textContent = 'このブラウザーではオフライン機能を利用できません。';
}
