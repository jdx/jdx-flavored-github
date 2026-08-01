import assert from 'node:assert/strict';
import test from 'node:test';

import {fetchNotificationPageResponse} from '../src/content/notification-page.js';

test('treats a rejected notification page fetch as a failed request', async () => {
	let requestedUrl;
	let requestedOptions;
	const response = await fetchNotificationPageResponse(
		'https://github.com/notifications?query=is%3Aunread',
		async (url, options) => {
			requestedUrl = url;
			requestedOptions = options;
			throw new TypeError('Failed to fetch');
		},
	);

	assert.equal(response, undefined);
	assert.equal(
		requestedUrl,
		'https://github.com/notifications?query=is%3Aunread',
	);
	assert.deepEqual(requestedOptions, {credentials: 'same-origin'});
});
