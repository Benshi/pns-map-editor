export function sharedMap(state) {
  return { ...state, ownGuildId: state.guilds[0]?.id ?? null };
}

export class EditHistory {
  constructor(state) { this.reset(state); }
  reset(state) {
    this.baseline = JSON.stringify(sharedMap(state));
    this.undoStack = [];
    this.redoStack = [];
  }
  dirty(state) { return JSON.stringify(sharedMap(state)) !== this.baseline; }
  record(state) {
    this.undoStack.push(structuredClone(state));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }
  undo(state) {
    if (!this.undoStack.length) throw new Error('戻せる操作はありません。');
    this.redoStack.push(structuredClone(state));
    return this.undoStack.pop();
  }
  redo(state) {
    if (!this.redoStack.length) throw new Error('やり直せる操作はありません。');
    this.undoStack.push(structuredClone(state));
    return this.redoStack.pop();
  }
  saved(state) { this.baseline = JSON.stringify(sharedMap(state)); }
}

export async function apiRequest(path, csrf, payload) {
  const options = { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(30000) };
  if (payload !== undefined) {
    options.method = 'POST';
    options.body = new URLSearchParams({ csrf, payload: JSON.stringify(payload) });
  }
  const response = await fetch(`./api.php${path}`, options);
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('保存APIに接続できません。配置先・PHP・ログイン状態を確認してください。');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `APIエラー (${response.status})`);
  return result;
}
