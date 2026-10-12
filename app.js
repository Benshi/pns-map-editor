import { TYPES, RANKS, shelterColor, rankName, orderedMembers, setMemberRanks, territorySources, territoryRadius, territoryContains, territoryGuilds,
  LAB, WASTELAND, TURRETS, emptyMap, addGuild, addMembers, renameGuild, renameMember, snapCell, validCell,
  footprint, cellKey, terrain, objectAt, placeObject, placementError, importMap, parseMapView, initialMapView,
  territoryBoundary, placedFacility, mapOutline } from './model.js';
import { EditHistory, sharedMap, apiRequest } from './persistence.js';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'pns-map-editor-v1';
const GUILD_ORDER_KEY = 'pns-map-guild-order-v1';
const canvas = $('map');
const context = canvas.getContext('2d');
const colors = { grass: '#648448', own: '#b0df57', other: '#93493b', shared: '#ab9250',
  wasteland: '#41464b', lab: '#c3c7c9', mountain: '#635d54' };
const mapOutlinePaths = mapOutline();
let outlineBitmap = null;
let outlineBitmapPromise = null;
let mapInteractionTimer = null;
let mapInteracting = false;
let state = emptyMap();
const localMode = new URLSearchParams(location.search).get('storage') === 'local';
let serverId = localMode ? 'S1063' : '';
let serverCode = null;
let revision = 0;
let latestRevision = 0;
let revisionInfo = null;
let viewingPast = false;
let loaded = localMode;
let busy = false;
let session = { user: null, csrf: '' };
let preferences = {};
let guildOrder = 'registration';
let category = 'mountain';
const history = new EditHistory(state);
let selectedId = '';
let hover = null;
let placementPreviewActive = true;
let relocationPreviewActive = false;
const rankMemberIds = new Set();
const memberOpenRanks = new Set();
let editingMemberId = '';
let editingMemberGuildId = '';
let deletingMemberIds = [];
let rankSelectionGuildId = '';
let objectResultLimit = 100;
let drag = null;
const touchPoints = new Map();
let pinch = null;
let touchGesture = false;
let longPressTimer = null;
let longPressPointerId = null;
let contextMember = null;
let width = 0;
let height = 0;
let frame = null;
const view = { x: 256, y: 512, scale: 14 };

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
  for (const dialog of document.querySelectorAll('dialog[open]')) {
    dialog.querySelector('.dialog-status').textContent = message;
  }
}

function setGuildPlacementMode() {
  const current = guild();
  const fortress = state.facilities.find(object => object.type === 'fortress' && object.guildId === current?.id);
  setCategory(!current ? 'mountain' : fortress ? 'shelter' : 'facilities');
  $('mode').value = 'place';
  hover = null;
  requestDraw();
}

try {
  const saved = localMode ? localStorage.getItem(STORAGE_KEY) : null;
  if (saved) {
    state = importMap(JSON.parse(saved));
    status('保存したマップを復元しました。');
  }
} catch {
  status('保存データを復元できません。元の保存データは上書きせず、JSON バックアップの読み込みをお試しください。', true);
}
history.reset(state);

const guild = () => state.guilds.find(g => g.id === $('guild').value);
const objects = () => [...state.facilities, ...state.mountains];
const selected = () => objects().find(o => o.id === selectedId);
const newId = () => crypto.randomUUID();
const editable = () => loaded && !busy && !viewingPast && (localMode || session.user?.can_edit);

function preferenceKey() { return `${session.user?.id ?? 'visitor'}:${serverId}`; }
function applyPreference() {
  const selectedGuild = preferences[preferenceKey()]?.guildId;
  $('guild').value = state.guilds.some(g => g.id === selectedGuild) ? selectedGuild : '';
  state.ownGuildId = $('guild').value || null;
  setGuildPlacementMode();
}
function rememberGuild() {
  updateMapUrl();
  preferences[preferenceKey()] = { guildId: $('guild').value };
  try {
    localStorage.setItem('pns-map-preferences-v1', JSON.stringify(preferences));
  } catch {
    status('ギルド選択をこの端末に記憶できません。マップの共有保存には影響しません。', true);
  }
}
function updateAccountLinks() {
  for (const link of document.querySelectorAll('[data-account-link]')) {
    link.href = `./api.php?${new URLSearchParams({ return: location.search.slice(1) })}`;
  }
}
function refreshPersistence() {
  updateAccountLinks();
  const canEdit = loaded && !viewingPast && (localMode || session.user?.can_edit);
  $('map-console').hidden = !canEdit;
  for (const id of ['save', 'undo', 'redo', 'guild-manage', 'move', 'delete']) $(id).hidden = !canEdit;
  const dirty = history.dirty(state);
  const info = revisionInfo?.saved_at ? ` / ${new Date(revisionInfo.saved_at).toLocaleString()} / ${revisionInfo.author.display_name} · ${revisionInfo.author.id}` : '';
  const mapLabel = serverId ? `${serverId} 第${revision}版` : 'サーバー未指定';
  $('save-state').textContent = `${localMode ? '端末内編集' : `${mapLabel}${info}`}${viewingPast ? '（過去版・閲覧のみ）' : ''} / ${dirty ? '未保存' : '変更なし'}${busy ? ' / 通信中' : ''}`;
  $('save-details').textContent = $('save-state').textContent;
  $('save-state').title = $('save-state').textContent;
  $('save-state').textContent = `${localMode ? '端末内' : mapLabel} / ${viewingPast ? '過去版' : canEdit ? dirty ? '未保存' : '変更なし' : '閲覧のみ'}${busy ? ' / 通信中' : ''}`;
  $('save-state').classList.toggle('dirty', dirty);
  $('save').classList.toggle('dirty', dirty);
  $('save').disabled = !editable() || (!dirty && (localMode || revision !== 0));
  $('undo').disabled = !editable() || !history.undoStack.length;
  $('redo').disabled = !editable() || !history.redoStack.length;
  $('server').disabled = busy || localMode || !loaded;
  if (!localMode && loaded && !session.user?.admin) {
    $('server').replaceChildren(option(serverId, serverId));
  }
  for (const button of document.querySelectorAll('[data-reload]')) {
    button.disabled = busy || localMode || !loaded;
  }
  $('revision-view').disabled = busy || localMode || !$('history').value;
  $('revision-restore').disabled = busy || localMode || !session.user?.can_edit || !$('history').value;
  $('history-load').disabled = busy || localMode || !loaded;
  $('import').disabled = !editable();
  for (const selector of ['#guild-form button[type="submit"]', '#member-form button', '#member-name-form button[type="submit"]', '#position-form button[type="submit"]']) {
    document.querySelector(selector).disabled = !editable();
  }
  $('member-manage').disabled = !editable() || !guild();
  $('guild-members-manage').disabled = !editable() || !guild();
  $('rename-guild').disabled = !editable() || !state.guilds.length;
  document.querySelector('#member-form button').disabled = !editable() || !guild();
  document.querySelector('#member-rank-form button').disabled = !editable() || !guild() || !rankMemberIds.size;
  $('delete-members').disabled = !editable() || !guild() || !rankMemberIds.size;
  $('member-select-visible').disabled = !editable() || !guild();
  $('member-clear-checks').disabled = !rankMemberIds.size;
  document.querySelector('#position-form button[type="submit"]').disabled = !editable()
    || (category !== 'mountain' && (!guild() || (category === 'shelter' && !$('member').value)));
  for (const [id, allowed] of [['delete-guild', !!guild()],
    ['move', !!selected()], ['delete', !!selected()]]) {
    $(id).disabled = !editable() || !allowed;
  }
}

function update(mutator, message) {
  if (!editable()) return status('編集できません。ログイン・表示名登録、最新版の読み込みを確認してください。', true);
  try {
    const next = structuredClone(state);
    const result = mutator(next);
    const text = typeof message === 'function' ? message(result) : message;
    if (JSON.stringify(next) === JSON.stringify(state)) {
      status(text);
      return true;
    }
    history.record(state);
    state = next;
    refresh();
    status(`${text} 未保存です。点滅する「保存」で反映してください。`);
    return true;
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
  const orderedGuilds = guildOrder === 'code'
    ? [...state.guilds].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    : state.guilds;
  $('guild').replaceChildren(option('', '未選択'), ...orderedGuilds.map(g => option(g.id, g.name)));
  if (state.guilds.some(g => g.id === guildId)) $('guild').value = guildId;
  const current = guild();
  state.ownGuildId = current?.id ?? null;
  $('guild-member-count').textContent = current ? `${current.members.length}人` : '';
  $('guild-member-count').hidden = !current;
  const placedTypes = new Set(state.facilities.filter(object => object.guildId === current?.id)
    .map(object => object.type));
  for (const entry of $('type').options) {
    if (entry.value === 'mountain' || entry.value === 'shelter') continue;
    const type = TYPES[entry.value];
    entry.className = placedTypes.has(entry.value) ? 'facility-placed' : 'facility-unplaced';
    entry.textContent = `${type.name}${type.size === 1 ? '（1×1）' : ''}${placedTypes.has(entry.value) ? '（配置済み）' : ''}`;
  }
  if (!current && category !== 'mountain') setCategory('mountain');
  const shelters = memberShelters();
  const members = current?.members ?? [];
  $('member').replaceChildren(option('', 'メンバー未選択'));
  for (const rank of RANKS) {
    const groupMembers = members.filter(m => (m.rank ?? null) === rank);
    const matches = groupMembers.filter(m => m.name.toLocaleLowerCase()
      .includes($('member-filter').value.trim().toLocaleLowerCase()));
    const group = document.createElement('optgroup');
    group.label = memberGroupLabel(rank, groupMembers, shelters);
    group.replaceChildren(...matches.map(m => {
      const placed = shelters.has(m.id);
      const entry = option(m.id, `${m.name}（${placed ? '配置済み' : '未配置'}）`);
      entry.className = placed ? 'member-placed' : 'member-unplaced';
      return entry;
    }));
    $('member').append(group);
  }
  if (current?.members.some(m => m.id === memberId)) $('member').value = memberId;
  memberCountLine($('member-count'), members, shelters, 100);
  $('delete-guild').disabled = !current;
  if (!selected()) selectedId = '';
  const object = selected();
  const selection = $('selection');
  if (object) {
    const name = document.createElement('span');
    name.className = 'selection-object-name';
    name.textContent = objectName(object);
    const details = document.createElement('span');
    details.className = 'selection-object-details';
    details.textContent = ` — ${object.size === 1 ? '基準セル' : '南セル'} X:${object.x} Y:${object.y} / ${object.size}×${object.size}`;
    selection.replaceChildren(name, details);
  } else {
    selection.textContent = 'マップ上の施設をクリックして選択します。';
  }
  $('move').disabled = !object;
  $('delete').disabled = !object;
  refreshPersistence();
  if ($('member-dialog').open) renderMemberList();
  if ($('object-dialog').open) renderObjectList();
  const detached = territorySources(state).detached;
  $('territory-warning').textContent = detached.length
    ? `警告: 要塞の領地につながっていない前哨 ${detached.length}件（領地は拡張されません）。計画配置として保存できます。` : '';
  $('territory-warning').hidden = !detached.length;
  requestDraw();
  updateMapUrl();
}

function memberShelters() {
  return new Map(state.facilities.filter(object => object.type === 'shelter'
    && object.guildId === guild()?.id).map(object => [object.memberId, object]));
}
function memberGroupLabel(rank, members, shelters, label = rankName(rank)) {
  const placed = members.filter(member => shelters.has(member.id)).length;
  return `${label}: ${members.length}人 / 配置済み ${placed}人 / 未配置 ${members.length - placed}人`;
}
function memberCountLine(element, members, shelters, limit) {
  const placed = members.filter(member => shelters.has(member.id)).length;
  const items = [
    ['総勢', members.length],
    ['配置済', placed],
    ['未配置', members.length - placed],
  ].map(([name, count], index) => {
    const item = document.createElement('span');
    item.className = 'member-count-item';
    const caption = document.createElement('span');
    caption.textContent = name;
    const value = document.createElement('span');
    value.textContent = `${count}人`;
    if (index === 0) value.classList.toggle('count-exceeded', limit !== undefined && count > limit);
    item.replaceChildren(caption, value);
    return item;
  });
  element.replaceChildren(...items);
}
function memberRankSelection(matches) {
  const visibleIds = new Set(matches.map(member => member.id));
  const hidden = [...rankMemberIds].filter(id => !visibleIds.has(id)).length;
  $('member-rank-selection').textContent = `選択中: ${rankMemberIds.size}人${hidden ? `（検索結果外 ${hidden}人を含む）` : ''}`;
  for (const badge of $('member-list').querySelectorAll('[data-rank-selected]')) {
    const selected = guild()?.members.filter(member => String(member.rank ?? 'unset') === badge.dataset.rankSelected
      && rankMemberIds.has(member.id)).length ?? 0;
    badge.textContent = `(${selected})`;
    badge.hidden = selected === 0;
  }
  $('member-rank-form').querySelector('button[type="submit"]').disabled = !editable() || !guild() || !rankMemberIds.size;
  $('delete-members').disabled = !editable() || !guild() || !rankMemberIds.size;
  $('member-clear-checks').disabled = !rankMemberIds.size;
  refreshPersistence();
}

function renderMemberList() {
  const members = guild()?.members ?? [];
  if (rankSelectionGuildId !== guild()?.id) {
    rankMemberIds.clear();
    rankSelectionGuildId = guild()?.id ?? '';
  }
  const memberIds = new Set(members.map(member => member.id));
  for (const id of rankMemberIds) {
    if (!memberIds.has(id)) rankMemberIds.delete(id);
  }
  const query = $('member-dialog-filter').value.trim().toLocaleLowerCase();
  const matches = members.filter(member => member.name.toLocaleLowerCase().includes(query));
  const shelters = memberShelters();
  memberCountLine($('member-dialog-count'), members, shelters, 100);
  if (query) $('member-dialog-count').append(document.createTextNode(` / 検索結果 ${matches.length}人`));
  $('member-list').replaceChildren();
  for (const rank of RANKS) {
    const groupMembers = matches.filter(member => (member.rank ?? null) === rank);
    const allGroupMembers = members.filter(member => (member.rank ?? null) === rank);
    if (query && !groupMembers.length) continue;
    const key = String(rank ?? 'unset');
    const group = document.createElement('details');
    group.className = 'member-rank-group';
    group.style.setProperty('--rank-color', shelterColor(rank));
    group.open = query ? true : memberOpenRanks.has(key);
    group.addEventListener('toggle', () => {
      if (query) return;
      if (group.open) memberOpenRanks.add(key);
      else memberOpenRanks.delete(key);
    });
    const summary = document.createElement('summary');
    const rankNameElement = document.createElement('span');
    rankNameElement.className = 'member-rank-name';
    rankNameElement.textContent = rank === null ? '未' : rankName(rank);
    if (rank === null) {
      rankNameElement.setAttribute('aria-label', 'ランク未設定');
      rankNameElement.title = 'ランク未設定';
    }
    const selectedCount = document.createElement('span');
    selectedCount.className = 'member-selected-count';
    selectedCount.dataset.rankSelected = key;
    const selected = allGroupMembers.filter(member => rankMemberIds.has(member.id)).length;
    selectedCount.textContent = `(${selected})`;
    selectedCount.hidden = selected === 0;
    const groupCounts = document.createElement('span');
    groupCounts.className = 'member-group-counts';
    const placed = allGroupMembers.filter(member => shelters.has(member.id)).length;
    groupCounts.textContent = `${allGroupMembers.length}人 / 配置済${placed} / 未配置${allGroupMembers.length - placed}`;
    groupCounts.title = `${allGroupMembers.length}人 / 配置済み ${placed}人 / 未配置 ${allGroupMembers.length - placed}人`;
    summary.append(rankNameElement, selectedCount, groupCounts);
    const list = document.createElement('div');
    list.className = 'member-rank-members';
    for (const member of groupMembers) {
      const shelter = shelters.get(member.id);
      const row = document.createElement('div');
      row.className = 'member-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = rankMemberIds.has(member.id);
      checkbox.disabled = !editable();
      checkbox.setAttribute('aria-label', `${member.name}を選択`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) rankMemberIds.add(member.id);
        else rankMemberIds.delete(member.id);
        memberRankSelection(matches);
      });
      const memberButton = document.createElement('button');
      memberButton.type = 'button';
      memberButton.className = 'member-row-name';
      memberButton.textContent = `${member.name} — ${shelter ? `配置済み (${shelter.x},${shelter.y})` : '未配置'}`;
      memberButton.addEventListener('click', () => {
        $('member-filter').value = '';
        refresh();
        $('member').value = member.id;
        refreshPersistence();
      });
      const renameButton = document.createElement('button');
      renameButton.type = 'button';
      renameButton.className = 'member-rename';
      renameButton.textContent = '名前変更';
      renameButton.disabled = !editable();
      renameButton.setAttribute('aria-label', `${member.name}の名前を変更`);
      renameButton.addEventListener('click', () => {
        editingMemberId = member.id;
        editingMemberGuildId = guild()?.id ?? '';
        $('member-name-input').value = member.name;
        $('member-name-dialog').querySelector('.dialog-status').textContent = '';
        $('member-name-dialog').showModal();
        $('member-name-input').focus();
      });
      row.append(checkbox, memberButton, renameButton);
      list.append(row);
    }
    group.append(summary, list);
    $('member-list').append(group);
  }
  memberRankSelection(matches);
  const rows = orderedMembers(members).map(member => {
    const shelter = shelters.get(member.id);
    return [rankName(member.rank), member.name, shelter ? '配置済み' : '未配置',
      shelter?.x ?? '', shelter?.y ?? ''].join('\t');
  });
  $('member-export').value = ['ランク\t名前\t配置状態\tX\tY', ...rows].join('\n');
  $('member-export-status').textContent = '';
  refreshPersistence();
}

function renderObjectList() {
  const query = $('object-filter').value.trim().toLocaleLowerCase();
  const matches = objects().filter(object =>
    `${objectName(object)} (${object.x},${object.y})`.toLocaleLowerCase().includes(query));
  $('object-count').textContent = `${matches.length}件中 ${Math.min(matches.length, objectResultLimit)}件表示`;
  $('object-more').hidden = matches.length <= objectResultLimit;
  $('object-list').replaceChildren(...matches.slice(0, objectResultLimit).map(object => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'object-result';
    const icon = document.createElement('span');
    icon.className = `object-result-icon ${object.type === 'mountain' ? 'mountain' :
      object.type.startsWith('outpost') ? 'facility-outpost' : `facility-${object.type}`}`;
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = `${objectName(object)} (${object.x},${object.y})`;
    button.append(icon, label);
    button.addEventListener('click', () => {
      $('member-filter').value = '';
      selectObject(object, true);
      $('mode').value = 'select';
      $('object-dialog').close();
    });
    return button;
  }));
}

function coordinates() {
  const cell = snapCell($('x').valueAsNumber, $('y').valueAsNumber);
  $('x').value = cell.x;
  $('y').value = cell.y;
  return cell;
}

function draft(cell, id = 'preview') {
  const type = $('type').value;
  const object = { id, type, size: type === 'mountain' ? 2 : TYPES[type].size, ...cell };
  if (type !== 'mountain') object.guildId = guild()?.id;
  if (type === 'shelter') object.memberId = $('member').value;
  return object;
}

function place(cell) {
  if (!editable()) {
    status('閲覧のみです。ログインと表示名登録後に編集できます。', true);
    return false;
  }
  const object = draft(cell, newId());
  const existing = matchingPlacement(object);
  if (existing) {
    selectObject(existing);
    status('配置済みの施設を選択しました。');
    return false;
  }
  const previous = placedFacility(state, object);
  const candidate = previous ? { ...previous, ...cell } : object;
  const error = placementError(state, candidate, previous?.id);
  if (error) {
    status(error, true);
    return false;
  }
  if (!confirmWastelandPlacement(candidate)) return false;
  if (previous && !window.confirm(`${objectName(previous)} を X:${previous.x} Y:${previous.y} から X:${cell.x} Y:${cell.y} に移動しますか？`)) {
    status('施設の移動をキャンセルしました。');
    return false;
  }
  return update(next => {
    placeObject(next, candidate, previous?.id);
    selectedId = candidate.id;
  }, `X:${cell.x} Y:${cell.y} に${previous ? '移動' : '配置'}しました。`);
}

function confirmWastelandPlacement(object) {
  if (object.type !== 'shelter'
    || !footprint(object).some(cell => terrain(cell.x, cell.y) === 'wasteland')) return true;
  const confirmed = window.confirm('緑地ではなく荒地に配置しようとしています。よろしいですか？');
  if (!confirmed) status('荒地への配置をキャンセルしました。');
  return confirmed;
}

function matchingPlacement(candidate) {
  return objects().find(object => object.type === candidate.type && object.size === candidate.size
    && object.guildId === candidate.guildId && object.memberId === candidate.memberId
    && object.x === candidate.x && object.y === candidate.y);
}

$('guild-form').addEventListener('submit', event => {
  event.preventDefault();
  const id = newId();
  update(next => addGuild(next, id, $('guild-name').value), 'ギルドを追加しました。');
  if (state.guilds.some(g => g.id === id)) {
    $('guild').value = id;
    $('guild-name').value = '';
    refresh();
    setGuildPlacementMode();
    rememberGuild();
  }
});
$('member-form').addEventListener('submit', event => {
  event.preventDefault();
  const rank = $('member-add-rank').value === '' ? null : Number($('member-add-rank').value);
  const success = update(next => addMembers(next, $('guild').value, $('member-names').value, newId,
    rank),
  result => `新規登録 ${result.added}人、同名スキップ ${result.skipped}人。登録済みメンバーのランク・順番は変更していません。`);
  if (success) $('member-names').value = '';
});
$('member-name-form').addEventListener('submit', event => {
  event.preventDefault();
  const success = update(next => renameMember(next, editingMemberGuildId, editingMemberId, $('member-name-input').value),
    'メンバーの名前を変更しました。避難所の位置は維持しています。');
  if (success) $('member-name-dialog').close();
});
$('shelter-rank-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!contextMember) return;
  const { guildId, memberId } = contextMember;
  const rank = $('shelter-rank-select').value === '' ? null : Number($('shelter-rank-select').value);
  if (update(next => setMemberRanks(next, guildId, [memberId], rank),
    `1人のランクを${rankName(rank)}に変更しました。避難所の位置は維持しています。`)) {
    contextMember = null;
    $('shelter-rank-dialog').close();
  }
});
$('member-rank-form').addEventListener('submit', event => {
  event.preventDefault();
  const rank = $('member-bulk-rank').value === '' ? null : Number($('member-bulk-rank').value);
  update(next => setMemberRanks(next, $('guild').value, [...rankMemberIds], rank),
    count => `${count}人のランクを${rankName(rank)}に変更しました。名前・登録順・避難所の位置は維持しています。`);
});
$('rename-guild').addEventListener('click', () => {
  if (!editable() || !state.guilds.length) return;
  openGuildCodeDialog(guild()?.id);
});
$('guild-code-form').addEventListener('submit', event => {
  event.preventDefault();
  const oldGuild = state.guilds.find(g => g.id === $('guild-code-old').value);
  const newCode = $('guild-code-new').value;
  if (!oldGuild) return status('変更するギルドを選択してください。', true);
  if (oldGuild.name === newCode) {
    return status('変更前と同じコードです。ギルドコードは変更されていません。');
  }
  if (update(next => renameGuild(next, oldGuild.id, newCode), 'ギルドコードを変更しました。')) {
    $('guild-code-dialog').close();
  }
});
function openMemberManagement() {
  rankMemberIds.clear();
  $('member-dialog-filter').value = '';
  memberOpenRanks.clear();
  if (guild()?.members.some(member => member.rank === 5)) memberOpenRanks.add('5');
  renderMemberList();
  $('member-dialog').querySelector('.dialog-status').textContent = '';
  $('member-dialog').showModal();
}
$('guild-members-manage').addEventListener('click', openMemberManagement);
for (const kind of ['guild', 'member']) {
  $(`${kind}-manage`).addEventListener('click', () => {
    if (kind === 'guild') {
      $('guild-name').value = guild()?.name ?? '';
      $('guild-order').value = guildOrder;
    } else return openMemberManagement();
    $(`${kind}-dialog`).querySelector('.dialog-status').textContent = '';
    $(`${kind}-dialog`).showModal();
  });
}
$('guild-order').addEventListener('change', () => {
  const nextOrder = $('guild-order').value;
  if (!['registration', 'code'].includes(nextOrder)) {
    $('guild-order').value = guildOrder;
    return status('ギルドの並び順を選択してください。', true);
  }
  try {
    localStorage.setItem(GUILD_ORDER_KEY, nextOrder);
  } catch (error) {
    $('guild-order').value = guildOrder;
    return status(`ギルドの並び順をこの端末に保存できません: ${error.message}`, true);
  }
  guildOrder = nextOrder;
  refresh();
});
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => $(button.dataset.close).close());
}
function setCategory(value) {
  placementPreviewActive = true;
  relocationPreviewActive = false;
  hover = null;
  category = value;
  $('map-console').dataset.consoleCategory = value;
  $('member-panel').hidden = value !== 'shelter';
  $('type-panel').hidden = value !== 'facilities';
  const type = value === 'facilities' ? 'fortress' : value;
  $('type').value = type;
  for (const button of document.querySelectorAll('[data-category]')) {
    button.setAttribute('aria-pressed', String(button.dataset.category === value));
  }
  refreshPersistence();
  requestDraw();
}
function prepareUnplacedPlacement(candidate) {
  if (!candidate || candidate.type === 'mountain' || placedFacility(state, candidate)) return;
  $('mode').value = 'place';
  placementPreviewActive = true;
  relocationPreviewActive = false;
  hover = null;
  requestDraw();
}

for (const swatch of document.querySelectorAll('[data-shelter-rank]')) {
  const rank = swatch.dataset.shelterRank === 'unset' ? null : Number(swatch.dataset.shelterRank);
  swatch.style.color = shelterColor(rank);
}
for (const button of document.querySelectorAll('[data-category]')) {
  button.addEventListener('click', () => {
    setCategory(button.dataset.category);
    if (button.dataset.category === 'facilities') prepareUnplacedPlacement(draft({ x: 0, y: 0 }));
    if (button.dataset.category === 'shelter' && $('member').value) {
      prepareUnplacedPlacement(draft({ x: 0, y: 0 }));
    }
  });
}
$('guild').addEventListener('change', () => {
  selectedId = '';
  refresh();
  setGuildPlacementMode();
  rememberGuild();
  const fortress = state.facilities.find(o => o.type === 'fortress' && o.guildId === $('guild').value);
  if (fortress) { Object.assign(view, { x: fortress.x, y: fortress.y, scale: 14 }); requestDraw(); }
});
$('member').addEventListener('change', () => {
  placementPreviewActive = true;
  relocationPreviewActive = false;
  refreshPersistence();
  const shelter = state.facilities.find(o => o.type === 'shelter'
    && o.guildId === $('guild').value && o.memberId === $('member').value);
  if (shelter) {
    selectObject(shelter, true);
    $('mode').value = 'select';
  } else if ($('member').value) {
    prepareUnplacedPlacement(draft({ x: 0, y: 0 }));
  }
  requestDraw();
});
$('type').addEventListener('change', () => {
  placementPreviewActive = true;
  relocationPreviewActive = false;
  hover = null;
  prepareUnplacedPlacement(draft({ x: 0, y: 0 }));
  requestDraw();
});
$('mode').addEventListener('change', () => {
  placementPreviewActive = $('mode').value === 'place';
  relocationPreviewActive = false;
  hover = null;
  requestDraw();
});
for (const id of ['x', 'y']) {
  $(id).addEventListener('input', () => {
    placementPreviewActive = true;
    relocationPreviewActive = true;
    hover = null;
    requestDraw();
  });
}
$('delete-guild').addEventListener('click', () => {
  const current = guild();
  if (!current || !window.confirm(`「${current.name}」と所属メンバー・全施設を削除しますか？`)) return;
  update(next => {
    next.guilds = next.guilds.filter(g => g.id !== current.id);
    next.facilities = next.facilities.filter(o => o.guildId !== current.id);
    if (next.ownGuildId === current.id) next.ownGuildId = next.guilds[0]?.id ?? null;
  }, 'ギルドを削除しました。');
});
$('delete-members').addEventListener('click', () => {
  const selectedIds = [...rankMemberIds];
  const members = guild()?.members.filter(member => selectedIds.includes(member.id)) ?? [];
  if (!members.length) return;
  deletingMemberIds = members.map(member => member.id);
  const shelters = memberShelters();
  $('member-delete-list').replaceChildren(...members.map(member => {
    const item = document.createElement('li');
    const shelter = shelters.get(member.id);
    item.textContent = `${member.name} — ${shelter ? `避難所 (${shelter.x},${shelter.y})` : '避難所なし'}`;
    return item;
  }));
  $('member-delete-dialog').querySelector('.dialog-status').textContent = '';
  $('member-delete-confirm').disabled = !editable();
  $('member-delete-dialog').showModal();
});
$('member-delete-confirm').addEventListener('click', () => {
  const guildId = guild()?.id;
  if (!guildId || !deletingMemberIds.length) return;
  const ids = new Set(deletingMemberIds);
  const success = update(next => {
    const targetGuild = next.guilds.find(entry => entry.id === guildId);
    if (!targetGuild) throw new Error('ギルドを選択してください。');
    targetGuild.members = targetGuild.members.filter(member => !ids.has(member.id));
    next.facilities = next.facilities.filter(object => object.guildId !== guildId || !ids.has(object.memberId));
  }, `${ids.size}人のメンバーと対象の避難所を削除しました。`);
  if (success) {
    for (const id of ids) rankMemberIds.delete(id);
    deletingMemberIds = [];
    $('member-delete-dialog').close();
    renderMemberList();
  }
});
$('position-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const mode = $('mode').value;
    if (place(coordinates())) {
      selectObject(null);
      $('mode').value = mode;
      if (mode === 'place') placementPreviewActive = true;
      requestDraw();
    }
  } catch (error) { status(error.message, true); }
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
    const candidate = { ...object, ...cell };
    const error = placementError(state, candidate, object.id);
    if (error) return status(error, true);
    if (!confirmWastelandPlacement(candidate)) return;
    update(next => placeObject(next, { ...object, ...cell }, object.id), `施設を X:${cell.x} Y:${cell.y} に移動しました。`);
  } catch (error) { status(error.message, true); }
});
$('delete').addEventListener('click', () => {
  deleteObject(selectedId);
});

function selectObject(object, center = false) {
  selectedId = object?.id ?? '';
  if (object) {
    $('x').value = object.x;
    $('y').value = object.y;
    if (object.guildId) $('guild').value = object.guildId;
    if (object.memberId) $('member-filter').value = '';
    setCategory(object.type === 'mountain' ? 'mountain' : object.type === 'shelter' ? 'shelter' : 'facilities');
    $('type').value = object.type;
    if (center) Object.assign(view, { x: object.x, y: object.y });
  }
  refresh();
  if (!object) {
    $('mode').value = 'select';
    hover = null;
    placementPreviewActive = false;
    relocationPreviewActive = false;
  }
  if (object?.memberId) $('member').value = object.memberId;
  refreshPersistence();
  rememberGuild();
}
function deleteObject(id) {
  const object = objects().find(entry => entry.id === id);
  if (!object) return;
  const wasSelected = selectedId === id;
  const success = update(next => {
    next.facilities = next.facilities.filter(entry => entry.id !== id);
    next.mountains = next.mountains.filter(entry => entry.id !== id);
  }, '施設を削除しました。');
  if (success && wasSelected) selectObject(null);
}
function openGuildCodeDialog(guildId) {
  if (!editable() || !state.guilds.length) return;
  const orderedGuilds = guildOrder === 'code'
    ? [...state.guilds].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    : state.guilds;
  $('guild-code-old').replaceChildren(...orderedGuilds.map(g => option(g.id, g.name)));
  $('guild-code-old').value = state.guilds.some(g => g.id === guildId)
    ? guildId : orderedGuilds[0].id;
  $('guild-code-new').value = '';
  $('guild-code-dialog').querySelector('.dialog-status').textContent = '';
  $('guild-code-dialog').showModal();
  $('guild-code-new').focus();
}
function closeObjectContextMenu() {
  $('object-context-menu').hidden = true;
  $('object-context-menu').replaceChildren();
}
function openObjectContextMenu(object, clientX, clientY) {
  if (!editable() || !$('object-context-menu').hidden) return;
  selectObject(object);
  const menu = $('object-context-menu');
  const owner = state.guilds.find(entry => entry.id === object.guildId);
  const member = object.type === 'shelter'
    ? owner?.members.find(entry => entry.id === object.memberId) : null;
  const facilityName = object.type === 'mountain'
    ? '山岳'
    : object.type === 'shelter' ? member?.name ?? TYPES.shelter.name : TYPES[object.type].name;
  const serverNumber = /^S(\d+)$/.exec(serverId)?.[1] ?? '—';
  const header = document.createElement('div');
  header.className = 'object-context-menu-header';
  header.setAttribute('role', 'presentation');
  const title = document.createElement('span');
  title.textContent = `${owner ? `[${owner.name}]` : ''}${facilityName}`;
  const coordinates = document.createElement('span');
  coordinates.textContent = `S:${serverNumber} X:${object.x} Y:${object.y}`;
  header.append(title, coordinates);
  const actions = [{ label: '削除', run: () => deleteObject(object.id) }];
  if (object.type === 'shelter') {
    if (member) {
      actions.push(
        { label: 'ランク変更', run: () => {
          contextMember = { guildId: object.guildId, memberId: object.memberId };
          $('shelter-rank-select').value = member.rank == null ? '' : String(member.rank);
          $('shelter-rank-dialog').querySelector('.dialog-status').textContent = '';
          $('shelter-rank-dialog').showModal();
        } },
        { label: '名前を変更', run: () => {
          editingMemberId = member.id;
          editingMemberGuildId = object.guildId;
          $('member-name-input').value = member.name;
          $('member-name-dialog').querySelector('.dialog-status').textContent = '';
          $('member-name-dialog').showModal();
          $('member-name-input').focus();
        } },
      );
    }
  } else if (object.type === 'fortress') {
    actions.push({ label: 'ギルドコードの変更', run: () => openGuildCodeDialog(object.guildId) });
  }
  menu.replaceChildren(header, ...actions.map(({ label, run }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.addEventListener('click', () => {
      closeObjectContextMenu();
      run();
    });
    return button;
  }));
  menu.hidden = false;
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(clientX, innerWidth - bounds.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(clientY, innerHeight - bounds.height - 4))}px`;
  menu.querySelector('button')?.focus();
}
function openTerritoryContextMenu(guildIds, cell, clientX, clientY) {
  if (!$('object-context-menu').hidden) return;
  const menu = $('object-context-menu');
  const header = document.createElement('div');
  header.className = 'object-context-menu-header';
  header.setAttribute('role', 'presentation');
  const title = document.createElement('span');
  title.textContent = guildIds.map(id => state.guilds.find(entry => entry.id === id)?.name)
    .filter(Boolean).map(code => `[${code}]`).join(' / ');
  const coordinates = document.createElement('span');
  const serverNumber = /^S(\d+)$/.exec(serverId)?.[1] ?? '—';
  coordinates.textContent = `S:${serverNumber} X:${cell.x} Y:${cell.y}`;
  header.append(title, coordinates);
  menu.replaceChildren(header);
  menu.hidden = false;
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(clientX, innerWidth - bounds.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(clientY, innerHeight - bounds.height - 4))}px`;
}
function selectTerritoryGuilds(guildIds) {
  const previousMode = $('mode').value;
  selectObject(null);
  const nextGuildId = guildIds.length === 1 ? guildIds[0] : '';
  if ($('guild').value !== nextGuildId) {
    $('guild').value = nextGuildId;
    $('guild').dispatchEvent(new Event('change'));
  }
  $('mode').value = previousMode;
  placementPreviewActive = previousMode === 'place';
  relocationPreviewActive = false;
  hover = null;
  requestDraw();
}
function objectAtPointer(event) {
  const raw = world(pointer(event));
  if (raw.x < 0 || raw.x > 511 || raw.y < 0 || raw.y > 1023) return null;
  const cell = snapCell(raw.x, raw.y);
  return objectAt(state, cell.x, cell.y);
}
function cellAtPointer(event) {
  const raw = world(pointer(event));
  if (raw.x < 0 || raw.x > 511 || raw.y < 0 || raw.y > 1023) return null;
  return snapCell(raw.x, raw.y);
}
document.addEventListener('pointerdown', event => {
  if (!$('object-context-menu').contains(event.target)) closeObjectContextMenu();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!$('object-context-menu').hidden) {
    closeObjectContextMenu();
    return;
  }
  if (document.querySelector('dialog[open]')) return;
  if (editable() && $('mode').value === 'place' && placementPreviewActive && !relocationPreviewActive) {
    event.preventDefault();
    selectObject(null);
    status('新規配置プレビューを解除しました。');
  }
});
canvas.addEventListener('contextmenu', event => {
  const object = objectAtPointer(event);
  if (!object) {
    const cell = cellAtPointer(event);
    const guildIds = cell ? territoryGuilds(state, cell.x, cell.y) : [];
    if (!cell || !guildIds.length) return;
    event.preventDefault();
    clearTimeout(longPressTimer);
    longPressTimer = null;
    if (touchPoints.has(drag?.id)) {
      longPressPointerId = drag.id;
      drag = null;
    }
    openTerritoryContextMenu(guildIds, cell, event.clientX, event.clientY);
    return;
  }
  if (!editable()) return;
  event.preventDefault();
  clearTimeout(longPressTimer);
  longPressTimer = null;
  if (touchPoints.has(drag?.id)) {
    longPressPointerId = drag.id;
    drag = null;
  }
  openObjectContextMenu(object, event.clientX, event.clientY);
});
$('object-clear').addEventListener('click', () => selectObject(null));
$('object-search').addEventListener('click', () => {
  objectResultLimit = 100;
  $('object-filter').value = '';
  renderObjectList();
  $('object-dialog').showModal();
});
$('object-filter').addEventListener('input', () => {
  objectResultLimit = 100;
  renderObjectList();
});
$('object-more').addEventListener('click', () => {
  objectResultLimit += 100;
  renderObjectList();
});
$('member-export-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('member-export').value);
    $('member-export-status').textContent = 'メンバー表をクリップボードにコピーしました。';
  } catch (error) {
    const message = error instanceof Error ? ` (${error.message})` : '';
    $('member-export-status').textContent =
      `コピーできませんでした。ブラウザーのクリップボード権限を確認してください。${message}`;
  }
});
$('member-dialog-filter').addEventListener('input', renderMemberList);
$('member-select-visible').addEventListener('click', () => {
  const query = $('member-dialog-filter').value.trim().toLocaleLowerCase();
  const members = guild()?.members ?? [];
  const matches = members.filter(member => member.name.toLocaleLowerCase().includes(query));
  const filtered = query && matches.length < members.length;
  const includeFilteredOut = filtered && window.confirm(
    `検索結果の${matches.length}人を選択します。\n検索条件に一致しない${members.length - matches.length}人も含めて全員を選択しますか？\n\n「OK」: 全員を選択\n「キャンセル」: 検索結果だけを選択`);
  for (const member of filtered && !includeFilteredOut ? matches : members) {
    rankMemberIds.add(member.id);
  }
  renderMemberList();
});
$('member-clear-checks').addEventListener('click', () => {
  rankMemberIds.clear();
  renderMemberList();
});
$('member-filter').addEventListener('input', refresh);
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${localMode ? 'local' : serverId}-map.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('JSON をダウンロードしました。他の人は「JSON を読み込み」で同じマップを編集できます。');
});

async function communicate(operation) {
  if (busy) return;
  busy = true;
  refreshPersistence();
  try {
    await operation();
  } catch (error) {
    status(`処理に失敗しました: ${error.message} 未保存の変更はJSONで退避できます。`, true);
  } finally {
    busy = false;
    refresh();
  }
}
function discardChanges() {
  return !history.dirty(state) || window.confirm('未保存の変更があります。破棄して読み込みますか？必要なら先にJSONをダウンロードしてください。');
}
function acceptRevision(result, past = false) {
  const next = importMap(result.map);
  state = next;
  revision = result.revision;
  if (!past) latestRevision = revision;
  revisionInfo = result;
  viewingPast = past;
  loaded = true;
  selectedId = '';
  history.reset(state);
  $('guild').value = '';
  refresh();
  applyPreference();
  refresh();
  home();
  updateMapUrl();
}
function mapRequest(path, csrf, payload) {
  const params = new URLSearchParams();
  if (serverCode) params.set('map', serverCode);
  else if (serverId) params.set('server', serverId);
  return apiRequest(`${path}?${params}`, csrf, payload);
}
async function loadServerOptions() {
  const result = await mapRequest('/maps');
  if (!serverId && result.server) serverId = result.server;
  const servers = [...new Set([...result.servers, ...(serverId ? [serverId] : [])])];
  $('server').replaceChildren(...servers.map(id => option(id, id)));
  $('server').value = serverId;
  return servers;
}
function updateMapUrl() {
  if (localMode || !loaded || !serverId) return;
  const url = new URL(location.href);
  url.searchParams.delete('hash');
  if (serverCode) {
    url.searchParams.set('map', serverCode);
    url.searchParams.delete('server');
  } else {
    url.searchParams.set('server', serverId.slice(1));
    url.searchParams.delete('map');
  }
  if (guild()) url.searchParams.set('guild', guild().name);
  else url.searchParams.delete('guild');
  if (viewingPast) url.searchParams.set('revision', String(revision));
  else url.searchParams.delete('revision');
  if (url.href !== location.href) window.history.replaceState(null, '', url);
  updateAccountLinks();
}
async function loadServer(id) {
  const params = new URLSearchParams({ server: id });
  if (id === serverId && serverCode) {
    params.delete('server');
    params.set('map', serverCode);
  }
  const result = await apiRequest(`/maps/${id}?${params}`);
  serverId = id;
  serverCode = result.code ?? null;
  acceptRevision(result);
  $('history').replaceChildren();
  if (![...$('server').options].some(entry => entry.value === id)) $('server').append(option(id, id));
  $('server').value = id;
  updateMapUrl();
  status(revision === 0 ? `${id} の空マップです。${session.user?.can_edit ? '編集して保存すると登録されます。' : '登録・保存するにはログインと表示名登録が必要です。'}` :
    `${id} 第${revision}版を読み込みました。${session.user?.can_edit ? '編集後に保存してください。' : '閲覧のみです。'}`);
}
$('server').addEventListener('change', () => {
  const id = $('server').value;
  $('server').value = serverId;
  if (!discardChanges()) return;
  communicate(() => loadServer(id));
});
function reloadLatest() {
  if (!discardChanges()) return;
  communicate(async () => {
    session = await apiRequest('/session');
    await loadServer(serverId);
    await loadServerOptions();
  });
}
for (const button of document.querySelectorAll('[data-reload]')) {
  button.addEventListener('click', reloadLatest);
}
$('save').addEventListener('click', () => {
  if (!editable()) return;
  communicate(async () => {
    if (localMode) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      history.saved(state);
      status('このブラウザーに保存しました。');
      return;
    }
    const result = await mapRequest(`/maps/${serverId}`, session.csrf,
      { base_revision: revision, map: sharedMap(state) });
    revision = result.revision;
    latestRevision = revision;
    revisionInfo = result;
    serverCode = result.code;
    updateMapUrl();
    history.saved(state);
    $('history').replaceChildren();
    status(`${serverId} 第${revision}版を保存しました。`);
  });
});
for (const action of ['undo', 'redo']) {
  $(action).addEventListener('click', () => {
    if (!editable()) return;
    state = history[action](state);
    refresh();
    status(action === 'undo' ? '操作を戻しました。' : '操作をやり直しました。');
  });
}
$('history-load').addEventListener('click', () => communicate(async () => {
  const result = await mapRequest(`/maps/${serverId}/history`);
  $('history').replaceChildren(...result.history.map(item => option(String(item.revision),
    `第${item.revision}版 / ${new Date(item.saved_at).toLocaleString()} / ${item.author.display_name} · ${item.author.id}${item.restored_from ? ` / 第${item.restored_from}版から復元` : ''}`)));
  status(result.history.length ? '保存履歴を取得しました。' : 'まだ保存履歴がありません。');
}));
$('history').addEventListener('change', refreshPersistence);
$('revision-view').addEventListener('click', () => {
  const number = Number($('history').value);
  if (!number || !discardChanges()) return;
  communicate(async () => {
    acceptRevision(await mapRequest(`/maps/${serverId}/revisions/${number}`), true);
    status(`第${number}版を閲覧しています。編集するには最新版を読み込んでください。`);
  });
});
$('revision-restore').addEventListener('click', () => {
  const number = Number($('history').value);
  if (!number || !session.user?.can_edit || !discardChanges()
    || !window.confirm(`第${number}版の内容を共有マップの新しい版として保存しますか？`)) return;
  communicate(async () => {
    const result = await mapRequest(`/maps/${serverId}/restore`, session.csrf,
      { base_revision: latestRevision, restore_revision: number });
    acceptRevision(result);
    serverCode = result.code;
    updateMapUrl();
    $('history').replaceChildren();
    status(`第${number}版を元に、第${revision}版を保存しました。`);
  });
});
window.addEventListener('beforeunload', event => {
  if (!history.dirty(state)) return;
  event.preventDefault();
  event.returnValue = '';
});

async function initializeStorage() {
  try {
    const savedGuildOrder = localStorage.getItem(GUILD_ORDER_KEY);
    if (savedGuildOrder !== null && !['registration', 'code'].includes(savedGuildOrder)) {
      throw new Error('ギルドの並び順設定が不正です。');
    }
    guildOrder = savedGuildOrder ?? 'registration';
    const savedPreferences = JSON.parse(localStorage.getItem('pns-map-preferences-v1') ?? '{}');
    if (!savedPreferences || typeof savedPreferences !== 'object' || Array.isArray(savedPreferences)) {
      throw new Error('ギルド選択の保存データが不正です。');
    }
    preferences = savedPreferences;
  } catch (error) {
    status(`ギルド選択を復元できません: ${error.message}`, true);
  }
  let link;
  try { link = parseMapView(location.search); }
  catch (error) { status(error.message, true); return; }
  const focusLink = () => {
    if (link.guild !== null) {
      const target = state.guilds.find(g => g.name === link.guild);
      $('guild').value = target?.id ?? '';
      refresh();
      setGuildPlacementMode();
      if (!target) status(`URLで指定したギルド「${link.guild}」が見つかりません。中央基地を表示します。`, true);
    }
    Object.assign(view, initialMapView(state, link.guild, link.scale));
    requestDraw();
    updateMapUrl();
  };
  if (localMode) {
    $('server').replaceChildren(option('local', '端末内'));
    $('history-panel').hidden = true;
    refresh();
    applyPreference();
    refresh();
    if (link.revision !== null) {
      status('端末内モードには保存履歴がないため、revisionは読み込めません。', true);
      return;
    }
    focusLink();
    return;
  }
  await communicate(async () => {
    session = await apiRequest('/session');
    if (!link.server && !link.code && !session.user?.admin) {
      $('server').replaceChildren(option('', '未指定'));
      $('server-dialog').showModal();
      return;
    }
    serverId = link.server ?? '';
    serverCode = link.code;
    const servers = await loadServerOptions();
    await loadServer(serverId || (servers.includes('S1063') ? 'S1063' : servers[0]));
    if (link.revision !== null) {
      acceptRevision(await mapRequest(`/maps/${serverId}/revisions/${link.revision}`), true);
      status(`第${link.revision}版を閲覧しています。編集するには最新版を読み込んでください。`);
    }
    focusLink();
  });
}
$('server-dialog').addEventListener('cancel', event => event.preventDefault());
$('server-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const value = $('server-number').value.trim();
    const key = /^[A-Za-z0-9_-]{12}$/.test(value) ? 'map' : 'server';
    const link = parseMapView(new URLSearchParams({ [key]: value }));
    const url = new URL(location.href);
    url.searchParams.delete('server');
    url.searchParams.delete('map');
    url.searchParams.set(key, key === 'map' ? link.code : link.server.slice(1));
    url.searchParams.delete('hash');
    location.assign(url);
  } catch (error) {
    status(error.message, true);
  }
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
function diamond(x, y, fill, stroke = null, lineWidth = 1, inset = 0) {
  const p = screen(x, y);
  const s = Math.max(0, view.scale - inset);
  context.beginPath();
  context.moveTo(p.x, p.y - s);
  context.lineTo(p.x + s, p.y);
  context.lineTo(p.x, p.y + s);
  context.lineTo(p.x - s, p.y);
  context.closePath();
  if (fill) { context.fillStyle = fill; context.fill(); }
  if (stroke) { context.strokeStyle = stroke; context.lineWidth = lineWidth; context.stroke(); }
}
function objectDiamond(object, fill, stroke = null, lineWidth = 1, inset = 0) {
  const center = screen(object.x, object.y - (object.size === 1 ? 0 : 1));
  const radius = Math.max(0, view.scale * object.size - inset);
  context.beginPath();
  context.moveTo(center.x, center.y - radius);
  context.lineTo(center.x + radius, center.y);
  context.lineTo(center.x, center.y + radius);
  context.lineTo(center.x - radius, center.y);
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
function prepareOutlineBitmap() {
  if (outlineBitmap) return Promise.resolve(outlineBitmap);
  if (outlineBitmapPromise) return outlineBitmapPromise;
  outlineBitmapPromise = new Promise(resolve => {
    const build = () => {
      const bitmap = document.createElement('canvas');
      bitmap.width = 514;
      bitmap.height = 1026;
      const bitmapContext = bitmap.getContext('2d');
      if (!bitmapContext) {
        outlineBitmapPromise = null;
        resolve(null);
        return;
      }
      bitmapContext.beginPath();
      for (const vertices of mapOutlinePaths) {
        vertices.forEach(([x, y], index) => {
          const px = x + 1;
          const py = y + 1;
          if (index === 0) bitmapContext.moveTo(px, py);
          else bitmapContext.lineTo(px, py);
        });
        bitmapContext.closePath();
      }
      bitmapContext.fillStyle = colors.grass;
      bitmapContext.fill();
      bitmapContext.strokeStyle = '#18271e';
      bitmapContext.lineWidth = 1;
      bitmapContext.stroke();
      outlineBitmap = bitmap;
      resolve(bitmap);
      requestDraw();
    };
    if ('requestIdleCallback' in window) requestIdleCallback(build, { timeout: 1000 });
    else setTimeout(build, 0);
  });
  return outlineBitmapPromise;
}
function markMapInteracting() {
  mapInteracting = true;
  if (mapInteractionTimer !== null) clearTimeout(mapInteractionTimer);
}
function settleMapInteraction() {
  if (mapInteractionTimer !== null) clearTimeout(mapInteractionTimer);
  mapInteractionTimer = setTimeout(() => {
    mapInteractionTimer = null;
    mapInteracting = false;
    const idle = callback => 'requestIdleCallback' in window
      ? requestIdleCallback(callback, { timeout: 250 }) : setTimeout(callback, 0);
    idle(() => {
      if (outlineBitmap) requestDraw();
    });
    requestDraw();
  }, 180);
}
function requestDraw() {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => { frame = null; draw(); });
}
function draw() {
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#202a30';
  context.fillRect(0, 0, width, height);
  const halfWorldWidth = width / (2 * view.scale);
  const halfWorldHeight = height / (2 * view.scale);
  const worldMinX = view.x - halfWorldWidth;
  const worldMaxX = view.x + halfWorldWidth;
  const worldMinY = view.y - halfWorldHeight;
  const worldMaxY = view.y + halfWorldHeight;
  const verticalEdgeVisible = x => worldMinX <= x + 2 && worldMaxX >= x - 2 && worldMaxY >= 0 && worldMinY <= 1023;
  const horizontalEdgeVisible = y => worldMinY <= y + 2 && worldMaxY >= y - 2 && worldMaxX >= 0 && worldMinX <= 511;
  const edgeVisible = verticalEdgeVisible(-1) || verticalEdgeVisible(512)
    || horizontalEdgeVisible(-1) || horizontalEdgeVisible(1024);
  const detailedOutline = !mapInteracting && edgeVisible && view.scale >= 3 && outlineBitmap;
  if (detailedOutline) {
    const origin = screen(-1, -1);
    context.drawImage(outlineBitmap, origin.x, origin.y, 513 * view.scale, 1025 * view.scale);
  } else {
    const origin = screen(-1, -1);
    const end = screen(512, 1024);
    context.fillStyle = colors.grass;
    context.fillRect(origin.x, origin.y, end.x - origin.x, end.y - origin.y);
    if (edgeVisible && view.scale >= 3 && !outlineBitmap) prepareOutlineBitmap();
  }
  polygon(WASTELAND, colors.wasteland);
  polygon(LAB, colors.lab);
  const minX = Math.max(0, Math.floor(view.x - halfWorldWidth - 2));
  const maxX = Math.min(511, Math.ceil(view.x + halfWorldWidth + 2));
  const minY = Math.max(0, Math.floor(view.y - halfWorldHeight - 2));
  const maxY = Math.min(1023, Math.ceil(view.y + halfWorldHeight + 2));
  const visible = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
  if (view.scale >= 5) {
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY + ((minY % 2 === x % 2) ? 0 : 1); y <= maxY; y += 2) {
        diamond(x, y, colors[terrain(x, y)], '#00000025', .5);
      }
    }
  }
  for (const [x, y] of TURRETS) {
    for (const cell of footprint({ x, y, size: 2 })) diamond(cell.x, cell.y, '#d9a65b', '#42351f', .8);
  }
  const mountainCells = new Set(state.mountains.flatMap(footprint).map(cellKey));
  const territories = new Map();
  const placement = placementPreview();
  const previewFacilities = [...state.facilities];
  if (drag?.moved && drag.object) {
    const index = previewFacilities.findIndex(object => object.id === drag.object.id);
    if (index >= 0) previewFacilities[index] = drag.candidate;
  } else if (placement && (placement.type === 'fortress' || placement.type.startsWith('outpost'))) {
    const previous = placedFacility(state, placement);
    if (previous) previewFacilities[previewFacilities.findIndex(object => object.id === previous.id)] = { ...previous, ...placement, id: previous.id };
    else previewFacilities.push(placement);
  }
  const sources = territorySources({ ...state, facilities: previewFacilities });
  const outpostPreviewId = placement?.type.startsWith('outpost')
    ? placedFacility(state, placement)?.id ?? placement.id : null;
  const territoryDisplaySources = outpostPreviewId ? territorySources(state) : sources;
  for (const source of territoryDisplaySources.active) {
    const radius = territoryRadius(source);
    for (let x = Math.max(minX, source.x - radius); x <= Math.min(maxX, source.x + radius); x++) {
      for (let y = Math.max(minY, source.y - radius); y <= Math.min(maxY, source.y + radius); y++) {
        if (!validCell(x, y) || !territoryContains(source, x, y)
          || terrain(x, y) !== 'grass' || mountainCells.has(`${x},${y}`)) continue;
        const key = `${x},${y}`;
        const entry = territories.get(key) ?? { x, y, guilds: new Set(), own: false };
        entry.guilds.add(source.guildId);
        entry.own ||= source.guildId === state.ownGuildId;
        territories.set(key, entry);
      }
    }
  }
  for (const cell of territories.values()) {
    diamond(cell.x, cell.y, colors[cell.guilds.size > 1 ? 'shared' : cell.own ? 'own' : 'other'],
      view.scale >= 5 ? '#00000025' : null, .5);
  }
  if (outpostPreviewId) {
    const previewSource = sources.active.find(source => source.id === outpostPreviewId);
    if (previewSource) {
      context.save();
      context.globalAlpha = .45;
      context.fillStyle = '#a8ff00';
      const radius = territoryRadius(previewSource);
      for (let x = Math.max(minX, previewSource.x - radius); x <= Math.min(maxX, previewSource.x + radius); x++) {
        for (let y = Math.max(minY, previewSource.y - radius); y <= Math.min(maxY, previewSource.y + radius); y++) {
          if (!validCell(x, y) || !territoryContains(previewSource, x, y)
            || terrain(x, y) !== 'grass' || mountainCells.has(`${x},${y}`)) continue;
          diamond(x, y, colors.own);
        }
      }
      context.restore();
    }
  }
  const detachedIds = new Set(sources.detached.map(object => object.id));
  const labels = [];
  for (const object of objects()) {
    const cells = footprint(object);
    if (!cells.some(c => visible(c.x, c.y))) continue;
    const member = object.type === 'shelter'
      ? state.guilds.find(g => g.id === object.guildId)?.members.find(m => m.id === object.memberId) : null;
    const fill = object.type === 'mountain' ? colors.mountain : TYPES[object.type].color;
    const objectInset = view.scale * .25;
    objectDiamond(object, fill, object.type === 'fortress' ? '#ffe69b' : '#efebc2', .45, objectInset);
    if (object.type === 'shelter') {
      const crossRadius = Math.max(0, 1 - objectInset / (2 * view.scale));
      const topLeft = screen(object.x - crossRadius, object.y - 1 - crossRadius);
      const bottomRight = screen(object.x + crossRadius, object.y - 1 + crossRadius);
      const topRight = screen(object.x + crossRadius, object.y - 1 - crossRadius);
      const bottomLeft = screen(object.x - crossRadius, object.y - 1 + crossRadius);
      context.beginPath();
      context.moveTo(topLeft.x, topLeft.y);
      context.lineTo(bottomRight.x, bottomRight.y);
      context.moveTo(topRight.x, topRight.y);
      context.lineTo(bottomLeft.x, bottomLeft.y);
      context.strokeStyle = '#16232d';
      context.lineWidth = Math.max(2.5, Math.min(4.5, view.scale * .3));
      context.stroke();
      context.strokeStyle = shelterColor(member?.rank);
      context.lineWidth = Math.max(1.25, Math.min(2.5, view.scale * .15));
      context.stroke();
    }
    const outlineColor = object.type === 'fortress' ? '#ffe69b' :
      object.type === 'mountain' ? '#28231f' : '#16232d';
    const outlineWidth = object.type === 'fortress'
      ? Math.max(1.25, Math.min(3, view.scale * .16)) : .65;
    objectDiamond(object, null, outlineColor, outlineWidth, objectInset);
    if (object.id === selectedId) {
      objectDiamond(object, null, '#ffffff', object.type === 'shelter' ? 2.5 : .65, objectInset);
    }
    if (detachedIds.has(object.id)) {
      objectDiamond(object, null, '#ff7777', 3, objectInset);
      const p = screen(object.x, object.y);
      const s = view.scale * .45;
      context.beginPath();
      context.moveTo(p.x - s, p.y - s);
      context.lineTo(p.x + s, p.y + s);
      context.moveTo(p.x + s, p.y - s);
      context.lineTo(p.x - s, p.y + s);
      context.strokeStyle = '#ff7777';
      context.lineWidth = 2;
      context.stroke();
    }
    if (view.scale >= 5) labels.push(object);
  }
  for (const object of labels.filter(object => object.id !== selectedId)) drawObjectLabel(object);
  if (view.scale >= 10) {
    context.font = '10px system-ui';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (let x = Math.ceil(minX / 10) * 10; x <= maxX; x += 10) {
      for (let y = Math.ceil(minY / 10) * 10; y <= maxY; y += 10) {
        const p = screen(x, y);
        context.fillStyle = '#192519';
        context.fillText(`${x},${y}`, p.x, p.y);
      }
    }
  }
  drawPlacementPreview(visible);
  const territoryState = { ...state, facilities: previewFacilities };
  const selectedSource = sources.active.find(object => object.id === selectedId);
  const placementSourceId = placement && (placement.type === 'fortress' || placement.type.startsWith('outpost'))
    ? placedFacility(state, placement)?.id ?? placement.id : null;
  const placementSource = placementSourceId
    ? sources.active.find(object => object.id === placementSourceId) : null;
  const boundarySources = [...new Map([selectedSource, placementSource]
    .filter(Boolean).map(source => [source.id, source])).values()];
  for (const source of boundarySources) {
    const boundary = territoryBoundary(territoryState, source);
    context.save();
    context.beginPath();
    for (const [[ax, ay], [bx, by]] of boundary) {
      const a = screen(ax, ay);
      const b = screen(bx, by);
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
    }
    context.strokeStyle = '#14251d';
    context.lineWidth = 6;
    context.stroke();
    context.strokeStyle = '#ffb8ed';
    context.lineWidth = 3;
    context.stroke();
  }
  const selectedLabel = selected();
  if (selectedLabel && footprint(selectedLabel).some(cell => visible(cell.x, cell.y))) drawObjectLabel(selectedLabel, true);
  context.restore();
}

function drawObjectLabel(object, highlight = false) {
    const p = screen(object.x, object.y - (object.size === 1 ? 0 : 1));
    const owner = state.guilds.find(g => g.id === object.guildId);
    const own = object.guildId === state.ownGuildId;
    const name = object.type === 'shelter' ? owner.members.find(m => m.id === object.memberId).name : '';
    const text = object.type === 'mountain' ? '山岳' :
      object.type === 'shelter' ? `${own ? '' : `[${owner.name}]`}${name}` :
      object.type === 'fortress' ? `[${owner.name}] 要塞` : TYPES[object.type].short;
    context.font = `${highlight || object.type === 'fortress' ? 'bold ' : ''}${Math.max(10, Math.min(
      object.type === 'fortress' ? 18 : 15, view.scale))}px system-ui`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineWidth = 3;
    context.strokeStyle = '#15211a';
    if (highlight) {
      context.fillStyle = '#14251df2';
      const size = context.measureText(text);
      context.fillRect(p.x - size.width / 2 - 5, p.y - 11, size.width + 10, 22);
    }
    context.strokeText(text, p.x, p.y);
    context.fillStyle = highlight ? '#ffb8ed' : object.type === 'shelter' ? own ? '#69d5ff' : '#ffe16b' : '#fff';
    context.fillText(text, p.x, p.y);
}

function placementPreview() {
  if (maximized) return null;
  const moving = drag?.object && drag.moved;
  if ((!moving && !placementPreviewActive) || !editable() || (category !== 'mountain' && (!guild()
    || (category === 'shelter' && !$('member').value)))) return null;
  const x = $('x').valueAsNumber;
  const y = $('y').valueAsNumber;
  const pointerCell = !relocationPreviewActive && $('mode').value === 'place' ? hover : null;
  if (!moving && !pointerCell && (!Number.isFinite(x) || !Number.isFinite(y))) return null;
  if (moving) return drag.candidate;
  const candidate = draft(pointerCell ?? snapCell(x, y));
  if (placedFacility(state, candidate) && !relocationPreviewActive) return null;
  return candidate;
}

function drawPlacementPreview(visible) {
  const preview = placementPreview();
  if (!preview) return;
  const moving = drag?.object && drag.moved;
  if (!footprint(preview).some(cell => visible(cell.x, cell.y))) return;
  const existing = moving ? null : matchingPlacement(preview);
  const previous = moving ? drag.object : placedFacility(state, preview);
  const error = existing ? null : placementError(state, preview, previous?.id);
  const color = existing ? '#ffffff' : error ? '#ff7777' : '#d7ff91';
  context.save();
  context.setLineDash(existing ? [] : [6, 4]);
  objectDiamond(preview, existing ? null : error ? '#ff5e5e66' : '#d7ff9144',
    color, preview.type === 'shelter' ? 2 : .65, view.scale * .25);
  context.setLineDash([]);
  const p = screen(preview.x, preview.y - 3);
  const detached = preview.type.startsWith('outpost') && territorySources({
    ...state, facilities: [...state.facilities.filter(object => object.id !== (previous?.id ?? preview.id)), preview],
  }).detached.some(object => object.id === preview.id);
  const text = `${existing ? '選択中' : error ? '配置不可' : previous ? '移動予定' : '配置予定'}: ${objectName(preview)} (${preview.x},${preview.y})${detached ? ' / 領地未接続' : ''}`;
  context.font = '13px system-ui';
  context.textAlign = 'center';
  context.textBaseline = 'bottom';
  context.lineWidth = 4;
  context.strokeStyle = '#15211a';
  context.strokeText(text, p.x, p.y);
  context.fillStyle = color;
  context.fillText(text, p.x, p.y);
  context.restore();
}

function zoom(factor, point = { x: width / 2, y: height / 2 }) {
  markMapInteracting();
  const before = world(point);
  view.scale = Math.max(.3, Math.min(40, view.scale * factor));
  const after = world(point);
  view.x += before.x - after.x;
  view.y += before.y - after.y;
  requestDraw();
  settleMapInteraction();
}
function home() {
  markMapInteracting();
  const fortress = state.facilities.find(o => o.type === 'fortress' && o.guildId === state.ownGuildId);
  Object.assign(view, { x: fortress?.x ?? 256, y: fortress?.y ?? 512, scale: 14 });
  requestDraw();
  settleMapInteraction();
}
$('zoom-in').addEventListener('click', () => zoom(1.25));
$('zoom-out').addEventListener('click', () => zoom(.8));
$('home').addEventListener('click', home);
$('tools-open').addEventListener('click', () => $('tools-dialog').showModal());
$('console-drawer-toggle').addEventListener('click', event => {
  const button = event.currentTarget;
  const expanded = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(expanded));
  document.body.classList.toggle('console-drawer-open', expanded);
  button.textContent = expanded ? '⌄ 操作パネルを閉じる' : '⌃ 操作パネルを開く';
  if (expanded) $('editor-panel').scrollTop = 0;
});
let maximized = false;
function maximizeMap(value) {
  maximized = value;
  document.body.classList.toggle('map-maximized', value);
  $('map-maximize').setAttribute('aria-label', value ? '元のレイアウトに戻す' : '全体表示');
  $('map-maximize').title = value ? '元のレイアウトに戻す' : '全体表示';
  $('map-maximize').setAttribute('aria-pressed', String(value));
  hover = null;
  markMapInteracting();
  requestDraw();
  settleMapInteraction();
}
$('map-maximize').addEventListener('click', () => maximizeMap(!maximized));
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && maximized) maximizeMap(false);
});
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  zoom(Math.exp(-event.deltaY * .001), pointer(event));
}, { passive: false });
canvas.addEventListener('pointerdown', event => {
  if (event.pointerType === 'touch') {
    touchPoints.set(event.pointerId, pointer(event));
    canvas.setPointerCapture(event.pointerId);
    if (touchPoints.size >= 2) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
      if (drag?.object) {
        $('x').value = drag.object.x;
        $('y').value = drag.object.y;
      }
      drag = null;
      hover = null;
      touchGesture = true;
      markMapInteracting();
      pinch = pinchState();
      requestDraw();
      return;
    }
    if (touchGesture) return;
  }
  if (!event.isPrimary || event.button !== 0) return;
  const point = pointer(event);
  const raw = world(point);
  const cell = raw.x >= 0 && raw.x <= 511 && raw.y >= 0 && raw.y <= 1023 ? snapCell(raw.x, raw.y) : null;
  const hit = cell ? objectAt(state, cell.x, cell.y) : null;
  const object = !maximized && editable() && hit?.id === selectedId ? hit : null;
  drag = { id: event.pointerId, start: point, point, moved: false, object,
    candidate: object ? { ...object } : null, origin: raw };
  canvas.setPointerCapture(event.pointerId);
  if (event.pointerType === 'touch' && hit && editable()) {
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      if (!drag || drag.id !== event.pointerId || drag.moved) return;
      drag = null;
      longPressPointerId = event.pointerId;
      openObjectContextMenu(hit, event.clientX, event.clientY);
    }, 550);
  }
});
canvas.addEventListener('pointermove', event => {
  const point = pointer(event);
  if (touchPoints.has(event.pointerId)) {
    touchPoints.set(event.pointerId, point);
    if (touchGesture) {
      if (touchPoints.size >= 2) {
        markMapInteracting();
        const next = pinchState();
        if (pinch && pinch.distance > 0 && next.distance > 0) {
          const anchor = world(pinch.center);
          view.scale = Math.max(.3, Math.min(40, view.scale * next.distance / pinch.distance));
          view.x = anchor.x - (next.center.x - width / 2) / view.scale;
          view.y = anchor.y - (next.center.y - height / 2) / view.scale;
        }
        pinch = next;
        requestDraw();
      }
      return;
    }
  }
  if (drag && drag.id === event.pointerId) {
    if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > (event.pointerType === 'touch' ? 10 : 4)) {
      drag.moved = true;
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (drag.moved) {
      markMapInteracting();
      if (drag.object) {
        const raw = world(point);
        const cell = snapCell(drag.object.x + raw.x - drag.origin.x, drag.object.y + raw.y - drag.origin.y);
        drag.candidate = { ...drag.object, ...cell };
        $('x').value = cell.x;
        $('y').value = cell.y;
      } else {
        view.x -= (point.x - drag.point.x) / view.scale;
        view.y -= (point.y - drag.point.y) / view.scale;
      }
    }
    drag.point = point;
  }
  const raw = world(point);
  hover = raw.x >= 0 && raw.x <= 511 && raw.y >= 0 && raw.y <= 1023 ? snapCell(raw.x, raw.y) : null;
  $('cursor').textContent = hover ? `X:${hover.x} Y:${hover.y}` : 'マップ外';
  requestDraw();
});
canvas.addEventListener('pointerup', event => {
  clearTimeout(longPressTimer);
  longPressTimer = null;
  if (finishTouch(event)) return;
  if (longPressPointerId === event.pointerId) {
    longPressPointerId = null;
    drag = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    return;
  }
  if (!drag || drag.id !== event.pointerId) return;
  const completed = drag;
  const moved = completed.moved;
  drag = null;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (moved) {
    if (completed.object) {
      const candidate = completed.candidate;
      const error = placementError(state, candidate, completed.object.id);
      if (!editable() || error) {
        selectObject(completed.object);
        status(error ?? '編集できないため移動を取り消しました。', true);
      } else if ((candidate.x !== completed.object.x || candidate.y !== completed.object.y)
        && !confirmWastelandPlacement(candidate)) {
        selectObject(completed.object);
      } else if (candidate.x !== completed.object.x || candidate.y !== completed.object.y) {
        update(next => placeObject(next, candidate, candidate.id),
          `施設を X:${candidate.x} Y:${candidate.y} に移動しました。`);
      }
    }
    requestDraw();
    settleMapInteraction();
    return;
  }
  const raw = world(pointer(event));
  if (raw.x < 0 || raw.x > 511 || raw.y < 0 || raw.y > 1023) return;
  const cell = snapCell(raw.x, raw.y);
  $('x').value = cell.x;
  $('y').value = cell.y;
  const hit = objectAt(state, cell.x, cell.y);
  if (hit) {
    selectObject(hit);
    $('mode').value = 'select';
    status(!maximized && editable() ? '施設を選択しました。選択した施設をドラッグすると移動できます。' : '施設を選択しました。閲覧のみです。');
  } else {
    const guildIds = territoryGuilds(state, cell.x, cell.y);
    const placing = !maximized && editable() && $('mode').value === 'place';
    if (guildIds.length && (!placing || guildIds.length > 1 || guildIds[0] !== $('guild').value)) {
      selectTerritoryGuilds(guildIds);
    } else if (placing) place(cell);
    else selectObject(null);
  }
});
canvas.addEventListener('pointercancel', event => {
  clearTimeout(longPressTimer);
  longPressTimer = null;
  if (finishTouch(event)) return;
  if (longPressPointerId === event.pointerId) longPressPointerId = null;
  const object = drag?.object;
  drag = null;
  if (object) selectObject(object);
  requestDraw();
  settleMapInteraction();
});
function pinchState() {
  const [a, b] = [...touchPoints.values()];
  return { distance: Math.hypot(b.x - a.x, b.y - a.y), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}
function finishTouch(event) {
  touchPoints.delete(event.pointerId);
  if (!touchGesture) return false;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  pinch = touchPoints.size >= 2 ? pinchState() : null;
  if (!touchPoints.size) touchGesture = false;
  requestDraw();
  settleMapInteraction();
  return true;
}
canvas.addEventListener('pointerleave', () => { hover = null; requestDraw(); });
canvas.addEventListener('keydown', event => {
  const deltas = { ArrowLeft: [-2, 0], ArrowRight: [2, 0], ArrowUp: [0, -2], ArrowDown: [0, 2] };
  if (!Object.hasOwn(deltas, event.key)) return;
  event.preventDefault();
  markMapInteracting();
  view.x += deltas[event.key][0];
  view.y += deltas[event.key][1];
  requestDraw();
  settleMapInteraction();
});
new ResizeObserver(() => {
  markMapInteracting();
  const rect = $('canvas-container').getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  requestDraw();
  settleMapInteraction();
}).observe($('canvas-container'));

refresh();
home();
initializeStorage();
