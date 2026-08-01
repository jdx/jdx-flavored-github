import assert from 'node:assert/strict';
import test from 'node:test';
import {Window} from 'happy-dom';

import {filterNotificationRowsForFolder} from '../src/content/notification-dom.js';

test('excludes newly archived rows from Inbox notification counts', () => {
  const {document} = new Window();
  const active = document.createElement('li');
  active.className = 'notifications-list-item';
  const archived = document.createElement('li');
  archived.className = 'notifications-list-item notification-archived';

  assert.deepEqual(filterNotificationRowsForFolder([active, archived], false), [active]);
  assert.deepEqual(filterNotificationRowsForFolder([active, archived], true), [active, archived]);
});
