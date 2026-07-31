import assert from 'node:assert/strict';
import test from 'node:test';
import {Window} from 'happy-dom';

import {createHeaderSettingsController} from '../src/content/header-settings.js';

function createHarness() {
	const window = new Window();
	const {document} = window;
	type TestElement = ReturnType<typeof document.createElement>;
	let removals = 0;
	const timers: Array<{callback: () => void; cancelled: boolean}> = [];
	const controller = createHeaderSettingsController<TestElement>({
		cancelTimer(handle) {
			(handle as {cancelled: boolean}).cancelled = true;
		},
		getActionGroup: () => (
			document.querySelector('[data-testid="top-bar-actions"]') as TestElement | null
		) ?? undefined,
		hasButton: () => Boolean(document.querySelector('.settings-button')),
		insertButton(group) {
			const button = document.createElement('button');
			button.className = 'settings-button';
			group.append(button);
		},
		removeButton() {
			document.querySelector('.settings-button')?.remove();
			removals++;
		},
		scheduleTimer(callback) {
			const timer = {callback, cancelled: false};
			timers.push(timer);
			return timer;
		},
	});

	return {
		controller,
		createActionGroup() {
			const group = document.createElement('div');
			group.dataset.testid = 'top-bar-actions';
			return group;
		},
		document,
		get removals() {
			return removals;
		},
		runNextTimer() {
			const timer = timers.find(candidate => !candidate.cancelled);
			assert.ok(timer, 'expected a pending readiness timer');
			timer.cancelled = true;
			timer.callback();
		},
		setActionGroup(group?: TestElement) {
			document.querySelector('[data-testid="top-bar-actions"]')?.remove();
			if (group) {
				document.body.append(group);
			}
		},
	};
}

test('waits for a mounted header before inserting the settings button', () => {
	const harness = createHarness();
	harness.controller.setEnabled(true);
	harness.controller.handleMutation();
	assert.equal(harness.document.querySelector('.settings-button'), null);

	harness.runNextTimer();
	assert.equal(harness.document.querySelector('.settings-button'), null);

	const actionGroup = harness.createActionGroup();
	harness.setActionGroup(actionGroup);
	harness.controller.handleMutation();
	assert.equal(actionGroup.querySelector('.settings-button'), null);
	harness.runNextTimer();
	assert.ok(actionGroup.querySelector('.settings-button'));
});

test('removes the settings button immediately when disabled', () => {
	const harness = createHarness();
	const actionGroup = harness.createActionGroup();
	harness.setActionGroup(actionGroup);
	harness.controller.setEnabled(true);
	harness.runNextTimer();
	assert.ok(actionGroup.querySelector('.settings-button'));

	harness.controller.setEnabled(false);
	assert.equal(harness.removals, 1);
	assert.equal(harness.document.querySelector('.settings-button'), null);
});

test('waits for a remounted header before reinserting the settings button', () => {
	const harness = createHarness();
	const firstActionGroup = harness.createActionGroup();
	harness.setActionGroup(firstActionGroup);
	harness.controller.setEnabled(true);
	harness.runNextTimer();
	assert.ok(firstActionGroup.querySelector('.settings-button'));

	const secondActionGroup = harness.createActionGroup();
	harness.setActionGroup(secondActionGroup);
	harness.controller.handleMutation();
	assert.equal(secondActionGroup.querySelector('.settings-button'), null);
	harness.runNextTimer();
	assert.ok(secondActionGroup.querySelector('.settings-button'));
});
