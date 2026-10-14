import test from 'node:test';
import assert from 'node:assert/strict';
import { EditHistory, sharedMap } from './persistence.js';
import { emptyMap, addGuild } from './model.js';

test('undo redo and dirty baseline track content, not personal guild choice', () => {
  const state = emptyMap();
  addGuild(state, 'g1', 'One');
  addGuild(state, 'g2', 'Two');
  const history = new EditHistory(state);
  state.ownGuildId = 'g2';
  assert.equal(history.dirty(state), false);
  assert.equal(sharedMap(state).ownGuildId, 'g1');
  history.record(state);
  state.guilds[0].name = 'Changed';
  assert.equal(history.dirty(state), true);
  const previous = history.undo(state);
  assert.equal(history.dirty(previous), false);
  const redone = history.redo(previous);
  assert.equal(redone.guilds[0].name, 'Changed');
  history.saved(redone);
  assert.equal(history.dirty(redone), false);
  history.record(redone);
  assert.equal(history.redoStack.length, 0);
  history.reset(emptyMap());
  assert.equal(history.undoStack.length, 0);
});

test('undo records are bounded and do not alias mutable data', () => {
  const state = emptyMap();
  const history = new EditHistory(state);
  for (let i = 0; i < 120; i++) history.record(state);
  assert.equal(history.undoStack.length, 100);
  state.mountains.push({ id: 'later' });
  assert.equal(history.undo(state).mountains.length, 0);
});
