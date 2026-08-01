import * as dsl from '../dsl/index.js';
import {defaultOptions} from '../shared/types.js';
import type {
	ExtensionOptions,
	NotificationRule,
	Surface,
	ViewDefinition,
} from '../shared/types.js';
import {
	getCurrentRepository,
	getOwner,
	getSurface,
	isNotificationsPage,
	showsArchivedNotifications,
} from './page.js';
import {
	findStackComponents,
	isDependencyUpdateAuthor,
	orderStackItems,
} from './grouping.js';
import {
	filterNotificationRowsForFolder,
	getNotificationFacts,
	getNotificationRepository,
	getPullRequestReference,
	hasOnlyVisibleBotParticipants,
	isTerminalPullRequestRow,
} from './notification-dom.js';
import {
	parseCommitStatusPartial,
	parseMergeConflict,
	parsePullRequestMetadata,
} from './pull-request-metadata.js';
import type {
	PullRequestMetadata,
	PullRequestReference,
} from './pull-request-metadata.js';
import {
	appendNotificationRows,
	shouldLoadExtraNotificationPage,
} from './notification-pagination.js';
import {createQueryListCollapsing} from './query-collapsing.js';
import {createHeaderSettingsController} from './header-settings.js';
import {updateRevealedIndicator, updateStatusBadges} from './status.js';

(() => {
	function isExtensionContextInvalidated(reason: unknown): boolean {
		const message = reason instanceof Error
			? reason.message
			: String((reason as {message?: unknown})?.message ?? reason);
		return message.includes('Extension context invalidated');
	}

	// Reloading an unpacked extension invalidates the previous content-script
	// world while its fetches and timers can still be settling. Chrome discards
	// that work, so suppress only its expected lifecycle rejection.
	window.addEventListener('unhandledrejection', event => {
		if (isExtensionContextInvalidated(event.reason)) {
			event.preventDefault();
		}
	});

	let builtInNotificationRules;
	let builtInViews;
	const defaults = defaultOptions;
	const maxExtraNotificationPages = 5;
	builtInNotificationRules = dsl.cloneBuiltInNotificationRules();
	builtInViews = dsl.cloneBuiltInViews();

	let options: ExtensionOptions = defaults;
	let optionsLoaded = false;
	let activeNotificationView;
	let notificationViewExplicitlySelected = false;
	let revealedFilterReasonsByList = new WeakMap();
	let extraNotificationPagesAnchor;
	let extraNotificationPagesExhausted = false;
	let extraNotificationPagesKey;
	let extraNotificationPagesLoaded = 0;
	let extraNotificationPagesNextUrl;
	let extraNotificationPagesRefresh;
	let extraNotificationPagesRefreshInFlight;
	let failedChecksRefresh;
	let globalIndicatorRefresh;
	let globalIndicatorRefreshInFlight;
	let globalIndicatorUpdatedAt = 0;
	let notificationStackRefresh;
	let notificationStackGeneration = 0;
	let notificationViewRefresh;
	let recentNotificationsAlertRefresh;
	let recentNotificationsAlertRefreshInFlight;
	let viewBarResizeObserver;
	let viewCountRefresh;
	const pullRequestChecksCache = new Map();
	const pullRequestLabelsCache = new Map();
	const pullRequestMetadataCache = new Map();
	const queryCountCache = new Map();
	const notificationDslCache = new Map();
	const expandedNotificationStacks = new Set<string>();
	const {scheduleQueryListCollapseRefresh} = createQueryListCollapsing({
		expandedGroups: expandedNotificationStacks,
		getCachedMetadata: reference => getCachedPullRequestGroupingMetadata(reference),
		getOptions: () => options,
		getTargets: surface => getListBulkTargets(surface),
		loadMetadata: candidates => loadPullRequestMetadata(candidates),
	});
	const pullRequestChecksStorageKey = 'pullRequestChecksCache';
	const pullRequestLabelsStorageKey = 'pullRequestLabelsCache';
	const pullRequestMetadataStorageKey = 'pullRequestMetadataCache';
	const checksFreshFor = 5 * 60 * 1000;
	const checksUsableFor = 60 * 60 * 1000;
	const metadataUsableFor = 24 * 60 * 60 * 1000;

	function getSurfaceOverride(surface: Surface, repository?: string) {
		return (
			repository
				? options.repositoryViewOverrides?.[repository]?.[surface]
				: undefined
		) ?? (
			getOwner(repository)
				? options.ownerViewOverrides?.[getOwner(repository)]?.[surface]
				: undefined
		) ?? options.viewOverrides?.[surface];
	}

	function getViews(surface: Surface, repository?: string) {
		if (surface === 'notifications') {
			return getNotificationRules(repository).filter(rule => rule.showAsView);
		}
		const targetRepository = repository
			?? getCurrentRepository();
		const override = getSurfaceOverride(surface, targetRepository);
		const overrideViews = override?.views;
		return Array.isArray(overrideViews) && overrideViews.length > 0
			? overrideViews
			: builtInViews[surface];
	}

	function getNotificationRules(repository?: string) {
		const override = getSurfaceOverride('notifications', repository);
		return Array.isArray(override?.rules) && override.rules.length > 0
			? override.rules
			: builtInNotificationRules;
	}

	function getDefaultViewId(surface: Surface, repository?: string) {
		const targetRepository = repository
			?? (surface === 'notifications' ? undefined : getCurrentRepository());
		const override = getSurfaceOverride(surface, targetRepository);
		const defaultViewId = override?.defaultViewId;
		return defaultViewId ?? dsl.builtInDefaultViewIds[surface];
	}

	function getActiveNotificationViewId(row) {
		const repository = getNotificationRepository(row);
		if (
			repository
			&& !notificationViewExplicitlySelected
			&& (
				options.repositoryViewOverrides?.[repository]?.notifications?.rules
				|| options.ownerViewOverrides?.[getOwner(repository)]?.notifications?.rules
			)
		) {
			return getDefaultViewId('notifications', repository);
		}
		return activeNotificationView;
	}

	function matchesNotificationView(row, viewId) {
		const repository = getNotificationRepository(row);
		const rules = getNotificationRules(repository);
		const candidates = getViews('notifications', repository);
		const view = candidates.find(candidate => candidate.id === viewId)
			?? candidates.find(candidate => candidate.id === getDefaultViewId('notifications', repository))
			?? candidates[0];
		return matchesNotificationExpression(row, view, rules);
	}

	function evaluateNotificationRule(
		rule,
		facts,
		rules,
		evaluating = new Set(),
		forcedFalse = new Set(),
	) {
		if (!rule || evaluating.has(rule.id) || forcedFalse.has(rule.id)) {
			return false;
		}

		let tree = notificationDslCache.get(rule.dsl);
		if (!tree) {
			try {
				tree = dsl.parseNotificationDsl(rule.dsl);
				notificationDslCache.set(rule.dsl, tree);
			} catch {
				return false;
			}
		}
		const nextEvaluating = new Set(evaluating).add(rule.id);
		return dsl.evaluateNotificationDsl(tree, facts, ruleId => (
			evaluateNotificationRule(
				rules.find(candidate => candidate.id === ruleId),
				facts,
				rules,
				nextEvaluating,
				forcedFalse,
			)
		));
	}

	function matchesNotificationExpression(row, view, rules) {
		if (!view) {
			return true;
		}
		const effectiveRules = rules ?? getNotificationRules(getNotificationRepository(row));
		return evaluateNotificationRule(view, getNotificationFacts(row), effectiveRules);
	}

	function getFilteredReasons(row, viewId) {
		const facts = getNotificationFacts(row);
		const repository = getNotificationRepository(row);
		const rules = getNotificationRules(repository);
		const candidates = getViews('notifications', repository);
		const view = candidates.find(candidate => candidate.id === viewId)
			?? candidates.find(candidate => candidate.id === getDefaultViewId('notifications', repository))
			?? candidates[0];
		const matchingRules = rules.filter(
			rule => rule.showAsReason && evaluateNotificationRule(rule, facts, rules),
		);
		const withoutMatchingReasons = evaluateNotificationRule(
			view,
			facts,
			rules,
			new Set(),
			new Set(matchingRules.map(rule => rule.id)),
		);
		return matchingRules.length > 0 && withoutMatchingReasons
			? matchingRules.map(rule => rule.label)
			: [`Outside ${view?.label ?? 'this view'}`];
	}

	function classifyNotification(row) {
		const facts = getNotificationFacts(row);
		const viewId = getActiveNotificationViewId(row);
		const matches = matchesNotificationView(row, viewId);
		const reasons = matches ? [] : getFilteredReasons(row, viewId);
		const revealedReasons = revealedFilterReasonsByList.get(row.parentElement) ?? new Set();
		const revealed = reasons.filter(reason => revealedReasons.has(reason));
		const filtered = !matches && revealed.length === 0;
		row.classList.toggle('github-inbox-tuner-hidden', filtered);
		row.classList.toggle(
			'github-inbox-tuner-dimmed',
			matches && options.dimBotNotifications && hasOnlyVisibleBotParticipants(row),
		);
		row.dataset.githubInboxTunerFilteredReason = reasons[0] ?? '';
		row.dataset.githubInboxTunerFilteredReasons = JSON.stringify(reasons);
		updateRevealedIndicator(row, revealed);
		updateStatusBadges(row, facts);
	}

	function updateNotificationVisibility() {
		if (!isNotificationsPage()) {
			for (const disclosure of document.querySelectorAll('.github-inbox-tuner-filtered')) {
				disclosure.remove();
			}
			return;
		}

		activeNotificationView ??= getDefaultViewId('notifications');
		if (!getViews('notifications').some(view => view.id === activeNotificationView)) {
			activeNotificationView = getViews('notifications')[0].id;
		}
		const allRows = document.querySelectorAll<HTMLElement>('.notifications-list-item');
		for (const row of allRows) {
			applyCachedPullRequestFacts(row);
			applyCachedPullRequestLabelFacts(row);
			classifyNotification(row);
		}
		const rows = filterNotificationRowsForFolder(
			allRows,
			showsArchivedNotifications(),
		);

		updateViewBar('notifications');
		updateFilteredDisclosures(rows);
		updateRepositoryBulkActions(allRows, rows);
		updateRepositoryViewActions(rows);
		scheduleFailedChecksRefresh();
		scheduleNotificationStackRefresh();
		scheduleRecentNotificationsAlertRefresh();
		scheduleExtraNotificationPages();
	}

	function scheduleNotificationViewRefresh(delay = 100) {
		clearTimeout(notificationViewRefresh);
		notificationViewRefresh = setTimeout(() => {
			notificationViewRefresh = undefined;
			if (isNotificationsPage()) {
				updateNotificationVisibility();
			}
		}, delay);
	}

	async function fetchPullRequestNumbers(repository, query) {
		const url = new URL(`/${repository}/pulls`, location.origin);
		url.searchParams.set('q', query);
		const response = await fetch(url, {credentials: 'same-origin'});
		if (!response.ok) {
			return new Set();
		}

		const document_ = new DOMParser().parseFromString(await response.text(), 'text/html');
		const numbers = new Set();
		const prefix = `/${repository}/pull/`;
		for (const link of document_.querySelectorAll(`a[href^="${prefix}"]`)) {
			const number = Number(
				new URL(link.getAttribute('href'), location.origin)
					.pathname.slice(prefix.length).split('/')[0],
			);
			if (Number.isInteger(number)) {
				numbers.add(number);
			}
		}

		return numbers;
	}

	function getConfiguredNotificationLabels(rules = getNotificationRules()) {
		return [...new Set(rules.flatMap(
			rule => dsl.getNotificationQualifierValues(rule.dsl, 'label'),
		))];
	}

	async function getPullRequestLabelNumbers(repository, label) {
		const key = `${repository}\n${label}`;
		const cached = pullRequestLabelsCache.get(key);
		if (cached && Date.now() - cached.updatedAt < checksFreshFor) {
			return cached.numbers;
		}

		const numbers = await fetchPullRequestNumbers(
			repository,
			`is:pr label:${JSON.stringify(label)}`,
		);
		pullRequestLabelsCache.set(key, {numbers, updatedAt: Date.now()});
		void persistPullRequestLabelsCache();
		return numbers;
	}

	function setPullRequestLabelFacts(row, reference, labelNumbers) {
		const labels = [...labelNumbers]
			.filter(([, numbers]) => numbers.has(reference.number))
			.map(([label]) => label);
		row.dataset.githubInboxTunerLabels = JSON.stringify(labels);
	}

	function applyCachedPullRequestLabelFacts(row) {
		const reference = getPullRequestReference(row);
		if (!reference) {
			return;
		}
		const labelNumbers = new Map();
		for (const label of getConfiguredNotificationLabels(
			getNotificationRules(reference.repository),
		)) {
			const cached = pullRequestLabelsCache.get(`${reference.repository}\n${label}`);
			if (cached && Date.now() - cached.updatedAt < checksUsableFor) {
				labelNumbers.set(label, cached.numbers);
			}
		}
		setPullRequestLabelFacts(row, reference, labelNumbers);
	}

	async function enrichPullRequestLabelFacts(rows, rules?) {
		const explicitLabels = rules
			? getConfiguredNotificationLabels(rules)
			: undefined;
		const rowsByRepository = new Map();
		for (const row of rows) {
			const reference = getPullRequestReference(row);
			if (!reference) {
				continue;
			}
			const items = rowsByRepository.get(reference.repository) ?? [];
			items.push({reference, row});
			rowsByRepository.set(reference.repository, items);
		}
		await Promise.all([...rowsByRepository].map(async ([repository, items]) => {
			const labels = explicitLabels
				?? getConfiguredNotificationLabels(getNotificationRules(repository));
			const labelNumbers = new Map(await Promise.all(labels.map(async label => [
				label,
				await getPullRequestLabelNumbers(repository, label),
			] as const)));
			for (const {reference, row} of items) {
				setPullRequestLabelFacts(row, reference, labelNumbers);
			}
		}));
	}

	async function getPullRequestCheckStatus(repository) {
		const cached = pullRequestChecksCache.get(repository);
		if (cached && Date.now() - cached.updatedAt < checksFreshFor) {
			return cached;
		}

		const [failedNumbers, ownNumbers, pendingNumbers, passingNumbers] = await Promise.all([
			fetchPullRequestNumbers(repository, 'is:pr is:open status:failure'),
			fetchPullRequestNumbers(repository, 'is:pr author:@me'),
			fetchPullRequestNumbers(repository, 'is:pr is:open status:pending'),
			fetchPullRequestNumbers(repository, 'is:pr is:open status:success'),
		]);
		const latest = pullRequestChecksCache.get(repository) ?? cached;
		const status = {
			exactUpdatedAt: latest?.exactUpdatedAt ?? 0,
			exactStatuses: latest?.exactStatuses ?? new Map(),
			failedNumbers,
			ownNumbers,
			passingNumbers,
			pendingNumbers,
			updatedAt: Date.now(),
		};
		pullRequestChecksCache.set(repository, status);
		void persistPullRequestChecksCache();
		return status;
	}

	function setPullRequestFacts(row, reference, status) {
		const exactStatus = status.exactStatuses?.get(reference.number);
		const checkStatus = isTerminalPullRequestRow(row)
			? ''
			: exactStatus
			?? (status.failedNumbers.has(reference.number)
			? 'failure'
			: status.pendingNumbers.has(reference.number)
				? 'pending'
				: status.passingNumbers.has(reference.number)
					? 'success'
					: '');
		row.dataset.githubInboxTunerCheckStatus = checkStatus;
		row.dataset.githubInboxTunerCheckStatusSource = exactStatus ? 'exact' : 'search';
		row.dataset.githubInboxTunerFailingChecks = String(checkStatus === 'failure');
		row.dataset.githubInboxTunerOwnPullRequest = String(
			status.ownNumbers.has(reference.number),
		);
	}

	function applyCachedPullRequestFacts(row) {
		const reference = getPullRequestReference(row);
		if (!reference) {
			return;
		}
		const cached = pullRequestChecksCache.get(reference.repository);
		if (cached && Date.now() - cached.updatedAt < checksUsableFor) {
			setPullRequestFacts(row, reference, cached);
		}
	}

	async function hydratePullRequestChecksCache() {
		const stored = await chrome.storage.local.get(pullRequestChecksStorageKey);
		for (const [repository, value] of Object.entries(
			stored[pullRequestChecksStorageKey] ?? {},
		)) {
			const searchUsable = value?.updatedAt
				&& Date.now() - value.updatedAt < checksUsableFor;
			const exactUsable = value?.exactUpdatedAt
				&& Date.now() - value.exactUpdatedAt < checksUsableFor;
			if (!searchUsable && !exactUsable) {
				continue;
			}
			pullRequestChecksCache.set(repository, {
				exactStatuses: new Map(exactUsable ? value.exactStatuses ?? [] : []),
				exactUpdatedAt: exactUsable ? value.exactUpdatedAt : 0,
				failedNumbers: new Set(searchUsable ? value.failedNumbers ?? [] : []),
				ownNumbers: new Set(searchUsable ? value.ownNumbers ?? [] : []),
				passingNumbers: new Set(searchUsable ? value.passingNumbers ?? [] : []),
				pendingNumbers: new Set(searchUsable ? value.pendingNumbers ?? [] : []),
				updatedAt: searchUsable ? value.updatedAt : 0,
			});
		}
	}

	async function hydratePullRequestLabelsCache() {
		const stored = await chrome.storage.local.get(pullRequestLabelsStorageKey);
		for (const [key, value] of Object.entries(stored[pullRequestLabelsStorageKey] ?? {})) {
			if (!value?.updatedAt || Date.now() - value.updatedAt >= checksUsableFor) {
				continue;
			}
			pullRequestLabelsCache.set(key, {
				numbers: new Set(value.numbers ?? []),
				updatedAt: value.updatedAt,
			});
		}
	}

	async function hydratePullRequestMetadataCache() {
		const stored = await chrome.storage.local.get(pullRequestMetadataStorageKey);
		for (const [key, entry] of Object.entries(
			stored[pullRequestMetadataStorageKey] ?? {},
		)) {
			if (
				!entry?.updatedAt
				|| Date.now() - entry.updatedAt >= metadataUsableFor
				|| !entry.value?.author
			) {
				continue;
			}
			pullRequestMetadataCache.set(key, {
				complete: false,
				updatedAt: entry.updatedAt,
				value: entry.value,
			});
		}
	}

	async function persistPullRequestChecksCache() {
		const stored = {};
		for (const [repository, value] of pullRequestChecksCache) {
			if (
				Date.now() - value.updatedAt >= checksUsableFor
				&& Date.now() - (value.exactUpdatedAt ?? 0) >= checksUsableFor
			) {
				continue;
			}
			stored[repository] = {
				exactUpdatedAt: value.exactUpdatedAt ?? 0,
				exactStatuses: [...(value.exactStatuses ?? [])],
				failedNumbers: [...value.failedNumbers],
				ownNumbers: [...value.ownNumbers],
				passingNumbers: [...value.passingNumbers],
				pendingNumbers: [...value.pendingNumbers],
				updatedAt: value.updatedAt,
			};
		}
		await chrome.storage.local.set({[pullRequestChecksStorageKey]: stored});
	}

	async function persistPullRequestLabelsCache() {
		const stored = {};
		for (const [key, value] of pullRequestLabelsCache) {
			if (Date.now() - value.updatedAt >= checksUsableFor) {
				continue;
			}
			stored[key] = {
				numbers: [...value.numbers],
				updatedAt: value.updatedAt,
			};
		}
		await chrome.storage.local.set({[pullRequestLabelsStorageKey]: stored});
	}

	async function persistPullRequestMetadataCache() {
		const stored = Object.fromEntries(
			[...pullRequestMetadataCache]
				.filter(([, entry]) => (
					entry.value?.author
					&& Date.now() - entry.updatedAt < metadataUsableFor
				))
				.sort((left, right) => right[1].updatedAt - left[1].updatedAt)
				.slice(0, 500)
				.map(([key, entry]) => [key, {
					updatedAt: entry.updatedAt,
					value: {
						author: entry.value.author,
						baseKey: entry.value.baseKey,
						headKey: entry.value.headKey,
						number: entry.value.number,
						title: entry.value.title,
					},
				}]),
		);
		await chrome.storage.local.set({[pullRequestMetadataStorageKey]: stored});
	}

	async function enrichPullRequestCheckFacts(rows, classify = false) {
		const rowsByRepository = new Map();
		for (const row of rows) {
			const reference = getPullRequestReference(row);
			if (!reference) {
				continue;
			}

			const items = rowsByRepository.get(reference.repository) ?? [];
			items.push({reference, row});
			rowsByRepository.set(reference.repository, items);
		}

		await Promise.all([...rowsByRepository].map(async ([repository, items]) => {
			const status = await getPullRequestCheckStatus(repository);
			for (const {reference, row} of items) {
				setPullRequestFacts(row, reference, status);
				if (classify) {
					classifyNotification(row);
				}
			}
		}));
	}

	async function updatePullRequestCheckNotifications() {
		if (!isNotificationsPage()) {
			return;
		}

		const rows = document.querySelectorAll<HTMLElement>('.notifications-list-item');
		await Promise.all([
			enrichPullRequestCheckFacts(rows),
			enrichPullRequestLabelFacts(rows),
			enrichExactPullRequestMetadata(rows),
		]);
		for (const row of rows) {
			applyCachedPullRequestFacts(row);
			classifyNotification(row);
		}

		const currentFolderRows = filterNotificationRowsForFolder(
			rows,
			showsArchivedNotifications(),
		);
		updateViewBar('notifications');
		updateFilteredDisclosures(currentFolderRows);
	}

	function scheduleFailedChecksRefresh() {
		clearTimeout(failedChecksRefresh);
		failedChecksRefresh = setTimeout(() => {
			void updatePullRequestCheckNotifications();
		}, 250);
	}

	function getGlobalNotificationLink() {
		return [...document.querySelectorAll<HTMLAnchorElement>('a[href="/notifications"]')].find(link => (
			link.querySelector('svg.octicon-inbox')
			&& link.closest('[data-testid="top-nav-right"], header')
		));
	}

	function insertHeaderSettingsButton(headerActions: HTMLElement) {
		const notificationLink = getGlobalNotificationLink();
		if (!notificationLink) {
			return;
		}
		const button = document.createElement('button');
		button.type = 'button';
		const nativeButtonClasses = [...notificationLink.classList].filter(
			className => !className.includes('notificationIndicator'),
		);
		button.className = [
			...nativeButtonClasses,
			'github-inbox-tuner-settings-button',
		].join(' ');
		for (const [name, value] of [
			['data-component', 'IconButton'],
			['data-loading', 'false'],
			['data-no-visuals', 'true'],
			['data-size', 'medium'],
			['data-variant', 'invisible'],
		]) {
			button.setAttribute(name, value);
		}
		button.setAttribute('aria-label', 'jdx Flavored GitHub settings');
		button.title = 'jdx Flavored GitHub settings';
		const mark = document.createElement('span');
		mark.className = 'github-inbox-tuner-settings-icon';
		mark.setAttribute('aria-hidden', 'true');
		mark.textContent = 'jdx';
		button.append(mark);
		// GitHub's search component expects the top-nav container to have a fixed
		// set of direct children. Keep our control inside its existing action group
		// so opening global search does not leave the expanded input at zero width.
		headerActions.append(button);
	}

	const headerSettingsController = createHeaderSettingsController<HTMLElement>({
		getActionGroup: () => document.querySelector<HTMLElement>(
			'[data-testid="top-bar-actions"]',
		) ?? undefined,
		hasButton: () => Boolean(
			document.querySelector('.github-inbox-tuner-settings-button'),
		),
		insertButton: insertHeaderSettingsButton,
		removeButton: () => {
			document.querySelector('.github-inbox-tuner-settings-button')?.remove();
		},
	});

	function scheduleHeaderSettingsButton() {
		headerSettingsController.setEnabled(options.showHeaderSettingsButton);
	}

	function setGlobalNotificationIndicator(hasFocusedNotifications) {
		const link = getGlobalNotificationLink();
		if (!link) {
			return;
		}

		const indicatorClasses = [...link.classList].filter(
			className => className.includes('notificationIndicator'),
		);
		if (indicatorClasses.length > 0) {
			link.dataset.githubInboxTunerIndicatorClasses = indicatorClasses.join(' ');
		}
		const savedClasses = (
			link.dataset.githubInboxTunerIndicatorClasses ?? ''
		).split(/\s+/).filter(Boolean);
		if (hasFocusedNotifications && savedClasses.length > 0) {
			link.classList.add(...savedClasses);
		} else {
			link.classList.remove(...indicatorClasses, ...savedClasses);
		}
		link.dataset.githubInboxTunerFocusedNotifications = String(
			hasFocusedNotifications,
		);
	}

	function getGlobalDefaultNotificationView() {
		const globalViews = getViews('notifications');
		return globalViews.find(
			view => view.id === getDefaultViewId('notifications'),
		) ?? globalViews[0];
	}

	async function loadNotificationPage(url) {
		const response = await fetch(url, {credentials: 'same-origin'});
		if (!response.ok) {
			return {failed: true, rows: []};
		}

		const document_ = new DOMParser().parseFromString(await response.text(), 'text/html');
		const rows = [...document_.querySelectorAll<HTMLElement>('.notifications-list-item')];
		for (const row of rows) {
			applyCachedPullRequestFacts(row);
			applyCachedPullRequestLabelFacts(row);
		}
		await Promise.all([
			enrichPullRequestCheckFacts(rows),
			enrichPullRequestLabelFacts(rows, getNotificationRules()),
		]);
		const nextHref = document_
			.querySelector('a[aria-label="Next"]')
			?.getAttribute('href');
		return {
			next: nextHref ? new URL(nextHref, location.origin).href : undefined,
			rows,
		};
	}

	function getNotificationNextPageLink() {
		return document.querySelector<HTMLAnchorElement>('a[aria-label="Next"]');
	}

	function getNextNotificationPageUrl() {
		if (extraNotificationPagesExhausted) {
			return undefined;
		}
		if (extraNotificationPagesNextUrl) {
			return extraNotificationPagesNextUrl;
		}

		const href = getNotificationNextPageLink()?.getAttribute('href');
		return href ? new URL(href, location.origin).href : undefined;
	}

	// The appended pages are already on screen, so GitHub's own Next link has to
	// skip past them instead of repeating what the user is looking at.
	function setNextNotificationPageUrl(url) {
		extraNotificationPagesNextUrl = url;
		extraNotificationPagesExhausted = !url;
		const link = getNotificationNextPageLink();
		if (!link) {
			return;
		}
		link.classList.toggle('github-inbox-tuner-hidden', !url);
		if (url) {
			const next = new URL(url);
			link.setAttribute('href', `${next.pathname}${next.search}`);
		}
	}

	function countVisibleNotifications() {
		const rows = filterNotificationRowsForFolder(
			document.querySelectorAll<HTMLElement>('.notifications-list-item'),
			showsArchivedNotifications(),
		);
		return rows.filter(
			row => matchesNotificationView(row, getActiveNotificationViewId(row)),
		).length;
	}

	function updateExtraNotificationPagesIndicator(loading) {
		const existing = document.querySelector('.github-inbox-tuner-loading-more');
		if (!loading) {
			existing?.remove();
			return;
		}
		if (existing) {
			return;
		}

		const rows = document.querySelectorAll('.notifications-list-item');
		const lastRow = rows[rows.length - 1];
		const anchor = lastRow?.closest('.js-notifications-group')
			?? lastRow?.parentElement;
		if (!anchor) {
			return;
		}
		const indicator = document.createElement('div');
		indicator.className = 'github-inbox-tuner-loading-more';
		indicator.textContent = 'Loading more notifications…';
		anchor.after(indicator);
	}

	// Leaving the inbox and coming back re-renders a fresh first page under the
	// same URL, so a spent page budget would stop auto-loading for a list that no
	// longer holds anything this run appended. Anchor the budget to a row that
	// only survives while the rendered list does.
	function resetExtraNotificationPages() {
		if (
			extraNotificationPagesKey === location.href
			&& extraNotificationPagesAnchor?.isConnected
		) {
			return;
		}
		extraNotificationPagesKey = location.href;
		extraNotificationPagesAnchor = document.querySelector('.notifications-list-item');
		extraNotificationPagesExhausted = false;
		extraNotificationPagesLoaded = 0;
		extraNotificationPagesNextUrl = undefined;
	}

	async function loadExtraNotificationPages() {
		if (extraNotificationPagesRefreshInFlight) {
			return extraNotificationPagesRefreshInFlight;
		}

		extraNotificationPagesRefreshInFlight = (async () => {
			resetExtraNotificationPages();
			const pageKey = extraNotificationPagesKey;
			let appendedAny = false;
			try {
				while (shouldLoadExtraNotificationPage({
					enabled: isNotificationsPage()
						&& options.autoLoadNotificationPages
						&& location.href === pageKey,
					hasNextPage: Boolean(getNextNotificationPageUrl()),
					loadedPages: extraNotificationPagesLoaded,
					maxPages: maxExtraNotificationPages,
					target: options.autoLoadNotificationTarget,
					visibleCount: countVisibleNotifications(),
				})) {
					const url = getNextNotificationPageUrl();
					updateExtraNotificationPagesIndicator(true);
					// An offline or blocked fetch rejects instead of returning a
					// failed response, and it stops auto-loading either way.
					const result = await loadNotificationPage(url).catch(
						() => ({failed: true, next: undefined, rows: []}),
					);
					updateExtraNotificationPagesIndicator(false);
					if (location.href !== pageKey) {
						return;
					}
					if (result.failed) {
						extraNotificationPagesExhausted = true;
						break;
					}
					extraNotificationPagesLoaded++;
					const appended = appendNotificationRows(document, result.rows);
					setNextNotificationPageUrl(result.next);
					for (const row of appended) {
						applyCachedPullRequestFacts(row);
						applyCachedPullRequestLabelFacts(row);
						classifyNotification(row);
					}
					appendedAny ||= appended.length > 0;
				}
			} finally {
				updateExtraNotificationPagesIndicator(false);
			}
			if (appendedAny) {
				updateNotificationVisibility();
			}
		})().finally(() => {
			extraNotificationPagesRefreshInFlight = undefined;
		});
		return extraNotificationPagesRefreshInFlight;
	}

	function scheduleExtraNotificationPages() {
		if (
			!isNotificationsPage()
			|| !options.autoLoadNotificationPages
			|| extraNotificationPagesRefreshInFlight
		) {
			return;
		}
		clearTimeout(extraNotificationPagesRefresh);
		extraNotificationPagesRefresh = setTimeout(() => {
			extraNotificationPagesRefresh = undefined;
			void loadExtraNotificationPages();
		}, 250);
	}

	async function refreshGlobalNotificationIndicator() {
		if (globalIndicatorRefreshInFlight) {
			return globalIndicatorRefreshInFlight;
		}

		globalIndicatorRefreshInFlight = (async () => {
			let url = new URL('/notifications?query=is%3Aunread', location.origin).href;
			let hasMatch = false;
			for (let page = 0; page < 4 && url; page++) {
				const result = await loadNotificationPage(url);
				if (result.failed) {
					return;
				}
				if (result.rows.some(row => (
					matchesNotificationExpression(
						row,
						getGlobalDefaultNotificationView(),
						getNotificationRules(),
					)
				))) {
					hasMatch = true;
					break;
				}
				url = result.next;
			}
			if (!hasMatch && url) {
				return;
			}
			setGlobalNotificationIndicator(hasMatch);
			globalIndicatorUpdatedAt = Date.now();
		})().finally(() => {
			globalIndicatorRefreshInFlight = undefined;
		});
		return globalIndicatorRefreshInFlight;
	}

	function scheduleGlobalIndicatorRefresh(force = false) {
		if (
			!force
			&& (
				globalIndicatorRefresh
				|| globalIndicatorRefreshInFlight
				|| Date.now() - globalIndicatorUpdatedAt < 60 * 1000
			)
		) {
			return;
		}
		clearTimeout(globalIndicatorRefresh);
		globalIndicatorRefresh = setTimeout(() => {
			globalIndicatorRefresh = undefined;
			void refreshGlobalNotificationIndicator();
		}, 250);
	}

	function getRecentNotificationAlertContainers() {
		return [...document.querySelectorAll(
			'.notification-recent-alerts, [data-url^="/notifications/beta/recent_notifications_alert"]',
		)].filter(container => container.querySelector('a'));
	}

	async function refreshRecentNotificationsAlert() {
		if (!isNotificationsPage() || recentNotificationsAlertRefreshInFlight) {
			return recentNotificationsAlertRefreshInFlight;
		}

		const containers = getRecentNotificationAlertContainers();
		if (containers.length === 0) {
			return;
		}
		for (const container of containers) {
			container.classList.add('github-inbox-tuner-recent-alert--checking');
		}

		recentNotificationsAlertRefreshInFlight = (async () => {
			const loadedIds = new Set(
				[...document.querySelectorAll<HTMLElement>('.notifications-list-item[data-notification-id]')]
					.map(row => row.dataset.notificationId),
			);
			let url = new URL('/notifications?query=is%3Aunread', location.origin).href;
			let hasFocusedNewNotification = false;
			let reachedLoadedNotifications = false;
			for (let page = 0; page < 4 && url && !reachedLoadedNotifications; page++) {
				const result = await loadNotificationPage(url);
				if (result.failed) {
					for (const container of containers) {
						container.classList.remove(
							'github-inbox-tuner-recent-alert--checking',
							'github-inbox-tuner-recent-alert--hidden',
						);
					}
					return;
				}
				for (const row of result.rows) {
					if (loadedIds.has(row.dataset.notificationId)) {
						reachedLoadedNotifications = true;
						break;
					}
					if (
						matchesNotificationExpression(
							row,
							getGlobalDefaultNotificationView(),
							getNotificationRules(),
						)
					) {
						hasFocusedNewNotification = true;
						break;
					}
				}
				if (hasFocusedNewNotification) {
					break;
				}
				url = result.next;
			}
			if (!hasFocusedNewNotification && url && !reachedLoadedNotifications) {
				for (const container of containers) {
					container.classList.remove(
						'github-inbox-tuner-recent-alert--checking',
						'github-inbox-tuner-recent-alert--hidden',
					);
				}
				return;
			}
			for (const container of containers) {
				container.classList.remove('github-inbox-tuner-recent-alert--checking');
				container.classList.toggle(
					'github-inbox-tuner-recent-alert--hidden',
					!hasFocusedNewNotification,
				);
			}
		})().finally(() => {
			recentNotificationsAlertRefreshInFlight = undefined;
		});
		return recentNotificationsAlertRefreshInFlight;
	}

	function scheduleRecentNotificationsAlertRefresh() {
		if (!isNotificationsPage() || getRecentNotificationAlertContainers().length === 0) {
			return;
		}
		clearTimeout(recentNotificationsAlertRefresh);
		recentNotificationsAlertRefresh = setTimeout(() => {
			recentNotificationsAlertRefresh = undefined;
			void refreshRecentNotificationsAlert();
		}, 150);
	}

	function setExactPullRequestCheckStatus(reference, checkStatus) {
		if (!checkStatus) {
			return false;
		}
		let cached = pullRequestChecksCache.get(reference.repository);
		if (!cached) {
			cached = {
				exactUpdatedAt: 0,
				exactStatuses: new Map(),
				failedNumbers: new Set(),
				ownNumbers: new Set(),
				passingNumbers: new Set(),
				pendingNumbers: new Set(),
				updatedAt: 0,
			};
			pullRequestChecksCache.set(reference.repository, cached);
		}
		cached.exactStatuses ??= new Map();
		const changed = cached.exactStatuses.get(reference.number) !== checkStatus;
		cached.exactStatuses.set(reference.number, checkStatus);
		cached.exactUpdatedAt = Date.now();
		return changed;
	}

	async function getPullRequestMetadata(reference) {
		const key = `${reference.repository}#${reference.number}`;
		const cached = pullRequestMetadataCache.get(key);
		if (
			cached?.complete
			&& Date.now() - cached.updatedAt < 5 * 60 * 1000
		) {
			return cached.value;
		}

		const response = await fetch(
			new URL(`/${reference.repository}/pull/${reference.number}`, location.origin),
			{cache: 'no-store', credentials: 'same-origin'},
		);
		let value = response.ok
			? parsePullRequestMetadata(await response.text(), reference)
			: undefined;
		if (value && ['CLOSED', 'MERGED'].includes(value.state)) {
			value = {
				...value,
				checkStatus: undefined,
				mergeConflict: undefined,
				statusBatch: undefined,
			};
		}
		if (value?.statusBatch?.url) {
			const body = new FormData();
			for (const [name, fieldValue] of value.statusBatch.fields) {
				body.append(`items[item-0][${name}]`, fieldValue);
			}
			body.set('_method', 'GET');
			const statusResponse = await fetch(
				new URL(value.statusBatch.url, location.origin),
				{
					body,
					cache: 'no-store',
					credentials: 'same-origin',
					headers: {Accept: 'application/json'},
					method: 'POST',
				},
			);
			if (statusResponse.ok) {
				const statusPayload = await statusResponse.json();
				value = {
					...value,
					checkStatus: parseCommitStatusPartial(statusPayload['item-0'] ?? '')
						?? value.checkStatus,
				};
			}
		}
		if (value && value.state === 'OPEN') {
			const mergeResponse = await fetch(
				new URL(
					`/${reference.repository}/pull/${reference.number}/page_data/merge_box?merge_method=MERGE&bypass_requirements=false`,
					location.origin,
				),
				{
					cache: 'no-store',
					credentials: 'same-origin',
					headers: {Accept: 'application/json'},
				},
			);
			if (mergeResponse.ok) {
				value = {
					...value,
					mergeConflict: parseMergeConflict(await mergeResponse.json()),
				};
			}
		}
		pullRequestMetadataCache.set(key, {complete: true, updatedAt: Date.now(), value});
		return value;
	}

	function getCachedPullRequestGroupingMetadata(reference) {
		const cached = pullRequestMetadataCache.get(
			`${reference.repository}#${reference.number}`,
		);
		return cached?.value?.author
			&& Date.now() - cached.updatedAt < metadataUsableFor
			? cached.value
			: undefined;
	}

	function findAuthorComponents(items) {
		const groups = new Map();
		for (const item of items) {
			const author = item.metadata.author;
			if (
				!author
				|| (
					!options.collapseSameAuthorNotifications
					&& !(options.collapseDependencyUpdates && isDependencyUpdateAuthor(author))
				)
			) {
				continue;
			}
			const key = author.toLowerCase();
			const group = groups.get(key) ?? [];
			group.push(item);
			groups.set(key, group);
		}
		return [...groups.values()].filter(group => group.length > 1);
	}

	function placeGroupRowsInOrder(group) {
		const rows = group.map(item => item.row);
		const parent = rows[0]?.parentElement;
		if (!parent || !rows.every(row => row.parentElement === parent)) {
			return;
		}
		const children = [...parent.children];
		const firstIndex = Math.min(...rows.map(row => children.indexOf(row)));
		if (
			firstIndex < 0
			|| rows.every((row, index) => children[firstIndex + index] === row)
		) {
			return;
		}
		children[firstIndex].before(...rows);
	}

	function decorateCollapsedGroup(group, signature, label, expandedLabel) {
		const representative = group[0];
		const button = document.createElement('button');
		button.className = 'github-inbox-tuner-collapse-toggle';
		button.type = 'button';
		const chevron = document.createElement('button');
		chevron.className = 'github-inbox-tuner-collapse-chevron';
		chevron.type = 'button';
		const icon = document.createElement('span');
		icon.className = 'github-inbox-tuner-collapse-icon';
		chevron.append(icon);
		const placeholders = document.createElement('span');
		placeholders.className = 'github-inbox-tuner-collapse-placeholders';
		placeholders.setAttribute('aria-hidden', 'true');
		for (let index = 0; index < 2; index++) {
			const placeholder = document.createElement('span');
			placeholder.className = 'github-inbox-tuner-collapse-placeholder';
			placeholders.append(placeholder);
		}
		button.append(placeholders);

		const updateExpandedState = expanded => {
			representative.row.classList.toggle(
				'github-inbox-tuner-collapse-representative--expanded',
				expanded,
			);
			button.setAttribute('aria-expanded', String(expanded));
			chevron.setAttribute('aria-expanded', String(expanded));
			button.setAttribute(
				'aria-label',
				expanded ? expandedLabel : `Expand ${group.length} related pull requests; ${label}`,
			);
			button.classList.toggle(
				'github-inbox-tuner-collapse-toggle--expanded',
				expanded,
			);
			button.title = expanded
				? expandedLabel
				: `Expand ${group.length} related pull request notifications`;
			chevron.setAttribute('aria-label', expanded ? expandedLabel : label);
			chevron.title = expanded ? expandedLabel : label;
			for (const {row} of group) {
				row.classList.toggle(
					'github-inbox-tuner-stack-member--collapsed',
					row !== representative.row && !expanded,
				);
				row.classList.toggle(
					'github-inbox-tuner-collapse-member--expanded',
					row !== representative.row && expanded,
				);
			}
		};
		const toggleExpanded = event => {
			event.preventDefault();
			event.stopPropagation();
			const expanded = !expandedNotificationStacks.has(signature);
			if (expanded) {
				expandedNotificationStacks.add(signature);
			} else {
				expandedNotificationStacks.delete(signature);
			}
			updateExpandedState(expanded);
		};
		button.addEventListener('click', toggleExpanded);
		chevron.addEventListener('click', toggleExpanded);
		updateExpandedState(expandedNotificationStacks.has(signature));
		representative.row.querySelector('.notification-list-item-link')?.after(chevron);
		representative.row.after(button);
	}

	function clearNotificationStackDecorations(root) {
		for (const toggle of root.querySelectorAll('.github-inbox-tuner-collapse-toggle')) {
			toggle.remove();
		}
		for (const chevron of root.querySelectorAll('.github-inbox-tuner-collapse-chevron')) {
			chevron.remove();
		}
		for (const row of root.querySelectorAll('.github-inbox-tuner-stack-member--collapsed')) {
			row.classList.remove('github-inbox-tuner-stack-member--collapsed');
		}
		for (const row of root.querySelectorAll('.github-inbox-tuner-collapse-member--expanded')) {
			row.classList.remove('github-inbox-tuner-collapse-member--expanded');
		}
		for (const row of root.querySelectorAll(
			'.github-inbox-tuner-collapse-representative--expanded',
		)) {
			row.classList.remove('github-inbox-tuner-collapse-representative--expanded');
		}
	}

	function decorateNotificationGroups(items: Array<{
		metadata: PullRequestMetadata;
		reference: PullRequestReference;
		row: Element;
	}>) {
		const groupedItems = new Set();
		for (const component of findStackComponents(items)) {
			const stack = orderStackItems(component);
			for (const item of stack) {
				groupedItems.add(item);
			}
			placeGroupRowsInOrder(stack);
			const signature = `${stack[0].reference.repository}:${stack
				.map(item => item.reference.number)
				.sort((left, right) => left - right)
				.join(',')}`;
			decorateCollapsedGroup(
				stack,
				signature,
				`${stack.length - 1} more ${stack.length === 2 ? 'PR' : 'PRs'} in stack`,
				`Collapse ${stack.length}-PR stack`,
			);
		}

		for (const authorGroup of findAuthorComponents(
			items.filter(item => !groupedItems.has(item)),
		)) {
			const author = authorGroup[0].metadata.author;
			const signature = `${authorGroup[0].reference.repository}:author:${author.toLowerCase()}:${authorGroup
				.map(item => item.reference.number)
				.sort((left, right) => left - right)
				.join(',')}`;
			decorateCollapsedGroup(
				authorGroup,
				signature,
				isDependencyUpdateAuthor(author)
					? `${authorGroup.length - 1} more dependency ${authorGroup.length === 2 ? 'update' : 'updates'}`
					: `${authorGroup.length - 1} more ${authorGroup.length === 2 ? 'PR' : 'PRs'} by ${author}`,
				isDependencyUpdateAuthor(author)
					? `Collapse dependency updates by ${author}`
					: `Collapse PRs by ${author}`,
			);
		}
	}

	async function loadPullRequestMetadata(candidates) {
		const results = new Array(candidates.length);
		let nextIndex = 0;
		const workers = Array.from(
			{length: Math.min(4, candidates.length)},
			async () => {
				while (nextIndex < candidates.length) {
					const index = nextIndex++;
					results[index] = {
						...candidates[index],
						metadata: await getPullRequestMetadata(candidates[index].reference),
					};
				}
			},
		);
		await Promise.all(workers);
		void persistPullRequestMetadataCache();
		return results.filter(item => item.metadata);
	}

	async function enrichExactPullRequestMetadata(rows) {
		const candidates = [...rows]
			.map(row => ({reference: getPullRequestReference(row), row}))
			.filter(item => item.reference);
		const items = await loadPullRequestMetadata(candidates);
		let exactStatusesChanged = false;
		for (const item of items) {
			item.row.dataset.githubInboxTunerAuthor = item.metadata.author ?? '';
			item.row.dataset.githubInboxTunerMergeConflict = String(
				item.metadata.mergeConflict === true,
			);
			exactStatusesChanged = setExactPullRequestCheckStatus(
				item.reference,
				item.metadata.checkStatus,
			) || exactStatusesChanged;
			setPullRequestFacts(
				item.row,
				item.reference,
				pullRequestChecksCache.get(item.reference.repository),
			);
		}
		if (exactStatusesChanged) {
			await persistPullRequestChecksCache();
		}
		return items;
	}

	function decorateCachedNotificationStacks() {
		if (!isNotificationsPage()) {
			return [];
		}

		clearNotificationStackDecorations(document);
		const lists = [...new Set(
			[...document.querySelectorAll('.notifications-list-item')].map(row => row.parentElement),
		)].map(list => ({
			candidates: [...list.querySelectorAll(':scope > .notifications-list-item')]
				.filter(row => !row.classList.contains('github-inbox-tuner-hidden'))
				.map(row => ({reference: getPullRequestReference(row), row}))
				.filter(item => item.reference),
			list,
		}));

		for (const {candidates} of lists) {
			const cachedItems = candidates
				.map(item => ({
					...item,
					metadata: getCachedPullRequestGroupingMetadata(item.reference),
				}))
				.filter(item => item.metadata);
			decorateNotificationGroups(cachedItems);
		}
		return lists;
	}

	async function updateNotificationStacks() {
		if (!isNotificationsPage()) {
			return;
		}

		const generation = ++notificationStackGeneration;
		const lists = decorateCachedNotificationStacks();

		const loadedItems = await loadPullRequestMetadata(
			lists.flatMap(({candidates}) => candidates),
		);
		if (generation !== notificationStackGeneration) {
			return;
		}
		const itemsByList = new Map();
		for (const item of loadedItems) {
			const listItems = itemsByList.get(item.row.parentElement) ?? [];
			listItems.push(item);
			itemsByList.set(item.row.parentElement, listItems);
		}

		for (const {list} of lists) {
			const items = itemsByList.get(list) ?? [];
			clearNotificationStackDecorations(list);
			let exactStatusesChanged = false;
			for (const item of items) {
				item.row.dataset.githubInboxTunerAuthor = item.metadata.author ?? '';
				item.row.dataset.githubInboxTunerMergeConflict = String(
					item.metadata.mergeConflict === true,
				);
				exactStatusesChanged = setExactPullRequestCheckStatus(
					item.reference,
					item.metadata.checkStatus,
				) || exactStatusesChanged;
				setPullRequestFacts(
					item.row,
					item.reference,
					pullRequestChecksCache.get(item.reference.repository),
				);
				classifyNotification(item.row);
			}
			if (exactStatusesChanged) {
				void persistPullRequestChecksCache();
			}
			decorateNotificationGroups(items);
		}
	}

	function scheduleNotificationStackRefresh() {
		clearTimeout(notificationStackRefresh);
		notificationStackGeneration++;
		decorateCachedNotificationStacks();
		notificationStackRefresh = setTimeout(() => {
			void updateNotificationStacks();
		}, 350);
	}

	function updateFilteredDisclosures(rows) {
		const rowsByList = new Map();
		for (const row of rows) {
			const list = row.parentElement;
			const listRows = rowsByList.get(list) ?? [];
			listRows.push(row);
			rowsByList.set(list, listRows);
		}

		for (const disclosure of document.querySelectorAll('.github-inbox-tuner-filtered')) {
			if (!rowsByList.has(disclosure.previousElementSibling)) {
				disclosure.remove();
			}
		}

		for (const [list, listRows] of rowsByList) {
			updateListFilteredDisclosure(list, listRows);
		}
	}

	function updateListFilteredDisclosure(list, rows) {
		const filteredRows = rows.filter(row => (
			!matchesNotificationView(row, getActiveNotificationViewId(row))
		));
		let disclosure = list.nextElementSibling?.classList.contains('github-inbox-tuner-filtered')
			? list.nextElementSibling
			: undefined;
		if (filteredRows.length === 0) {
			disclosure?.remove();
			return;
		}

		const reasonCounts = new Map();
		for (const row of filteredRows) {
			let reasons;
			try {
				reasons = JSON.parse(row.dataset.githubInboxTunerFilteredReasons);
			} catch {
				reasons = [row.dataset.githubInboxTunerFilteredReason || 'Other'];
			}
			for (const reason of reasons) {
				reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
			}
		}
		const revealedFilterReasons = revealedFilterReasonsByList.get(list) ?? new Set();
		const signature = JSON.stringify({
			reasons: [...reasonCounts],
			revealed: [...revealedFilterReasons].sort(),
		});
		if (disclosure?.dataset.signature === signature) {
			return;
		}

		if (!disclosure) {
			disclosure = document.createElement('div');
			disclosure.className = 'github-inbox-tuner-filtered';
			list.after(disclosure);
		}

		disclosure.dataset.signature = signature;
		const label = document.createElement('span');
		label.className = 'github-inbox-tuner-filtered-label';
		label.textContent = 'Filtered';
		const pills = [...reasonCounts].map(([reason, count]) => {
			const pill = document.createElement('button');
			pill.className = 'github-inbox-tuner-filtered-pill';
			pill.classList.toggle(
				'github-inbox-tuner-filtered-pill--active',
				revealedFilterReasons.has(reason),
			);
			pill.type = 'button';
			pill.textContent = `${reason} ${count.toLocaleString()}`;
			pill.title = revealedFilterReasons.has(reason)
				? `Hide ${reason.toLowerCase()} notifications`
				: `Show ${reason.toLowerCase()} notifications`;
			pill.addEventListener('click', () => {
				if (revealedFilterReasons.has(reason)) {
					revealedFilterReasons.delete(reason);
				} else {
					revealedFilterReasons.add(reason);
				}
				revealedFilterReasonsByList.set(list, revealedFilterReasons);
				updateNotificationVisibility();
			});
			return pill;
		});
		if (reasonCounts.size > 1) {
			const allReasons = [...reasonCounts.keys()];
			const allRevealed = allReasons.every(reason => revealedFilterReasons.has(reason));
			const all = document.createElement('button');
			all.className = 'github-inbox-tuner-filtered-pill';
			all.classList.toggle('github-inbox-tuner-filtered-pill--active', allRevealed);
			all.type = 'button';
			all.textContent = `All ${filteredRows.length.toLocaleString()}`;
			all.addEventListener('click', () => {
				for (const reason of allReasons) {
					if (allRevealed) {
						revealedFilterReasons.delete(reason);
					} else {
						revealedFilterReasons.add(reason);
					}
				}
				revealedFilterReasonsByList.set(list, revealedFilterReasons);
				updateNotificationVisibility();
			});
			pills.push(all);
		}
		disclosure.replaceChildren(label, ...pills);
	}

	function updateRepositoryViewActions(rows) {
		const lists = new Set([...rows].map(row => row.parentElement));
		for (const list of lists) {
			const repository = getNotificationRepository(list);
			const group = list.closest('.js-notifications-group')
				?? list.closest(
					'section, [data-repository-hovercards-enabled], .js-navigation-container',
				)
				?? list.parentElement;
			if (!repository || !group) {
				continue;
			}

			const existing = group.querySelector('.github-inbox-tuner-repository-view-action');
			const nativeAction = [...group.querySelectorAll('button, a')].find(element => (
				/^(Open unread|Mark as done)$/i.test(element.textContent.trim())
			));
			const actionHost = nativeAction?.parentElement;
			if (!actionHost) {
				continue;
			}
			actionHost.classList.add('github-inbox-tuner-repository-actions');
			if (existing) {
				continue;
			}

			const button = document.createElement('button');
			button.className = `${nativeAction.className} github-inbox-tuner-repository-view-action`.trim();
			button.type = 'button';
			button.textContent = 'Customize views';
			button.title = `Customize notification views for ${repository}`;
			button.addEventListener('click', () => {
				openInlineViewEditor('notifications', repository, list);
			});
			actionHost.append(button);
		}
	}

	function getBulkTarget(row, surface) {
		const link = surface === 'notifications'
			? row.querySelector('.notification-list-item-link[href]')
			: [...row.querySelectorAll('a[href]')].find(candidate => (
				/^\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+/.test(
					new URL(candidate.getAttribute('href'), location.origin).pathname,
				)
			));
		if (!link) {
			return;
		}
		const url = new URL(link.getAttribute('href'), location.origin);
		const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/);
		if (!match) {
			return;
		}
		return {
			number: Number(match[4]),
			repository: `${match[1]}/${match[2]}`,
			row,
			title: row.querySelector('.markdown-title, [data-testid="issue-row-title-link"]')
				?.textContent.trim() ?? `${match[1]}/${match[2]}#${match[4]}`,
			type: match[3] === 'pull' ? 'pr' : 'issue',
			url: url.href,
		};
	}

	function getListBulkTargets(surface) {
		const seen = new Set();
		const targets = [];
		for (const link of document.querySelectorAll(
			'main a[href*="/pull/"], main a[href*="/issues/"]',
		)) {
			const pathname = new URL(link.getAttribute('href'), location.origin).pathname;
			if (!/^\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+\/?$/.test(pathname)) {
				continue;
			}
			const row = link.closest(
				'[data-testid="issue-row"], .js-issue-row, [role="listitem"], .Box-row, li',
			);
			const target = row && getBulkTarget(row, surface);
			if (target && !seen.has(target.url)) {
				seen.add(target.url);
				targets.push(target);
			}
		}
		return targets;
	}

	function createBulkActionsMenu(entries, title = 'Bulk actions') {
		const details = document.createElement('details');
		details.className = 'github-inbox-tuner-bulk-menu';
		const summary = document.createElement('summary');
		summary.textContent = title;
		const menu = document.createElement('div');
		menu.className = 'github-inbox-tuner-bulk-menu-list';
		for (const entry of entries) {
			const button = document.createElement('button');
			button.type = 'button';
			if (entry.action.steps.some(step => step.type === 'notification:done')) {
				const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
				icon.setAttribute('aria-hidden', 'true');
				icon.setAttribute('height', '16');
				icon.setAttribute('viewBox', '0 0 16 16');
				icon.setAttribute('width', '16');
				icon.classList.add('octicon', 'octicon-check');
				const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				path.setAttribute(
					'd',
					'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z',
				);
				icon.append(path);
				button.append(icon);
			}
			button.append(document.createTextNode(
				`${entry.action.label} (${entry.targets.length.toLocaleString()})`,
			));
			button.addEventListener('click', () => {
				details.open = false;
				openBulkActionPreview(entry);
			});
			menu.append(button);
		}
		details.append(summary, menu);
		return details;
	}

	function describeBulkStep(step) {
		const all = [
			...dsl.getBulkActionTypes('notifications'),
			...dsl.getBulkActionTypes('pulls'),
			...dsl.getBulkActionTypes('issues'),
		];
		const label = all.find(item => item.type === step.type)?.label ?? step.type;
		return step.value ? `${label}: ${step.value}` : label;
	}

	function openBulkActionPreview(entry) {
		document.querySelector('.github-inbox-tuner-bulk-dialog')?.remove();
		const dialog = document.createElement('dialog');
		dialog.className = 'github-inbox-tuner-bulk-dialog';
		const title = document.createElement('h2');
		title.textContent = entry.action.label;
		const summary = document.createElement('p');
		summary.textContent = `${entry.targets.length.toLocaleString()} loaded ${
			entry.targets.length === 1 ? 'match' : 'matches'
		}. Only the items listed here will be changed.`;
		const steps = document.createElement('ol');
		steps.className = 'github-inbox-tuner-bulk-dialog-steps';
		for (const step of entry.action.steps) {
			const item = document.createElement('li');
			item.textContent = describeBulkStep(step);
			steps.append(item);
		}
		const targets = document.createElement('ul');
		targets.className = 'github-inbox-tuner-bulk-dialog-targets';
		for (const target of entry.targets.slice(0, 25)) {
			const item = document.createElement('li');
			item.textContent = `${target.repository}#${target.number} · ${target.title}`;
			targets.append(item);
		}
		if (entry.targets.length > 25) {
			const item = document.createElement('li');
			item.textContent = `…and ${(entry.targets.length - 25).toLocaleString()} more`;
			targets.append(item);
		}
		const status = document.createElement('p');
		status.className = 'github-inbox-tuner-bulk-dialog-status';
		status.setAttribute('aria-live', 'polite');
		const actions = document.createElement('div');
		actions.className = 'github-inbox-tuner-bulk-dialog-actions';
		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', () => dialog.close());
		const applyButton = document.createElement('button');
		applyButton.className = 'github-inbox-tuner-bulk-dialog-apply';
		applyButton.type = 'button';
		applyButton.textContent = `Apply to ${entry.targets.length.toLocaleString()}`;
		let completed = false;
		applyButton.addEventListener('click', async () => {
			if (completed) {
				dialog.close();
				return;
			}
			cancel.disabled = true;
			applyButton.disabled = true;
			status.textContent = 'Applying…';
			try {
				const result = await executeBulkAction(entry, progress => {
					status.textContent = progress;
				});
				status.textContent = `${result.succeeded.toLocaleString()} succeeded${
					result.failed ? `; ${result.failed.toLocaleString()} failed` : ''
				}.`;
				completed = true;
				applyButton.textContent = 'Done';
				applyButton.disabled = false;
				setTimeout(() => apply(), 400);
			} catch (error) {
				status.textContent = error.message;
				cancel.disabled = false;
				applyButton.disabled = false;
			}
		});
		actions.append(cancel, applyButton);
		dialog.addEventListener('close', () => dialog.remove());
		dialog.append(title, summary, steps, targets, status, actions);
		document.body.append(dialog);
		dialog.showModal();
	}

	async function waitForBulkControl(predicate, timeout = 3000) {
		const startedAt = Date.now();
		while (Date.now() - startedAt < timeout) {
			const match = [...document.querySelectorAll<HTMLElement>(
				'button, summary, [role="menuitem"], [role="menuitemcheckbox"]',
			)]
				.find(element => !element.hidden && predicate(element));
			if (match) {
				return match;
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	}

	async function executeNativeListStep(step, targets) {
		for (const target of targets) {
			const checkbox = target.row.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
			if (checkbox && !checkbox.checked) {
				checkbox.click();
			}
		}
		await new Promise(resolve => setTimeout(resolve, 100));
		const labelAction = step.type.startsWith('label:');
		const triggerPattern = labelAction ? /^Labels?$/i : /^Mark as$/i;
		const trigger = [...document.querySelectorAll<HTMLElement>('.js-issue-triage-menu > summary')]
			.find(element => triggerPattern.test(element.textContent.trim()))
			?? await waitForBulkControl(element => (
				triggerPattern.test(element.textContent.trim())
				&& element.closest('.js-issue-triage-menu')
			));
		if (!trigger) {
			throw new Error('GitHub’s native bulk toolbar is not available for these loaded items');
		}
		trigger.click();
		let optionPattern;
		if (step.type === 'issue:close') {
			optionPattern = /^Closed$/i;
		} else if (step.type === 'issue:reopen' || step.type === 'pr:reopen') {
			optionPattern = /^Open$/i;
		} else if (step.type === 'pr:close') {
			optionPattern = /^Closed$/i;
		} else {
			optionPattern = new RegExp(`^${step.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
		}
		const option = await waitForBulkControl(
			element => optionPattern.test(element.textContent.trim()),
		);
		if (!option) {
			throw new Error(`GitHub did not offer “${step.value ?? describeBulkStep(step)}”`);
		}
		if (labelAction) {
			const checked = option.getAttribute('aria-checked') === 'true';
			const shouldCheck = step.type === 'label:add';
			if (checked !== shouldCheck) {
				option.click();
			}
			const applyLabels = await waitForBulkControl(
				element => /^(Apply|Save changes)$/i.test(element.textContent.trim()),
			);
			applyLabels?.click();
		} else {
			option.click();
		}
	}

	function openBulkTargets(targets) {
		for (const target of targets) {
			const link = document.createElement('a');
			link.href = target.url;
			link.rel = 'noopener';
			link.target = '_blank';
			document.body.append(link);
			link.click();
			link.remove();
		}
	}

	async function executeBulkAction(entry, onProgress) {
		const failedTargets = new Set();
		for (const [stepIndex, step] of entry.action.steps.entries()) {
			onProgress(`Step ${stepIndex + 1} of ${entry.action.steps.length}: ${describeBulkStep(step)}…`);
			if (step.type === 'open') {
				openBulkTargets(entry.targets);
				continue;
			}
			if (
				step.type.startsWith('issue:')
				|| step.type.startsWith('pr:')
				|| step.type.startsWith('label:')
			) {
				await executeNativeListStep(step, entry.targets);
				continue;
			}
			for (const target of entry.targets) {
				try {
					let control;
					if (step.type === 'notification:done') {
						control = target.row.querySelector('button[aria-label="Done"]');
					} else if (step.type === 'notification:read') {
						control = target.row.querySelector('button[aria-label="Mark as read"]');
					} else if (step.type === 'notification:unread') {
						control = target.row.querySelector('button[aria-label="Mark as unread"]');
					}
					if (step.type.startsWith('notification:')) {
						if (!control) {
							throw new Error('Notification action unavailable');
						}
						control.click();
					}
				} catch {
					failedTargets.add(target.url);
				}
			}
		}
		return {
			failed: failedTargets.size,
			succeeded: entry.targets.length - failedTargets.size,
		};
	}

	function updateRepositoryBulkActions(allRows, rows) {
		const rowsByList = new Map();
		for (const row of rows) {
			const listRows = rowsByList.get(row.parentElement) ?? [];
			listRows.push(row);
			rowsByList.set(row.parentElement, listRows);
		}
		const lists = new Set([...allRows].map(row => row.parentElement));
		for (const list of lists) {
			const repository = getNotificationRepository(list);
			const group = list.closest('.js-notifications-group')
				?? list.closest(
					'section, [data-repository-hovercards-enabled], .js-navigation-container',
				)
				?? list.parentElement;
			if (!repository || !group) {
				continue;
			}
			const existing = group.querySelector('.github-inbox-tuner-repository-bulk-actions');
			const rules = getNotificationRules(repository);
			const listRows = rowsByList.get(list) ?? [];
			const entries = rules.flatMap(rule => (rule.actions ?? []).map(action => ({
				action,
				surface: 'notifications',
				targets: listRows
					.filter(row => matchesNotificationExpression(row, rule, rules))
					.map(row => getBulkTarget(row, 'notifications'))
					.filter(Boolean),
			}))).filter(entry => entry.targets.length > 0);
			if (entries.length === 0) {
				existing?.remove();
				continue;
			}
			const nativeAction = [...group.querySelectorAll('button, a')].find(element => (
				/^(Open unread|Mark as done)$/i.test(element.textContent.trim())
			));
			const actionHost = nativeAction?.parentElement;
			if (!nativeAction || !actionHost) {
				continue;
			}
			actionHost.classList.add('github-inbox-tuner-repository-actions');
			const menu = createBulkActionsMenu(entries);
			menu.classList.add('github-inbox-tuner-repository-bulk-actions');
			existing?.replaceWith(menu);
			if (!existing) {
				actionHost.append(menu);
			}
		}
	}

	function getNotificationsGlobalListHost() {
		const notificationList = document.querySelector('.js-notifications-list')
			?? document.querySelector('.notifications-list-item')?.parentElement;
		if (!notificationList) {
			return;
		}

		const contentColumn = document.querySelector('.js-check-all-container');
		let globalListHost = notificationList;
		while (
			contentColumn
			&& globalListHost.parentElement
			&& globalListHost.parentElement !== contentColumn
		) {
			globalListHost = globalListHost.parentElement;
		}
		return globalListHost;
	}

	function clone(value) {
		return JSON.parse(JSON.stringify(value));
	}

	function isSame(left, right) {
		return JSON.stringify(left) === JSON.stringify(right);
	}

	function getSurfaceConfig(surface, repository) {
		if (surface === 'notifications') {
			return {
				defaultViewId: getDefaultViewId(surface, repository),
				rules: clone(getNotificationRules(repository)),
			};
		}
		return {
			defaultViewId: getDefaultViewId(surface, repository),
			views: clone(getViews(surface, repository)),
		};
	}

	function getGlobalSurfaceConfig(surface) {
		const override = options.viewOverrides?.[surface];
		if (surface === 'notifications') {
			return Array.isArray(override?.rules) && override.rules.length > 0
				? clone(override)
				: {
					defaultViewId: dsl.builtInDefaultViewIds.notifications,
					rules: clone(builtInNotificationRules),
				};
		}
		return override?.views?.length > 0
			? clone(override)
			: {
				defaultViewId: dsl.builtInDefaultViewIds[surface],
				views: clone(builtInViews[surface]),
			};
	}

	function getOwnerSurfaceConfig(surface: Surface, owner?: string) {
		const override = options.ownerViewOverrides?.[owner]?.[surface];
		if (surface === 'notifications') {
			return Array.isArray(override?.rules) && override.rules.length > 0
				? clone(override)
				: getGlobalSurfaceConfig(surface);
		}
		return override?.views?.length > 0
			? clone(override)
			: getGlobalSurfaceConfig(surface);
	}

	function getInlineEditorAnchor(surface, repository): HTMLElement | null {
		if (!repository) {
			return document.querySelector<HTMLElement>('#github-inbox-tuner-views');
		}
		if (surface === 'notifications') {
			for (const list of document.querySelectorAll<HTMLElement>('.js-notifications-list')) {
				if (getNotificationRepository(list) === repository) {
					return list;
				}
			}
		}
		return document.querySelector<HTMLElement>('#github-inbox-tuner-views');
	}

	function createInlineEditorHelp(surface) {
		const help = document.createElement('aside');
		help.id = 'github-inbox-tuner-editor-help';
		help.className = 'github-inbox-tuner-editor-help';
		help.hidden = true;
		const title = document.createElement('strong');
		title.textContent = surface === 'notifications'
			? 'Notification rule syntax'
			: `${surface === 'pulls' ? 'Pull request' : 'Issue'} view syntax`;
		const introduction = document.createElement('p');
		introduction.textContent = surface === 'notifications'
			? 'Each item is a named rule. A rule can become a view chip, a filtered-reason pill, a reusable helper, or any combination of those.'
			: 'The filter is sent directly to GitHub, so use the same qualifiers as GitHub’s issue and pull-request search.';
		const concepts = document.createElement('ul');
		const entries = surface === 'notifications'
			? [
				['rule:rule-id', 'Reuse another named rule. Rule IDs must be unique and cannot form cycles.'],
				['AND · OR · NOT · ( )', 'Combine conditions explicitly. Whitespace also means AND, and -condition is shorthand for NOT condition.'],
				['repo: · org: · author: · reason:', 'Match notification metadata. Use author:@me for your own pull requests.'],
				['is: · draft: · conflict: · status: · label: · bot:', 'Match item type, draft state, merge conflicts, checks, labels, or bot activity. Quote labels containing spaces.'],
				['title:/pattern/i', 'Match notification titles with a regular expression.'],
				['Default view', 'Controls the initial view, the global notification indicator, and the live new-notification banner.'],
				['View chip / Filtered reason', 'A view chip selects matching rows; a filtered-reason rule creates a pill that can reveal rows it excluded.'],
			]
			: surface === 'pulls'
				? [
				['is:open', 'Limit the view to open items. Add is:pr or is:issue to specify the item type.'],
				['author:@me · assignee:@me', 'Match items created by or assigned to you.'],
				['label:name · -label:name', 'Include or exclude labels. Quote labels containing spaces.'],
				['user-review-requested:@me', 'Match pull requests waiting for your review.'],
				['status:failure · draft:false', 'Match failing checks or ready-for-review pull requests.'],
				['Default view', 'Controls which saved filter GitHub opens with on this surface.'],
				]
				: [
					['is:open is:issue', 'Limit the view to open issues.'],
					['author:@me · assignee:@me', 'Match issues created by or assigned to you.'],
					['mentions:@me', 'Match issues that mention you.'],
					['label:name · -label:name', 'Include or exclude labels. Quote labels containing spaces.'],
					['no:label', 'Match issues that have not been labeled yet.'],
					['Default view', 'Controls which saved filter GitHub opens with on this surface.'],
				];
		for (const [syntax, explanation] of entries) {
			const item = document.createElement('li');
			const code = document.createElement('code');
			code.textContent = syntax;
			item.append(code, document.createTextNode(` — ${explanation}`));
			concepts.append(item);
		}
		const exampleLabel = document.createElement('p');
		exampleLabel.textContent = 'Example';
		const example = document.createElement('pre');
		const exampleCode = document.createElement('code');
		exampleCode.textContent = surface === 'notifications'
			? `rule:direct-mention OR (
  NOT rule:draft
  AND NOT rule:other-pending
  AND NOT rule:release-pr
)`
			: surface === 'pulls'
				? 'is:open is:pr draft:false -label:release'
				: 'is:open is:issue assignee:@me -label:wontfix';
		example.append(exampleCode);
		help.append(title, introduction, concepts, exampleLabel, example);
		return help;
	}

	function newBulkAction(surface) {
		const definition = dsl.getBulkActionTypes(surface)[0];
		return {
			id: `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
			label: definition?.label ?? 'Bulk action',
			steps: definition ? [{type: definition.type}] : [],
		};
	}

	function createInlineBulkActionsEditor(surface, item, render) {
		const section = document.createElement('section');
		section.className = 'github-inbox-tuner-bulk-actions-editor';
		const heading = document.createElement('div');
		heading.className = 'github-inbox-tuner-bulk-actions-heading';
		const title = document.createElement('strong');
		title.textContent = 'Bulk actions';
		const addAction = document.createElement('button');
		addAction.type = 'button';
		addAction.textContent = 'Add action';
		addAction.addEventListener('click', () => {
			item.actions ??= [];
			item.actions.push(newBulkAction(surface));
			render();
		});
		heading.append(title, addAction);
		const help = document.createElement('p');
		help.textContent = 'Actions are always previewed before changing matching items.';
		const list = document.createElement('div');
		list.className = 'github-inbox-tuner-bulk-actions-list';
		const definitions = dsl.getBulkActionTypes(surface);
		for (const [actionIndex, action] of (item.actions ?? []).entries()) {
			const card = document.createElement('div');
			card.className = 'github-inbox-tuner-bulk-action-card';
			const actionHeader = document.createElement('div');
			actionHeader.className = 'github-inbox-tuner-bulk-action-header';
			const label = document.createElement('input');
			label.type = 'text';
			label.value = action.label;
			label.setAttribute('aria-label', 'Bulk action name');
			label.addEventListener('input', () => {
				action.label = label.value;
			});
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.textContent = '×';
			remove.title = 'Remove bulk action';
			remove.addEventListener('click', () => {
				item.actions.splice(actionIndex, 1);
				render();
			});
			actionHeader.append(label, remove);
			const steps = document.createElement('div');
			steps.className = 'github-inbox-tuner-bulk-action-steps';
			for (const [stepIndex, step] of action.steps.entries()) {
				const row = document.createElement('div');
				row.className = 'github-inbox-tuner-bulk-action-step';
				const select = document.createElement('select');
				select.setAttribute('aria-label', 'Bulk action operation');
				for (const definition of definitions) {
					select.append(new Option(definition.label, definition.type));
				}
				select.value = step.type;
				select.addEventListener('change', () => {
					action.steps[stepIndex] = {type: select.value};
					render();
				});
				row.append(select);
				const definition = definitions.find(candidate => candidate.type === step.type);
				if (definition?.needsValue) {
					const value = document.createElement('input');
					value.type = 'text';
					value.value = step.value ?? '';
					value.placeholder = 'Label name';
					value.setAttribute('aria-label', `${definition.label} value`);
					value.addEventListener('input', () => {
						step.value = value.value;
					});
					row.append(value);
				}
				const removeStep = document.createElement('button');
				removeStep.type = 'button';
				removeStep.textContent = '×';
				removeStep.title = 'Remove step';
				removeStep.disabled = action.steps.length === 1;
				removeStep.addEventListener('click', () => {
					action.steps.splice(stepIndex, 1);
					render();
				});
				row.append(removeStep);
				steps.append(row);
			}
			const addStep = document.createElement('button');
			addStep.type = 'button';
			addStep.textContent = 'Add step';
			addStep.addEventListener('click', () => {
				action.steps.push({type: definitions[0].type});
				render();
			});
			card.append(actionHeader, steps, addStep);
			list.append(card);
		}
		section.append(heading, help, list);
		return section;
	}

	function openInlineViewEditor(
		surface: Surface,
		repository?: string,
		explicitAnchor?: HTMLElement,
	) {
		const existing = document.querySelector('#github-inbox-tuner-inline-editor');
		existing?.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();

		const anchor = explicitAnchor ?? getInlineEditorAnchor(surface, repository);
		if (!anchor) {
			return;
		}

		const hiddenBar = anchor.id === 'github-inbox-tuner-views' ? anchor : undefined;
		if (hiddenBar) {
			hiddenBar.hidden = true;
		}

		const inheritedConfig = repository
			? getOwnerSurfaceConfig(surface, getOwner(repository))
			: surface === 'notifications'
				? {
					defaultViewId: dsl.builtInDefaultViewIds.notifications,
					rules: clone(builtInNotificationRules),
				}
				: {
				defaultViewId: dsl.builtInDefaultViewIds[surface],
				views: clone(builtInViews[surface]),
				};
		let value = getSurfaceConfig(surface, repository);
		const getItems = () => surface === 'notifications' ? value.rules : value.views;
		let selectedId = value.defaultViewId ?? getItems()[0]?.id;
		const panel = document.createElement('section');
		panel.id = 'github-inbox-tuner-inline-editor';
		panel.dataset.repository = repository ?? '';
		panel.dataset.surface = surface;

		const heading = document.createElement('div');
		heading.className = 'github-inbox-tuner-editor-heading';
		const title = document.createElement('strong');
		const surfaceLabel = surface === 'pulls'
			? 'pull request'
			: surface === 'issues'
				? 'issue'
				: 'notification';
		title.textContent = `Edit ${repository ? `${repository} ` : 'global '}${surfaceLabel} views`;
		const status = document.createElement('span');
		status.className = 'github-inbox-tuner-editor-status';
		status.setAttribute('aria-live', 'polite');
		const help = createInlineEditorHelp(surface);
		const helpToggle = document.createElement('button');
		helpToggle.type = 'button';
		helpToggle.textContent = 'Help';
		helpToggle.setAttribute('aria-controls', help.id);
		helpToggle.setAttribute('aria-expanded', 'false');
		helpToggle.addEventListener('click', () => {
			help.hidden = !help.hidden;
			helpToggle.setAttribute('aria-expanded', String(!help.hidden));
			helpToggle.textContent = help.hidden ? 'Help' : 'Hide help';
		});
		const headingActions = document.createElement('div');
		headingActions.className = 'github-inbox-tuner-editor-heading-actions';
		headingActions.append(status, helpToggle);
		heading.append(title, headingActions);

		const workspace = document.createElement('div');
		workspace.className = 'github-inbox-tuner-editor-workspace';
		const list = document.createElement('div');
		list.className = 'github-inbox-tuner-editor-list';
		const detail = document.createElement('div');
		detail.className = 'github-inbox-tuner-editor-detail';
		workspace.append(list, detail);

		const getSelected = () => (
			getItems().find(item => item.id === selectedId) ?? getItems()[0]
		);
		const ensureDefault = () => {
			const visibleItems = surface === 'notifications'
				? getItems().filter(item => item.showAsView)
				: getItems();
			if (!visibleItems.some(item => item.id === value.defaultViewId)) {
				value.defaultViewId = visibleItems[0]?.id;
			}
		};
		const render = () => {
			const items = getItems();
			const selected = getSelected();
			selectedId = selected?.id;
			list.replaceChildren(...items.map((item, index) => {
				const row = document.createElement('div');
				row.className = 'github-inbox-tuner-editor-master-row';
				row.classList.toggle(
					'github-inbox-tuner-editor-master-row--selected',
					item.id === selectedId,
				);

				const select = document.createElement('button');
				select.className = 'github-inbox-tuner-editor-master-select';
				select.type = 'button';
				const itemName = document.createElement('span');
				itemName.className = 'github-inbox-tuner-editor-master-name';
				itemName.textContent = item.label || 'Untitled';
				const meta = document.createElement('span');
				meta.className = 'github-inbox-tuner-editor-master-meta';
				const tags = [];
				if (value.defaultViewId === item.id) {
					tags.push('Default');
				}
				if (surface === 'notifications') {
					if (item.showAsView) {
						tags.push('View chip');
					}
					if (item.showAsReason) {
						tags.push('Filtered reason');
					}
					if (!item.showAsView && !item.showAsReason) {
						tags.push('Helper rule');
					}
				}
				if (item.actions?.length) {
					tags.push(`${item.actions.length} bulk ${item.actions.length === 1 ? 'action' : 'actions'}`);
				}
				meta.textContent = tags.join(' · ') || 'View';
				select.append(itemName, meta);
				select.addEventListener('click', () => {
					selectedId = item.id;
					render();
				});

				const controls = document.createElement('div');
				controls.className = 'github-inbox-tuner-editor-controls';
				for (const [label, labelText, disabled, handler] of ([
					['↑', 'Move up', index === 0, () => {
						[items[index - 1], items[index]] = [items[index], items[index - 1]];
						render();
					}],
					['↓', 'Move down', index === items.length - 1, () => {
						[items[index + 1], items[index]] = [items[index], items[index + 1]];
						render();
					}],
					['×', 'Delete', items.length === 1, () => {
						items.splice(index, 1);
						selectedId = items[Math.min(index, items.length - 1)]?.id;
						ensureDefault();
						render();
					}],
				] as Array<[string, string, boolean, () => void]>)) {
					const button = document.createElement('button');
					button.type = 'button';
					button.textContent = label;
					button.title = labelText;
					button.disabled = disabled;
					button.addEventListener('click', handler);
					controls.append(button);
				}
				row.append(select, controls);
				return row;
			}));

			detail.replaceChildren();
			if (!selected) {
				return;
			}
			const detailTitle = document.createElement('strong');
			detailTitle.textContent = `Editing: ${selected.label || 'Untitled'}`;
			let idLabel;
			if (surface === 'notifications') {
				idLabel = document.createElement('label');
				idLabel.className = 'github-inbox-tuner-editor-field';
				idLabel.append(document.createTextNode('Rule ID'));
				const id = document.createElement('input');
				id.className = 'github-inbox-tuner-editor-name';
				id.type = 'text';
				id.value = selected.id;
				id.setAttribute('aria-label', 'Rule ID');
				id.addEventListener('change', () => {
					const nextId = id.value.trim().toLowerCase();
					if (!/^[a-z0-9][a-z0-9-]*$/.test(nextId)) {
						status.textContent = 'Rule IDs use lowercase letters, numbers, and hyphens';
						id.value = selected.id;
						return;
					}
					if (value.rules.some(rule => rule !== selected && rule.id === nextId)) {
						status.textContent = `rule:${nextId} already exists`;
						id.value = selected.id;
						return;
					}
					const previousId = selected.id;
					for (const rule of value.rules) {
						rule.dsl = rule.dsl.replace(
							new RegExp(`\\brule:${previousId}(?![a-z0-9-])`, 'gi'),
							`rule:${nextId}`,
						);
					}
					selected.id = nextId;
					if (value.defaultViewId === previousId) {
						value.defaultViewId = nextId;
					}
					selectedId = nextId;
					render();
				});
				idLabel.append(id);
			}
			const nameLabel = document.createElement('label');
			nameLabel.className = 'github-inbox-tuner-editor-field';
			nameLabel.append(document.createTextNode('Name'));
			const name = document.createElement('input');
			name.className = 'github-inbox-tuner-editor-name';
			name.type = 'text';
			name.value = selected.label;
			name.setAttribute('aria-label', 'View name');
			name.addEventListener('input', () => {
				selected.label = name.value;
				detailTitle.textContent = `Editing: ${selected.label || 'Untitled'}`;
				renderMasterSummary();
			});
			nameLabel.append(name);

			const expressionLabel = document.createElement('label');
			expressionLabel.className = 'github-inbox-tuner-editor-field';
			expressionLabel.append(document.createTextNode(
				surface === 'notifications' ? 'Rule DSL' : 'View filter',
			));
			const expression = document.createElement('textarea');
			expression.className = 'github-inbox-tuner-editor-dsl';
			expression.value = selected.dsl;
			expression.rows = Math.min(10, Math.max(3, selected.dsl.split('\n').length));
			expression.spellcheck = false;
			expression.setAttribute('aria-label', 'View DSL');
			expression.addEventListener('input', () => {
				selected.dsl = expression.value;
				expression.rows = Math.min(
					10,
					Math.max(3, expression.value.split('\n').length),
				);
			});
			expressionLabel.append(expression);

			const choices = document.createElement('div');
			choices.className = 'github-inbox-tuner-editor-choices';
			const defaultLabel = document.createElement('label');
			const radio = document.createElement('input');
			radio.type = 'radio';
			radio.name = 'github-inbox-tuner-inline-default';
			radio.checked = value.defaultViewId === selected.id;
			radio.disabled = surface === 'notifications' && !selected.showAsView;
			radio.addEventListener('change', () => {
				value.defaultViewId = selected.id;
				render();
			});
			defaultLabel.append(radio, document.createTextNode('Default view'));
			choices.append(defaultLabel);

			if (surface === 'notifications') {
				for (const [key, text] of [
					['showAsView', 'Show as view chip'],
					['showAsReason', 'Use as filtered-reason pill'],
				]) {
					const label = document.createElement('label');
					const checkbox = document.createElement('input');
					checkbox.type = 'checkbox';
					checkbox.checked = Boolean(selected[key]);
					checkbox.addEventListener('change', () => {
						if (
							key === 'showAsView'
							&& !checkbox.checked
							&& getItems().filter(item => item.showAsView).length === 1
						) {
							checkbox.checked = true;
							status.textContent = 'At least one rule must be a view chip';
							return;
						}
						selected[key] = checkbox.checked;
						ensureDefault();
						render();
					});
					label.append(checkbox, document.createTextNode(text));
					choices.append(label);
				}
			}
			detail.append(
				detailTitle,
				...(idLabel ? [idLabel] : []),
				nameLabel,
				expressionLabel,
				choices,
				createInlineBulkActionsEditor(surface, selected, render),
			);
		};
		const renderMasterSummary = () => {
			for (const [index, row] of [...list.children].entries()) {
				row.querySelector('.github-inbox-tuner-editor-master-name').textContent
					= getItems()[index].label || 'Untitled';
			}
		};

		const actions = document.createElement('div');
		actions.className = 'github-inbox-tuner-editor-actions';
		const restore = document.createElement('button');
		restore.type = 'button';
		const inheritedScopeLabel = repository
			&& options.ownerViewOverrides?.[getOwner(repository)]?.[surface]
			? `${getOwner(repository)} filters`
			: 'global filters';
		restore.textContent = repository ? `Use ${inheritedScopeLabel}` : 'Restore defaults';
		restore.addEventListener('click', () => {
			value = clone(inheritedConfig);
			selectedId = value.defaultViewId;
			status.textContent = repository
				? `Using ${inheritedScopeLabel} after save`
				: 'Defaults restored';
			render();
		});
		const add = document.createElement('button');
		add.type = 'button';
		add.textContent = surface === 'notifications' ? 'Add rule' : 'Add view';
		add.addEventListener('click', () => {
			const item: NotificationRule = {
				id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
				label: surface === 'notifications' ? 'New rule' : 'New view',
				dsl: surface === 'notifications'
					? 'is:any'
					: `is:open is:${surface === 'pulls' ? 'pr' : 'issue'}`,
			};
			if (surface === 'notifications') {
				item.showAsView = false;
				item.showAsReason = true;
			}
			getItems().push(item);
			selectedId = item.id;
			render();
		});
		const cancel = document.createElement('button');
		cancel.dataset.action = 'cancel';
		cancel.type = 'button';
		cancel.textContent = 'Cancel';
		cancel.addEventListener('click', () => {
			panel.remove();
			if (hiddenBar) {
				hiddenBar.hidden = false;
			}
		});
		const save = document.createElement('button');
		save.className = 'github-inbox-tuner-editor-save';
		save.type = 'button';
		save.textContent = 'Save';
		save.addEventListener('click', async () => {
			try {
				for (const item of getItems()) {
					item.label = item.label.trim();
					item.dsl = item.dsl.trim();
					if (!item.label || !item.dsl) {
						throw new Error('Every view needs a name and filter');
					}
					if (surface === 'notifications') {
						dsl.parseNotificationDsl(item.dsl);
					}
				}
				if (
					surface === 'notifications'
					&& !value.rules.some(rule => rule.showAsView)
				) {
					throw new Error('At least one rule must be a view chip');
				}
				if (surface === 'notifications') {
					dsl.validateNotificationRules(value.rules);
				}
				dsl.validateBulkActions(getItems(), surface);

				const viewOverrides = clone(options.viewOverrides ?? {});
				const repositoryViewOverrides = clone(options.repositoryViewOverrides ?? {});
				if (repository) {
					if (isSame(value, inheritedConfig)) {
						delete repositoryViewOverrides[repository]?.[surface];
						if (Object.keys(repositoryViewOverrides[repository] ?? {}).length === 0) {
							delete repositoryViewOverrides[repository];
						}
					} else {
						repositoryViewOverrides[repository] ??= {};
						repositoryViewOverrides[repository][surface] = clone(value);
					}
				} else if (isSame(value, inheritedConfig)) {
					delete viewOverrides[surface];
				} else {
					viewOverrides[surface] = clone(value);
				}

				await chrome.storage.sync.set({repositoryViewOverrides, viewOverrides});
				options = {...options, repositoryViewOverrides, viewOverrides};
				activeNotificationView = getDefaultViewId('notifications');
				notificationViewExplicitlySelected = false;
				notificationDslCache.clear();
				cancel.click();
				apply();
			} catch (error) {
				status.textContent = error.message;
			}
		});
		actions.append(restore, add, cancel, save);
		panel.append(heading, help, workspace, actions);
		anchor.before(panel);
		render();
		panel.scrollIntoView?.({block: 'nearest'});
	}

	function normalizeQuery(query) {
		return query
			.trim()
			.split(/\s+/)
			.filter(token => !token.startsWith('sort:'))
			.sort()
			.join(' ');
	}

	function buildViewUrl(query) {
		const url = new URL(location.href);
		url.search = '';
		url.searchParams.set('q', query);
		return url.href;
	}

	function getQueryPageAnchor() {
		const searchInput = document.querySelector('main #js-issues-search')
			?? document.querySelector('main input[name="q"][aria-label*="Search"]')
			?? document.querySelector('main #repository-input[placeholder="Search Issues"]');
		const issueSearchForm = searchInput?.closest('[role="form"][aria-label="Search Issues"]');
		const searchForm = searchInput?.closest('form[role="search"]');
		return issueSearchForm ?? searchForm?.parentElement?.parentElement ?? searchForm;
	}

	function getActiveQueryView(surface: Surface) {
		const query = new URL(location.href).searchParams.get('q')
			?? document.querySelector<HTMLInputElement>('main input[name="q"]')?.value
			?? '';
		const normalized = normalizeQuery(query);
		return getViews(surface).find(view => normalizeQuery(view.dsl) === normalized)?.id;
	}

	function createViewChip(surface: Surface, view: ViewDefinition, defaultViewId: string) {
		const isNotifications = surface === 'notifications';
		const chip = document.createElement(isNotifications ? 'button' : 'a');
		chip.className = 'github-inbox-tuner-view-chip';
		chip.dataset.viewId = view.id;
		chip.title = view.id === defaultViewId ? `${view.label} · Default view` : view.label;

		if (isNotifications) {
			chip.type = 'button';
			chip.addEventListener('click', () => {
				activeNotificationView = view.id;
				notificationViewExplicitlySelected = true;
				revealedFilterReasonsByList = new WeakMap();
				updateNotificationVisibility();
			});
		} else {
			(chip as HTMLAnchorElement).href = buildViewUrl(view.dsl);
		}

		const label = document.createElement('span');
		label.textContent = view.label;
		const count = document.createElement('span');
		count.className = 'github-inbox-tuner-view-count';
		count.textContent = '…';
		chip.append(label, count);
		return chip;
	}

	function createEditAction(surface: Surface) {
		const element = document.createElement('button');
		element.className = 'github-inbox-tuner-view-action';
		element.dataset.action = 'edit';
		element.textContent = 'Edit views';
		element.type = 'button';
		element.title = 'Customize saved views';
		element.addEventListener('click', () => {
			openInlineViewEditor(
				surface,
				surface === 'notifications' ? undefined : getCurrentRepository(),
			);
		});
		return element;
	}

	function updateViewChipCount(chip: HTMLElement | null, count, activeViewId) {
		if (!chip) {
			return;
		}
		const countElement = chip.querySelector('.github-inbox-tuner-view-count');
		if (countElement) {
			countElement.textContent = Number.isFinite(count)
				? count.toLocaleString()
				: '–';
		}
		chip.hidden = count === 0 && chip.dataset.viewId !== activeViewId;
	}

	function fitViewBar(bar, force = false) {
		bar.style.removeProperty('max-width');
		const width = bar.clientWidth;
		if (!width || (!force && bar.dataset.layoutWidth === String(width))) {
			return;
		}
		bar.dataset.layoutWidth = String(width);
		bar.classList.remove(
			'github-inbox-tuner-views--compact',
		);
		bar.classList.add('github-inbox-tuner-views--wrapped');
		const edit = bar.querySelector('[data-action="edit"]');
		if (edit && edit.textContent !== 'Edit views') {
			edit.textContent = 'Edit views';
		}
	}

	function observeViewBar(bar) {
		if (!globalThis.ResizeObserver) {
			return;
		}
		viewBarResizeObserver ??= new ResizeObserver(entries => {
			for (const entry of entries) {
				fitViewBar(entry.target);
			}
		});
		viewBarResizeObserver.observe(bar);
	}

	function updateViewBulkActions(bar, surface, activeViewId) {
		bar.querySelector('.github-inbox-tuner-view-bulk-actions')?.remove();
		const view = getViews(surface).find(candidate => candidate.id === activeViewId);
		if (!view?.actions?.length) {
			return;
		}
		const targets = surface === 'notifications'
			? filterNotificationRowsForFolder(
				document.querySelectorAll('.notifications-list-item'),
				showsArchivedNotifications(),
			)
				.filter(row => matchesNotificationExpression(
					row,
					view,
					getNotificationRules(getNotificationRepository(row)),
				))
				.map(row => getBulkTarget(row, surface))
				.filter(Boolean)
			: getListBulkTargets(surface);
		if (targets.length === 0) {
			return;
		}
		const menu = createBulkActionsMenu(
			view.actions.map(action => ({action, surface, targets})),
		);
		menu.classList.add('github-inbox-tuner-view-bulk-actions');
		const edit = bar.querySelector('[data-action="edit"]');
		edit?.before(menu);
	}

	function updateViewBar(surface: Surface) {
		if (surface !== getSurface()) {
			return;
		}

		let bar = document.querySelector<HTMLElement>('#github-inbox-tuner-views');
		if (!bar) {
			bar = document.createElement('nav');
			bar.id = 'github-inbox-tuner-views';
			bar.setAttribute('aria-label', `${surface === 'pulls' ? 'Pull request' : surface} saved views`);
			if (surface === 'notifications') {
				const globalListHost = getNotificationsGlobalListHost();
				if (!globalListHost) {
					return;
				}
				globalListHost.before(bar);
			} else {
				const anchor = getQueryPageAnchor();
				if (!anchor) {
					return;
				}
				anchor.after(bar);
			}
			observeViewBar(bar);
		}

		const defaultViewId = getDefaultViewId(surface);
		const surfaceViews = getViews(surface);
		const defaultView = surfaceViews.find(view => view.id === defaultViewId) ?? surfaceViews[0];
		const signature = JSON.stringify({surface, defaultViewId: defaultView.id, surfaceViews});
		if (bar.dataset.signature !== signature) {
			bar.dataset.surface = surface;
			bar.dataset.signature = signature;
			bar.replaceChildren(
				...surfaceViews.map(view => createViewChip(surface, view, defaultView.id)),
				createEditAction(surface),
			);
			fitViewBar(bar, true);
		}

		const activeViewId = (surface === 'notifications'
			? activeNotificationView
			: getActiveQueryView(surface)) ?? defaultView.id;
		for (const chip of bar.querySelectorAll<HTMLElement>('.github-inbox-tuner-view-chip')) {
			const active = chip.dataset.viewId === activeViewId;
			chip.classList.toggle('github-inbox-tuner-view-chip--active', active);
			if (active) {
				chip.setAttribute('aria-current', 'page');
			} else {
				chip.removeAttribute('aria-current');
			}
		}
		updateViewBulkActions(bar, surface, activeViewId);
		if (surface === 'notifications') {
			const rows = filterNotificationRowsForFolder(
				document.querySelectorAll('.notifications-list-item'),
				showsArchivedNotifications(),
			);
			for (const view of surfaceViews) {
				const count = rows.filter(row => matchesNotificationView(row, view.id)).length;
				updateViewChipCount(
					bar.querySelector(`[data-view-id="${view.id}"]`),
					count,
					activeViewId,
				);
			}
			fitViewBar(bar, true);
		} else {
			scheduleQueryViewCounts(surface);
		}
	}

	async function fetchQueryCount(surface, query) {
		const cacheKey = `${location.pathname}|${surface}|${normalizeQuery(query)}`;
		const cached = queryCountCache.get(cacheKey);
		if (cached && Date.now() - cached.updatedAt < 5 * 60 * 1000) {
			return cached.count;
		}

		const repository = getCurrentRepository();
		const scopedQuery = repository && !/(?:^|\s)repo:/i.test(query)
			? `${query} repo:${repository}`
			: query;
		const url = new URL('/search/count', location.origin);
		url.searchParams.set('q', scopedQuery);
		url.searchParams.set('type', 'issues');
		const response = await fetch(url, {credentials: 'same-origin'});
		if (!response.ok) {
			return;
		}

		const responseText = await response.text();
		const text = new DOMParser()
			.parseFromString(responseText, 'text/html')
			.querySelector('[data-search-type="Issues"]')
			?.textContent.trim();
		const count = text ? Number(text.replaceAll(',', '')) : undefined;
		queryCountCache.set(cacheKey, {count, updatedAt: Date.now()});
		return count;
	}

	function scheduleQueryViewCounts(surface: Surface) {
		clearTimeout(viewCountRefresh);
		viewCountRefresh = setTimeout(async () => {
			const counts = await Promise.all(
				getViews(surface).map(view => fetchQueryCount(surface, view.dsl)),
			);
			const bar = document.querySelector(`#github-inbox-tuner-views[data-surface="${surface}"]`);
			if (!bar) {
				return;
			}

			const activeViewId = getActiveQueryView(surface) ?? getDefaultViewId(surface);
			for (const [index, view] of getViews(surface).entries()) {
				updateViewChipCount(
					bar.querySelector(`[data-view-id="${view.id}"]`),
					counts[index],
					activeViewId,
				);
			}
			fitViewBar(bar, true);
		}, 300);
	}

	function redirectToDefaultView(surface: Surface) {
		if (
			!['pulls', 'issues'].includes(surface)
			|| !getCurrentRepository()
			|| new URL(location.href).searchParams.has('q')
		) {
			return false;
		}

		const view = getViews(surface).find(candidate => candidate.id === getDefaultViewId(surface))
			?? getViews(surface)[0];
		if (!view) {
			return false;
		}

		const url = new URL(location.href);
		url.searchParams.set('q', view.dsl);
		location.replace(url);
		return true;
	}

	function apply() {
		if (!optionsLoaded) {
			return;
		}
		const surface = getSurface();
		scheduleHeaderSettingsButton();
		scheduleGlobalIndicatorRefresh();
		const existingBar = document.querySelector('#github-inbox-tuner-views');
		if (existingBar) {
			viewBarResizeObserver?.unobserve(existingBar);
			existingBar.remove();
		}
		if (surface === 'notifications') {
			updateNotificationVisibility();
			return;
		}

		if (surface) {
			if (redirectToDefaultView(surface)) {
				return;
			}
			updateViewBar(surface);
			scheduleQueryListCollapseRefresh(surface);
		}
	}

	async function loadOptions() {
		const cacheHydration = Promise.all([
			hydratePullRequestChecksCache(),
			hydratePullRequestLabelsCache(),
			hydratePullRequestMetadataCache(),
		]);
		const storedOptions = await chrome.storage.sync.get(Object.keys(defaults));
		options = {...defaults, ...storedOptions};
		builtInNotificationRules = dsl.cloneBuiltInNotificationRules();
		builtInViews = dsl.cloneBuiltInViews();
		activeNotificationView = getDefaultViewId('notifications');
		notificationViewExplicitlySelected = false;
		optionsLoaded = true;
		const surface = getSurface();
		const redirecting = surface ? redirectToDefaultView(surface) : false;
		await cacheHydration;
		if (!redirecting) {
			apply();
		}
	}

	for (const eventName of ['DOMContentLoaded', 'turbo:load', 'turbo:render', 'soft-nav:end']) {
		document.addEventListener(eventName, apply);
	}
	document.addEventListener('click', event => {
		const button = event.target instanceof Element
			? event.target.closest('.github-inbox-tuner-settings-button')
			: undefined;
		if (!button) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		void chrome.runtime.sendMessage({type: 'open-options'});
	}, true);
	document.addEventListener('click', event => {
		if (!isNotificationsPage() || !(event.target instanceof Element)) {
			return;
		}
		const control = event.target.closest(
			'button[aria-label="Done"], '
			+ '.js-grouped-notifications-mark-all-read-button button',
		);
		if (
			!control
			|| (
				control.getAttribute('aria-label') !== 'Done'
				&& !/^(Mark as done|Open unread)$/i.test(control.textContent.trim())
			)
		) {
			return;
		}
		scheduleNotificationViewRefresh(750);
	}, true);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') {
			scheduleGlobalIndicatorRefresh();
		}
	});

	const observer = new MutationObserver(mutations => {
		const childListMutations = mutations.filter(
			mutation => mutation.type === 'childList',
		);
		if (childListMutations.length > 0) {
			headerSettingsController.handleMutation();
		}
		const onlyExtensionControlsChanged = childListMutations.length > 0
			&& childListMutations.every(mutation => (
			[...mutation.addedNodes, ...mutation.removedNodes].every(node => (
				!(node instanceof Element)
					|| node.classList.contains('github-inbox-tuner-collapse-toggle')
					|| node.classList.contains('github-inbox-tuner-collapse-chevron')
					|| node.classList.contains('github-inbox-tuner-loading-more')
					|| node.classList.contains('github-inbox-tuner-view-bulk-actions')
					|| node.classList.contains('github-inbox-tuner-repository-bulk-actions')
					|| node.classList.contains('github-inbox-tuner-bulk-dialog')
			))
			));

		const globalNotificationLink = getGlobalNotificationLink();
		if (mutations.some(mutation => (
			mutation.type === 'attributes'
				&& mutation.attributeName === 'class'
				&& mutation.target === globalNotificationLink
		))) {
			scheduleGlobalIndicatorRefresh(true);
		}

		const notificationStateChanged = mutations.some(mutation => {
			if (
				mutation.type !== 'attributes'
				|| mutation.attributeName !== 'class'
				|| !(mutation.target instanceof Element)
				|| !mutation.target.matches('.notifications-list-item')
			) {
				return false;
			}
			const target = mutation.target;
			const oldClasses = new Set((mutation.oldValue ?? '').split(/\s+/));
			return ['notification-archived', 'notification-unread'].some(
				className => oldClasses.has(className)
					!== target.classList.contains(className),
			);
		});
		if (notificationStateChanged) {
			scheduleNotificationViewRefresh();
		}

		if (childListMutations.length === 0 || onlyExtensionControlsChanged) {
			return;
		}

		if (isNotificationsPage()) {
			updateNotificationVisibility();
			return;
		}

		const surface = getSurface();
		if (surface) {
			if (!document.querySelector('#github-inbox-tuner-views')) {
				updateViewBar(surface);
			}
			scheduleQueryListCollapseRefresh(surface);
		}
	});
	observer.observe(document, {
		attributeFilter: ['class'],
		attributeOldValue: true,
		attributes: true,
		childList: true,
		subtree: true,
	});

	chrome.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== 'sync') {
			return;
		}

		for (const key of Object.keys(defaults)) {
			if (changes[key]) {
				options = {...options, [key]: changes[key].newValue};
			}
		}
		builtInNotificationRules = dsl.cloneBuiltInNotificationRules();
		builtInViews = dsl.cloneBuiltInViews();

		if (
			changes.viewOverrides
			|| changes.ownerViewOverrides
			|| changes.repositoryViewOverrides
		) {
			activeNotificationView = getDefaultViewId('notifications');
			notificationViewExplicitlySelected = false;
			notificationDslCache.clear();
		}
		apply();
	});

	void loadOptions();
})();
