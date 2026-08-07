import assert from 'node:assert/strict';
import test from 'node:test';
import {Window} from 'happy-dom';

import {
  filterNotificationRowsForFolder,
  filterNotificationStackRows,
} from '../src/content/notification-dom.js';

test('excludes newly archived rows from Inbox notification counts', () => {
  const {document} = new Window();
  const active = document.createElement('li');
  active.className = 'notifications-list-item';
  const archived = document.createElement('li');
  archived.className = 'notifications-list-item notification-archived';

  assert.deepEqual(filterNotificationRowsForFolder([active, archived], false), [active]);
  assert.deepEqual(filterNotificationRowsForFolder([active, archived], true), [active, archived]);
});

test('excludes a done stack representative so the next item can be promoted', () => {
  const {document} = new Window();
  const doneRepresentative = document.createElement('li');
  doneRepresentative.className = 'notifications-list-item notification-archived';
  const nextItem = document.createElement('li');
  nextItem.className = 'notifications-list-item github-inbox-tuner-stack-member--collapsed';
  const filteredItem = document.createElement('li');
  filteredItem.className = 'notifications-list-item github-inbox-tuner-hidden';

  assert.deepEqual(
    filterNotificationStackRows([doneRepresentative, nextItem, filteredItem], false),
    [nextItem],
  );
  assert.deepEqual(filterNotificationStackRows([doneRepresentative, nextItem], true), [
    doneRepresentative,
    nextItem,
  ]);
});
