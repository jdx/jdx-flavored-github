import assert from 'node:assert/strict';
import test from 'node:test';
import {Window} from 'happy-dom';

import {
	appendNotificationRows,
	shouldLoadExtraNotificationPage,
} from '../src/content/notification-pagination.ts';

const baseState = {
	enabled: true,
	hasNextPage: true,
	loadedPages: 0,
	maxPages: 5,
	target: 25,
	visibleCount: 3,
};

function group(repository: string, ids: number[]) {
	const rows = ids.map(id => `
		<li class="notifications-list-item" data-notification-id="${id}">
			<a class="notification-list-item-link" href="/${repository}/pull/${id}">Item ${id}</a>
		</li>
	`).join('');
	return `
		<div class="js-notifications-group">
			<h2>${repository}</h2>
			<ul class="js-notifications-list">${rows}</ul>
		</div>
	`;
}

function flatList(entries: Array<[string, number]>) {
	const rows = entries.map(([repository, id]) => `
		<li class="notifications-list-item" data-notification-id="${id}">
			<a class="notification-list-item-link" href="/${repository}/pull/${id}">Item ${id}</a>
		</li>
	`).join('');
	return `<ul class="js-notifications-list">${rows}</ul>`;
}

function inbox(html: string) {
	const window = new Window({url: 'https://github.com/notifications'});
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: new URL('https://github.com/notifications'),
	});
	window.document.body.innerHTML = html;
	return window;
}

test('loads another inbox page only while the active view stays short', () => {
	assert.equal(shouldLoadExtraNotificationPage(baseState), true);
	assert.equal(
		shouldLoadExtraNotificationPage({...baseState, enabled: false}),
		false,
	);
	assert.equal(
		shouldLoadExtraNotificationPage({...baseState, hasNextPage: false}),
		false,
	);
	assert.equal(
		shouldLoadExtraNotificationPage({...baseState, visibleCount: 25}),
		false,
	);
	assert.equal(
		shouldLoadExtraNotificationPage({...baseState, loadedPages: 5}),
		false,
	);
});

test('merges a fetched page into the repository groups already on screen', () => {
	const window = inbox(group('jdx/mise', [1]));
	const {document} = window;
	const fetched = new window.DOMParser().parseFromString(
		group('jdx/mise', [1, 2]),
		'text/html',
	);

	const appended = appendNotificationRows(
		document as unknown as Document,
		[...fetched.querySelectorAll('.notifications-list-item')] as unknown as HTMLElement[],
	);

	assert.deepEqual(
		appended.map(row => row.dataset.notificationId),
		['2'],
	);
	assert.equal(document.querySelectorAll('.js-notifications-group').length, 1);
	assert.deepEqual(
		[...document.querySelectorAll('.js-notifications-list > .notifications-list-item')]
			.map(row => (row as unknown as HTMLElement).dataset.notificationId),
		['1', '2'],
	);
});

test('appends to the trailing list when the inbox has no repository groups', () => {
	const window = inbox(flatList([['jdx/mise', 1]]));
	const {document} = window;
	const fetched = new window.DOMParser().parseFromString(
		flatList([['jdx/mise', 1], ['jdx/usage', 2]]),
		'text/html',
	);

	const appended = appendNotificationRows(
		document as unknown as Document,
		[...fetched.querySelectorAll('.notifications-list-item')] as unknown as HTMLElement[],
	);

	assert.deepEqual(
		appended.map(row => row.dataset.notificationId),
		['2'],
	);
	assert.equal(document.querySelectorAll('.js-notifications-list').length, 1);
	assert.deepEqual(
		[...document.querySelectorAll('.js-notifications-list > .notifications-list-item')]
			.map(row => (row as unknown as HTMLElement).dataset.notificationId),
		['1', '2'],
	);
});

test('appends a repository group the loaded pages have not shown yet', () => {
	const window = inbox(group('jdx/mise', [1]));
	const {document} = window;
	const fetched = new window.DOMParser().parseFromString(
		group('jdx/mise', [2]) + group('jdx/usage', [3, 4]),
		'text/html',
	);

	const appended = appendNotificationRows(
		document as unknown as Document,
		[...fetched.querySelectorAll('.notifications-list-item')] as unknown as HTMLElement[],
	);

	assert.deepEqual(
		appended.map(row => row.dataset.notificationId),
		['2', '3', '4'],
	);
	const groups = [...document.querySelectorAll('.js-notifications-group')];
	assert.equal(groups.length, 2);
	assert.deepEqual(
		groups.map(element => [...element.querySelectorAll('.notifications-list-item')]
			.map(row => (row as unknown as HTMLElement).dataset.notificationId)),
		[['1', '2'], ['3', '4']],
	);
});
