(() => {
	'use strict';

	const dsl = globalThis.GitHubInboxTunerDsl;
	let builtInNotificationRules;
	let builtInViews;
	const defaults = {
		collapseDependencyUpdates: true,
		collapseSameAuthorNotifications: false,
		dimBotNotifications: true,
		showHeaderSettingsButton: true,
		ownerViewOverrides: {},
		repositoryViewOverrides: {},
		viewOverrides: {},
	};
	builtInNotificationRules = dsl.cloneBuiltInNotificationRules();
	builtInViews = dsl.cloneBuiltInViews();

	let options = defaults;
	let activeNotificationView;
	let notificationViewExplicitlySelected = false;
	let revealedFilterReasonsByList = new WeakMap();
	let redirectAttempt;
	let failedChecksRefresh;
	let globalIndicatorRefresh;
	let globalIndicatorRefreshInFlight;
	let globalIndicatorUpdatedAt = 0;
	let headerSettingsRefresh;
	let notificationStackRefresh;
	let notificationStackGeneration = 0;
	let queryListCollapseRefresh;
	let recentNotificationsAlertRefresh;
	let recentNotificationsAlertRefreshInFlight;
	let viewBarResizeObserver;
	let viewCountRefresh;
	const pullRequestChecksCache = new Map();
	const pullRequestLabelsCache = new Map();
	const pullRequestMetadataCache = new Map();
	const queryCountCache = new Map();
	const notificationDslCache = new Map();
	const expandedNotificationStacks = new Set();
	const pullRequestChecksStorageKey = 'pullRequestChecksCache';
	const pullRequestLabelsStorageKey = 'pullRequestLabelsCache';
	const checksFreshFor = 5 * 60 * 1000;
	const checksUsableFor = 60 * 60 * 1000;

	function getOwner(repository) {
		return repository?.split('/')[0];
	}

	function getSurfaceOverride(surface, repository) {
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

	function getViews(surface, repository) {
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

	function getNotificationRules(repository) {
		const override = getSurfaceOverride('notifications', repository);
		return Array.isArray(override?.rules) && override.rules.length > 0
			? override.rules
			: builtInNotificationRules;
	}

	function getCurrentRepository() {
		const match = location.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:pulls|issues)\/?$/);
		return match ? `${match[1]}/${match[2]}` : undefined;
	}

	function isNotificationsPage() {
		return location.pathname === '/notifications';
	}

	function isPullRequestList() {
		return location.pathname === '/pulls'
			|| /^\/[^/]+\/[^/]+\/pulls\/?$/.test(location.pathname);
	}

	function isIssueList() {
		return location.pathname === '/issues'
			|| /^\/[^/]+\/[^/]+\/issues\/?$/.test(location.pathname);
	}

	function getSurface() {
		if (isNotificationsPage()) {
			return 'notifications';
		}

		if (isPullRequestList()) {
			return 'pulls';
		}

		if (isIssueList()) {
			return 'issues';
		}
	}

	function getDefaultViewId(surface, repository) {
		const targetRepository = repository
			?? (surface === 'notifications' ? undefined : getCurrentRepository());
		const override = getSurfaceOverride(surface, targetRepository);
		const defaultViewId = override?.defaultViewId;
		return defaultViewId ?? dsl.builtInDefaultViewIds[surface];
	}

	function getNotificationRepository(element) {
		const itemLink = element?.classList?.contains('notifications-list-item')
			? element.querySelector('.notification-list-item-link[href]')
			: element?.closest?.('.notifications-list-item')
				?.querySelector('.notification-list-item-link[href]');
		if (itemLink) {
			const match = new URL(itemLink.getAttribute('href'), location.origin)
				.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/|$)/);
			if (match) {
				return `${match[1]}/${match[2]}`;
			}
		}

		const list = element?.classList?.contains('js-notifications-list')
			? element
			: element?.closest?.('.js-notifications-list')
				?? element?.parentElement;
		const group = list?.closest(
			'.js-navigation-container, section, [data-repository-hovercards-enabled]',
		) ?? list?.parentElement;
		for (const link of group?.querySelectorAll('a[href]') ?? []) {
			const match = new URL(link.getAttribute('href'), location.origin)
				.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/|$)/);
			if (
				match
				&& !['apps', 'notifications', 'settings', 'orgs', 'users'].includes(match[1])
			) {
				return `${match[1]}/${match[2]}`;
			}
		}

		const heading = group?.querySelector('h1, h2, h3, [data-repository-name]');
		const match = heading?.textContent.trim().match(/([\w.-]+)\/([\w.-]+)/);
		return match ? `${match[1]}/${match[2]}` : undefined;
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

	function getNotificationMetadata(row) {
		const link = row.querySelector('.notification-list-item-link[data-hydro-click]');
		if (!link) {
			return {};
		}

		try {
			const event = JSON.parse(link.dataset.hydroClick);
			return {
				reason: event.payload?.metadata?.reason,
				threadType: event.payload?.thread_type,
			};
		} catch {
			return {};
		}
	}

	function hasOnlyVisibleBotParticipants(row) {
		const participants = [...row.querySelectorAll('.AvatarStack a[href]')];
		return participants.length > 0
			&& participants.every(link => link.getAttribute('href').startsWith('/apps/'));
	}

	function getNotificationFacts(row) {
		const {reason, threadType} = getNotificationMetadata(row);
		const titleElement = row.querySelector('.markdown-title');
		const itemLink = row.querySelector('.notification-list-item-link[href]');
		const pathname = itemLink
			? new URL(itemLink.getAttribute('href'), location.origin).pathname
			: '';
		const repository = getNotificationRepository(row);
		let notificationType = threadType
			?.replace(/([a-z])([A-Z])/g, '$1-$2')
			.replaceAll('_', '-')
			.toLowerCase();
		if (/\/pull\/\d+/.test(pathname)) {
			notificationType = 'pr';
		} else if (/\/issues\/\d+/.test(pathname)) {
			notificationType = 'issue';
		} else if (/\/discussions\/\d+/.test(pathname)) {
			notificationType = 'discussion';
		} else if (/\/releases\//.test(pathname)) {
			notificationType = 'release';
		} else if (/\/commit\//.test(pathname)) {
			notificationType = 'commit';
		} else if (itemLink?.hostname === 'gist.github.com') {
			notificationType = 'gist';
		}
		const facts = {
			author: row.dataset.githubInboxTunerAuthor,
			bot: hasOnlyVisibleBotParticipants(row),
			directMention: reason === 'mention',
			done: row.classList.contains('notification-archived'),
			draft: Boolean(row.querySelector('.octicon-git-pull-request-draft')),
			failingChecks: row.dataset.githubInboxTunerFailingChecks === 'true',
			checkStatus: row.dataset.githubInboxTunerCheckStatus,
			issue: Boolean(row.querySelector(':is(.octicon-issue-opened, .octicon-issue-closed, .octicon-skip)')),
			labels: JSON.parse(row.dataset.githubInboxTunerLabels ?? '[]'),
			mergeConflict: row.dataset.githubInboxTunerMergeConflict === 'true',
			mergedPullRequest: Boolean(row.querySelector('.octicon-git-merge')),
			ownPullRequest: row.dataset.githubInboxTunerOwnPullRequest === 'true',
			pullRequest: Boolean(
				row.querySelector('[class*="octicon-git-pull-request"], .octicon-git-merge')
				|| row.querySelector('a[href*="/pull/"]'),
			),
			notificationType,
			organization: repository?.split('/')[0],
			read: !row.classList.contains('notification-unread'),
			reason,
			repository,
			saved: Boolean(row.querySelector('.notification-is-starred-icon.color-fg-severe')),
			title: titleElement?.dataset.githubInboxTunerOriginalTitle
				?? titleElement?.textContent.trim()
				?? '',
			closedPullRequest: Boolean(row.querySelector('.octicon-git-pull-request-closed')),
			closedIssue: Boolean(row.querySelector(':is(.octicon-issue-closed, .octicon-skip)')),
		};
		return facts;
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

	function updateStatusBadges(row, facts) {
		const title = row.querySelector('.markdown-title');
		if (!title) {
			return;
		}

		title.dataset.githubInboxTunerOriginalTitle ??= title.textContent.trim();
		updateMergeConflictIcon(row, facts);
		let checkBadge;
		if (facts.checkStatus === 'failure') {
			checkBadge = {
				icon: '×',
				label: facts.ownPullRequest ? 'Checks failing (yours)' : 'Checks failing',
				state: 'failure',
			};
		} else if (facts.checkStatus === 'pending') {
			checkBadge = {icon: '●', label: 'Checks pending', state: 'pending'};
		} else if (facts.checkStatus === 'success') {
			checkBadge = {icon: '✓', label: 'Checks passing', state: 'success'};
		}

		let checkContainer = row.querySelector('.github-inbox-tuner-check-status');
		if (!checkBadge) {
			checkContainer?.remove();
		} else {
			const identifier = title.parentElement
				?.querySelector(':scope > .d-flex > p.m-0.f6.flex-auto > span');
			if (identifier) {
				checkContainer ??= document.createElement('span');
				checkContainer.className = 'github-inbox-tuner-check-status';
				if (checkContainer.parentElement !== identifier) {
					identifier.append(checkContainer);
				}
				if (checkContainer.dataset.signature !== checkBadge.label) {
					checkContainer.dataset.signature = checkBadge.label;
					checkContainer.replaceChildren(createStatusBadge(checkBadge));
				}
			}
		}

		const badges = [];
		if (facts.directMention) {
			badges.push({label: 'Direct mention', priority: true});
		}

		let container = row.querySelector('.github-inbox-tuner-statuses');
		const signature = badges.map(badge => badge.label).join('|');
		if (!signature) {
			container?.remove();
			return;
		}

		if (!container) {
			container = document.createElement('span');
			container.className = 'github-inbox-tuner-statuses';
			title.after(container);
		}

		if (container.dataset.signature === signature) {
			return;
		}

		container.dataset.signature = signature;
		container.replaceChildren(...badges.map(createStatusBadge));
	}

	function updateMergeConflictIcon(row, facts) {
		const original = row.querySelector(
			':is(.octicon-git-pull-request, .octicon-git-pull-request-draft, .octicon-git-pull-request-closed, .octicon-git-merge)',
		);
		let conflictIcon = row.querySelector('.github-inbox-tuner-conflict-icon');
		if (!facts.mergeConflict || !original) {
			conflictIcon?.remove();
			original?.classList.remove('github-inbox-tuner-original-pr-icon--hidden');
			return;
		}

		original.classList.add('github-inbox-tuner-original-pr-icon--hidden');
		if (conflictIcon) {
			return;
		}
		conflictIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		conflictIcon.setAttribute('aria-label', 'Pull request has merge conflicts');
		conflictIcon.setAttribute('height', '16');
		conflictIcon.setAttribute('role', 'img');
		conflictIcon.setAttribute('viewBox', '0 0 16 16');
		conflictIcon.setAttribute('width', '16');
		conflictIcon.classList.add(
			'octicon',
			'octicon-alert-fill',
			'github-inbox-tuner-conflict-icon',
		);
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute(
			'd',
			'M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575ZM8 5a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 8 5Zm0 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
		);
		conflictIcon.append(path);
		original.before(conflictIcon);
	}

	function createStatusBadge({icon, label, priority, state}) {
		const badge = document.createElement('span');
		badge.className = 'github-inbox-tuner-status';
		badge.classList.toggle('github-inbox-tuner-status--priority', priority);
		if (state) {
			badge.classList.add('github-inbox-tuner-status--check');
			badge.classList.add(`github-inbox-tuner-status--${state}`);
		}
		badge.textContent = icon ?? label;
		if (icon) {
			badge.setAttribute('aria-label', label);
			badge.title = label;
		}
		return badge;
	}

	function updateRevealedIndicator(row, reasons) {
		const revealed = reasons.length > 0;
		row.classList.toggle('github-inbox-tuner-revealed', revealed);
		if (revealed) {
			row.setAttribute(
				'aria-description',
				`Temporarily revealed; filtered by ${reasons.join(', ')}`,
			);
		} else {
			row.removeAttribute('aria-description');
		}
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
		const rows = document.querySelectorAll('.notifications-list-item');
		for (const row of rows) {
			applyCachedPullRequestFacts(row);
			applyCachedPullRequestLabelFacts(row);
			classifyNotification(row);
		}

		updateViewBar('notifications');
		updateFilteredDisclosures(rows);
		updateRepositoryBulkActions(rows);
		updateRepositoryViewActions(rows);
		scheduleFailedChecksRefresh();
		scheduleNotificationStackRefresh();
		scheduleRecentNotificationsAlertRefresh();
	}

	function getPullRequestReference(row) {
		const href = row.querySelector('.notification-list-item-link[href*="/pull/"]')?.href;
		if (!href) {
			return;
		}

		const match = new URL(href).pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
		if (!match) {
			return;
		}

		return {
			number: Number(match[3]),
			repository: `${match[1]}/${match[2]}`,
		};
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

	async function enrichPullRequestLabelFacts(rows, rules) {
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
			])));
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
			fetchPullRequestNumbers(repository, 'is:pr status:failure'),
			fetchPullRequestNumbers(repository, 'is:pr author:@me'),
			fetchPullRequestNumbers(repository, 'is:pr status:pending'),
			fetchPullRequestNumbers(repository, 'is:pr status:success'),
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
		const checkStatus = exactStatus
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

		const rows = document.querySelectorAll('.notifications-list-item');
		await Promise.all([
			enrichPullRequestCheckFacts(rows),
			enrichPullRequestLabelFacts(rows),
			enrichExactPullRequestMetadata(rows),
		]);
		for (const row of rows) {
			applyCachedPullRequestFacts(row);
			classifyNotification(row);
		}

		updateViewBar('notifications');
		updateFilteredDisclosures(rows);
	}

	function scheduleFailedChecksRefresh() {
		clearTimeout(failedChecksRefresh);
		failedChecksRefresh = setTimeout(() => {
			void updatePullRequestCheckNotifications();
		}, 250);
	}

	function getGlobalNotificationLink() {
		return [...document.querySelectorAll('a[href="/notifications"]')].find(link => (
			link.querySelector('svg.octicon-inbox')
			&& link.closest('[data-testid="top-nav-right"], header')
		));
	}

	function ensureHeaderSettingsButton() {
		if (!options.showHeaderSettingsButton) {
			document.querySelector('.github-inbox-tuner-settings-button')?.remove();
			return;
		}
		if (document.querySelector('.github-inbox-tuner-settings-button')) {
			return;
		}
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
		notificationLink.before(button);
	}

	function scheduleHeaderSettingsButton() {
		ensureHeaderSettingsButton();
		clearTimeout(headerSettingsRefresh);
		headerSettingsRefresh = setTimeout(() => {
			headerSettingsRefresh = undefined;
			ensureHeaderSettingsButton();
		}, 750);
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
		const rows = [...document_.querySelectorAll('.notifications-list-item')];
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
				[...document.querySelectorAll('.notifications-list-item[data-notification-id]')]
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

	function parsePullRequestMetadata(html, reference) {
		const document_ = new DOMParser().parseFromString(html, 'text/html');
		const checkStatusText = [...document_.querySelectorAll(
			'button, [aria-label], img[alt]',
		)]
			.flatMap(element => [
				element.textContent.trim(),
				element.getAttribute('aria-label') ?? '',
				element.getAttribute('alt') ?? '',
			])
			.find(text => /\bchecks (?:failing|pending|passing)\b/i.test(text));
		const checkStatusLabel = checkStatusText
			?.match(/\bchecks (failing|pending|passing)\b/i)?.[1]
			.toLowerCase();
		const checkStatus = checkStatusLabel === 'failing'
			? 'failure'
			: checkStatusLabel === 'pending'
				? 'pending'
				: checkStatusLabel === 'passing'
					? 'success'
					: undefined;
		const statusBatchElements = [...document_.querySelectorAll(
			'batch-deferred-content[data-url*="checks-statuses-rollups"]',
		)];
		const getStatusBatch = headSha => {
			const element = (
				headSha
					? statusBatchElements.find(candidate => (
						candidate.querySelector('input[name="oid"]')?.value === headSha
					))
					: undefined
			) ?? statusBatchElements.at(-1);
			return element
				? {
					fields: [...element.querySelectorAll('input[name]')].map(input => [
						input.name,
						input.value,
					]),
					url: element.getAttribute('data-url'),
				}
				: undefined;
		};
		const metadata = {
			checkStatus,
			number: reference.number,
			statusBatch: getStatusBatch(),
		};
		for (const script of document_.querySelectorAll(
			'script[type="application/json"][data-target="react-app.embeddedData"]',
		)) {
			try {
				const data = JSON.parse(script.textContent);
				const route = data.payload?.pullRequestsLayoutRoute;
				const pullRequest = route?.pullRequest;
				const repository = route?.repository;
				if (!pullRequest?.baseBranch || !pullRequest?.headBranch || !repository) {
					continue;
				}

				return {
					...metadata,
					author: pullRequest.author?.login ?? '',
					baseKey: `${repository.ownerLogin}/${repository.name}:${pullRequest.baseBranch}`,
					headKey: `${pullRequest.headRepositoryOwnerLogin}/${pullRequest.headRepositoryName}:${pullRequest.headBranch}`,
					number: pullRequest.number ?? reference.number,
					state: pullRequest.state,
					statusBatch: getStatusBatch(pullRequest.headSha),
					title: pullRequest.title ?? '',
				};
			} catch {}
		}
		return checkStatus || metadata.statusBatch ? metadata : undefined;
	}

	function parseCommitStatusPartial(html) {
		const document_ = new DOMParser().parseFromString(html, 'text/html');
		if (document_.querySelector(
			'.color-fg-danger, .octicon-x, .octicon-x-circle-fill',
		)) {
			return 'failure';
		}
		if (document_.querySelector(
			'.color-fg-attention, .color-fg-severe, .octicon-dot-fill, .octicon-clock',
		)) {
			return 'pending';
		}
		if (document_.querySelector(
			'.color-fg-success, .octicon-check, .octicon-check-circle-fill',
		)) {
			return 'success';
		}
	}

	function parseMergeConflict(payload) {
		const mergeStateStatus = payload?.pullRequest?.mergeStateStatus;
		if (mergeStateStatus === 'DIRTY') {
			return true;
		}
		if (
			['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BEHIND', 'BLOCKED'].includes(
				mergeStateStatus,
			)
		) {
			return false;
		}
		const conflictCondition = payload?.mergeRequirements?.conditions?.find(
			condition => /CONFLICT/i.test(condition.type ?? ''),
		);
		if (conflictCondition) {
			return conflictCondition.result === 'FAILED'
				&& (
					!Array.isArray(conflictCondition.conflicts)
					|| conflictCondition.conflicts.length > 0
				);
		}
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
		if (cached && Date.now() - cached.updatedAt < 5 * 60 * 1000) {
			return cached.value;
		}

		const response = await fetch(
			new URL(`/${reference.repository}/pull/${reference.number}`, location.origin),
			{cache: 'no-store', credentials: 'same-origin'},
		);
		let value = response.ok
			? parsePullRequestMetadata(await response.text(), reference)
			: undefined;
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
		pullRequestMetadataCache.set(key, {updatedAt: Date.now(), value});
		return value;
	}

	function findStackComponents(items) {
		const parent = items.map((_, index) => index);
		const find = index => {
			while (parent[index] !== index) {
				parent[index] = parent[parent[index]];
				index = parent[index];
			}
			return index;
		};
		const join = (left, right) => {
			const leftRoot = find(left);
			const rightRoot = find(right);
			if (leftRoot !== rightRoot) {
				parent[rightRoot] = leftRoot;
			}
		};

		for (let left = 0; left < items.length; left++) {
			for (let right = left + 1; right < items.length; right++) {
				if (
					(
						items[left].metadata.baseKey
						&& items[right].metadata.headKey
						&& items[left].metadata.baseKey === items[right].metadata.headKey
					)
					|| (
						items[right].metadata.baseKey
						&& items[left].metadata.headKey
						&& items[right].metadata.baseKey === items[left].metadata.headKey
					)
				) {
					join(left, right);
				}
			}
		}

		const groups = new Map();
		for (let index = 0; index < items.length; index++) {
			const root = find(index);
			const group = groups.get(root) ?? [];
			group.push(items[index]);
			groups.set(root, group);
		}
		return [...groups.values()].filter(group => group.length > 1);
	}

	function isDependencyUpdateAuthor(author) {
		return /^(?:app\/)?(?:dependabot|renovate)(?:\[bot\]|-bot)?$/i.test(author);
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

	function decorateCollapsedGroup(group, signature, label) {
		const baseKeys = new Set(group.map(item => item.metadata.baseKey));
		const representative = group.find(item => !baseKeys.has(item.metadata.headKey)) ?? group[0];
		const button = document.createElement('button');
		button.className = 'github-inbox-tuner-collapse-toggle';
		button.type = 'button';
		const icon = document.createElement('span');
		icon.className = 'github-inbox-tuner-collapse-icon';
		const text = document.createElement('span');
		text.textContent = label;
		button.append(icon, text);

		const updateExpandedState = expanded => {
			representative.row.classList.toggle(
				'github-inbox-tuner-collapse-representative--expanded',
				expanded,
			);
			button.setAttribute('aria-expanded', String(expanded));
			button.title = expanded
				? 'Collapse these pull request notifications'
				: `Expand ${group.length} related pull request notifications`;
			for (const {row} of group) {
				row.classList.toggle(
					'github-inbox-tuner-stack-member--collapsed',
					row !== representative.row && !expanded,
				);
			}
		};
		button.addEventListener('click', () => {
			const expanded = !expandedNotificationStacks.has(signature);
			if (expanded) {
				expandedNotificationStacks.add(signature);
			} else {
				expandedNotificationStacks.delete(signature);
			}
			updateExpandedState(expanded);
		});
		updateExpandedState(expandedNotificationStacks.has(signature));
		const title = representative.row.querySelector('.markdown-title');
		const statuses = representative.row.querySelector('.github-inbox-tuner-statuses');
		(statuses ?? title)?.after(button);
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

	async function updateNotificationStacks() {
		if (!isNotificationsPage()) {
			return;
		}

		const generation = ++notificationStackGeneration;
		for (const toggle of document.querySelectorAll('.github-inbox-tuner-collapse-toggle')) {
			toggle.remove();
		}
		for (const row of document.querySelectorAll('.github-inbox-tuner-stack-member--collapsed')) {
			row.classList.remove('github-inbox-tuner-stack-member--collapsed');
		}
		for (const row of document.querySelectorAll(
			'.github-inbox-tuner-collapse-representative--expanded',
		)) {
			row.classList.remove('github-inbox-tuner-collapse-representative--expanded');
		}

		for (const list of new Set(
			[...document.querySelectorAll('.notifications-list-item')].map(row => row.parentElement),
		)) {
			const candidates = [...list.querySelectorAll(':scope > .notifications-list-item')]
				.filter(row => !row.classList.contains('github-inbox-tuner-hidden'))
				.map(row => ({reference: getPullRequestReference(row), row}))
				.filter(item => item.reference);
			const items = await loadPullRequestMetadata(candidates);
			if (generation !== notificationStackGeneration) {
				return;
			}
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

			const groupedItems = new Set();
			for (const stack of findStackComponents(items)) {
				for (const item of stack) {
					groupedItems.add(item);
				}
				const signature = `${stack[0].reference.repository}:${stack
					.map(item => item.reference.number)
					.sort((left, right) => left - right)
					.join(',')}`;
				decorateCollapsedGroup(
					stack,
					signature,
					`${stack.length} PR stack`,
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
						? `${authorGroup.length} dependency updates`
						: `${authorGroup.length} PRs by ${author}`,
				);
			}
		}
	}

	function scheduleNotificationStackRefresh() {
		clearTimeout(notificationStackRefresh);
		notificationStackRefresh = setTimeout(() => {
			void updateNotificationStacks();
		}, 350);
	}

	function getQueryListItemAuthor(row) {
		const hovercard = [...row.querySelectorAll('a[data-hovercard-url^="/users/"]')]
			.map(link => link.getAttribute('data-hovercard-url'))
			.find(Boolean);
		const hovercardMatch = hovercard?.match(/^\/users\/([^/]+)\/hovercard/);
		if (hovercardMatch) {
			return decodeURIComponent(hovercardMatch[1]);
		}
		for (const link of row.querySelectorAll('a[href*="author"]')) {
			const query = new URL(link.getAttribute('href'), location.origin)
				.searchParams.get('q');
			const author = query?.match(/(?:^|\s)author:([^\s]+)/i)?.[1];
			if (author) {
				return author.replace(/^app\//i, '');
			}
		}
	}

	function decorateQueryCollapsedGroup(group, surface, author) {
		const representative = group[0];
		const signature = `${location.pathname}:${surface}:author:${author.toLowerCase()}:${group
			.map(item => `${item.repository}#${item.number}`)
			.sort()
			.join(',')}`;
		const button = document.createElement('button');
		button.className = 'github-inbox-tuner-collapse-toggle github-inbox-tuner-list-collapse-toggle';
		button.type = 'button';
		const icon = document.createElement('span');
		icon.className = 'github-inbox-tuner-collapse-icon';
		const text = document.createElement('span');
		const itemLabel = surface === 'pulls' ? 'PRs' : 'issues';
		text.textContent = isDependencyUpdateAuthor(author)
			? `${group.length} dependency updates`
			: `${group.length} ${itemLabel} by ${author}`;
		button.append(icon, text);

		const updateExpandedState = expanded => {
			representative.row.classList.toggle(
				'github-inbox-tuner-collapse-representative--expanded',
				expanded,
			);
			button.setAttribute('aria-expanded', String(expanded));
			button.title = expanded
				? `Collapse these ${itemLabel}`
				: `Expand ${group.length} ${itemLabel}`;
			for (const {row} of group) {
				row.classList.toggle(
					'github-inbox-tuner-query-member--collapsed',
					row !== representative.row && !expanded,
				);
			}
		};
		button.addEventListener('click', () => {
			const expanded = !expandedNotificationStacks.has(signature);
			if (expanded) {
				expandedNotificationStacks.add(signature);
			} else {
				expandedNotificationStacks.delete(signature);
			}
			updateExpandedState(expanded);
		});
		updateExpandedState(expandedNotificationStacks.has(signature));
		const title = representative.row.querySelector(
			'.markdown-title, [data-testid="issue-row-title-link"]',
		) ?? [...representative.row.querySelectorAll('a[href]')].find(link => (
			/^\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+/.test(
				new URL(link.getAttribute('href'), location.origin).pathname,
			)
		));
		title?.after(button);
	}

	function updateQueryListCollapses(surface) {
		if (!['pulls', 'issues'].includes(surface)) {
			return;
		}
		for (const toggle of document.querySelectorAll(
			'.github-inbox-tuner-list-collapse-toggle',
		)) {
			toggle.remove();
		}
		for (const row of document.querySelectorAll(
			'.github-inbox-tuner-query-member--collapsed',
		)) {
			row.classList.remove('github-inbox-tuner-query-member--collapsed');
		}
		const groups = new Map();
		for (const target of getListBulkTargets(surface)) {
			if (target.row.closest('[aria-label*="pinned issues" i]')) {
				continue;
			}
			const author = getQueryListItemAuthor(target.row);
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
			group.push({...target, author});
			groups.set(key, group);
		}
		for (const group of groups.values()) {
			if (group.length > 1) {
				decorateQueryCollapsedGroup(group, surface, group[0].author);
			}
		}
	}

	function scheduleQueryListCollapseRefresh(surface) {
		clearTimeout(queryListCollapseRefresh);
		queryListCollapseRefresh = setTimeout(() => {
			updateQueryListCollapses(surface);
		}, 250);
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
			if (!actionHost || existing) {
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
			const match = [...document.querySelectorAll(
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
			const checkbox = target.row.querySelector('input[type="checkbox"]');
			if (checkbox && !checkbox.checked) {
				checkbox.click();
			}
		}
		await new Promise(resolve => setTimeout(resolve, 100));
		const labelAction = step.type.startsWith('label:');
		const triggerPattern = labelAction ? /^Labels?$/i : /^Mark as$/i;
		const trigger = [...document.querySelectorAll('.js-issue-triage-menu > summary')]
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

	function updateRepositoryBulkActions(rows) {
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
			const existing = group.querySelector('.github-inbox-tuner-repository-bulk-actions');
			const rules = getNotificationRules(repository);
			const entries = rules.flatMap(rule => (rule.actions ?? []).map(action => ({
				action,
				surface: 'notifications',
				targets: [...list.querySelectorAll('.notifications-list-item')]
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

	function getOwnerSurfaceConfig(surface, owner) {
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

	function getInlineEditorAnchor(surface, repository) {
		if (!repository) {
			return document.querySelector('#github-inbox-tuner-views');
		}
		if (surface === 'notifications') {
			for (const list of document.querySelectorAll('.js-notifications-list')) {
				if (getNotificationRepository(list) === repository) {
					return list;
				}
			}
		}
		return document.querySelector('#github-inbox-tuner-views');
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

	function openInlineViewEditor(surface, repository, explicitAnchor) {
		const existing = document.querySelector('#github-inbox-tuner-inline-editor');
		existing?.querySelector('[data-action="cancel"]')?.click();

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
				for (const [label, labelText, disabled, handler] of [
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
				]) {
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
			const item = {
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

	function getActiveQueryView(surface) {
		const query = new URL(location.href).searchParams.get('q')
			?? document.querySelector('main input[name="q"]')?.value
			?? '';
		const normalized = normalizeQuery(query);
		return getViews(surface).find(view => normalizeQuery(view.dsl) === normalized)?.id;
	}

	function createViewChip(surface, view, defaultViewId) {
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
			chip.href = buildViewUrl(view.dsl);
		}

		const label = document.createElement('span');
		label.textContent = view.label;
		const count = document.createElement('span');
		count.className = 'github-inbox-tuner-view-count';
		count.textContent = '…';
		chip.append(label, count);
		return chip;
	}

	function createEditAction(surface) {
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

	function updateViewChipCount(chip, count, activeViewId) {
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
			? [...document.querySelectorAll('.notifications-list-item')]
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

	function updateViewBar(surface) {
		if (surface !== getSurface()) {
			return;
		}

		let bar = document.querySelector('#github-inbox-tuner-views');
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
		for (const chip of bar.querySelectorAll('.github-inbox-tuner-view-chip')) {
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
			const rows = [...document.querySelectorAll('.notifications-list-item')];
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

	function scheduleQueryViewCounts(surface) {
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

	function redirectToDefaultView(surface) {
		clearTimeout(redirectAttempt);
		if (
			!['pulls', 'issues'].includes(surface)
			|| !getCurrentRepository()
			|| new URL(location.href).searchParams.has('q')
		) {
			return;
		}

		const view = getViews(surface).find(candidate => candidate.id === getDefaultViewId(surface))
			?? getViews(surface)[0];
		if (!view) {
			return;
		}

		redirectAttempt = setTimeout(() => {
			const url = new URL(location.href);
			if (!url.searchParams.has('q')) {
				url.searchParams.set('q', view.dsl);
				location.replace(url);
			}
		}, 100);
	}

	function apply() {
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
			redirectToDefaultView(surface);
			updateViewBar(surface);
			scheduleQueryListCollapseRefresh(surface);
		}
	}

	async function loadOptions() {
		const [storedOptions] = await Promise.all([
			chrome.storage.sync.get(defaults),
			hydratePullRequestChecksCache(),
			hydratePullRequestLabelsCache(),
		]);
		options = {...defaults, ...storedOptions};
		builtInNotificationRules = dsl.cloneBuiltInNotificationRules();
		builtInViews = dsl.cloneBuiltInViews();
		activeNotificationView = getDefaultViewId('notifications');
		notificationViewExplicitlySelected = false;
		apply();
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
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') {
			scheduleGlobalIndicatorRefresh();
		}
	});

	const observer = new MutationObserver(mutations => {
		const childListMutations = mutations.filter(
			mutation => mutation.type === 'childList',
		);
		if (
			options.showHeaderSettingsButton
			&&
			childListMutations.length > 0
			&& !document.querySelector('.github-inbox-tuner-settings-button')
		) {
			ensureHeaderSettingsButton();
		}
		const onlyExtensionControlsChanged = childListMutations.length > 0
			&& childListMutations.every(mutation => (
			[...mutation.addedNodes, ...mutation.removedNodes].every(node => (
				node.nodeType !== Node.ELEMENT_NODE
					|| node.classList.contains('github-inbox-tuner-collapse-toggle')
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
