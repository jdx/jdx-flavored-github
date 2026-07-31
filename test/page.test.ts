import assert from 'node:assert/strict';
import test from 'node:test';
import {
	getCurrentRepository,
	getSurface,
	showsArchivedNotifications,
} from '../src/content/page.ts';

function at(url: string) {
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: new URL(url),
	});
}

test('detects notification archive folders', () => {
	at('https://github.com/notifications?query=is%3Adone');
	assert.equal(getSurface(), 'notifications');
	assert.equal(showsArchivedNotifications(), true);

	at('https://github.com/notifications');
	assert.equal(showsArchivedNotifications(), false);
});

test('detects repository list surfaces', () => {
	at('https://github.com/jdx/mise/pulls');
	assert.equal(getSurface(), 'pulls');
	assert.equal(getCurrentRepository(), 'jdx/mise');
});
