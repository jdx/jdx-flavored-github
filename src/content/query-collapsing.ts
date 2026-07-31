import type {ExtensionOptions, Surface} from '../shared/types.js';
import {
	findStackComponents,
	isDependencyUpdateAuthor,
	orderStackItems,
} from './grouping.js';
import type {
	PullRequestMetadata,
	PullRequestReference,
} from './pull-request-metadata.js';

interface QueryTarget {
	number: number;
	repository: string;
	row: HTMLElement;
}

type QueryItem = QueryTarget & {
	author?: string;
	metadata?: PullRequestMetadata;
	reference?: PullRequestReference;
};

interface QueryCollapsingDependencies {
	expandedGroups: Set<string>;
	getCachedMetadata: (reference: PullRequestReference) => PullRequestMetadata | undefined;
	getOptions: () => ExtensionOptions;
	getTargets: (surface: Surface) => QueryTarget[];
	loadMetadata: (
		candidates: Array<QueryTarget & {reference: PullRequestReference}>,
	) => Promise<Array<QueryTarget & {
		metadata: PullRequestMetadata;
		reference: PullRequestReference;
	}>>;
}

export function getQueryListItemAuthor(row: Element): string | undefined {
	const hovercard = [...row.querySelectorAll('a[data-hovercard-url^="/users/"]')]
		.map(link => link.getAttribute('data-hovercard-url'))
		.find(Boolean);
	const hovercardMatch = hovercard?.match(/^\/users\/([^/]+)\/hovercard/);
	if (hovercardMatch) {
		return decodeURIComponent(hovercardMatch[1]);
	}
	for (const link of row.querySelectorAll<HTMLAnchorElement>('a[href*="author"]')) {
		const author = new URL(link.href, location.origin).searchParams.get('q')
			?.match(/(?:^|\s)author:([^\s]+)/i)?.[1];
		if (author) {
			return author.replace(/^app\//i, '');
		}
	}
}

export function createQueryListCollapsing({
	expandedGroups,
	getCachedMetadata,
	getOptions,
	getTargets,
	loadMetadata,
}: QueryCollapsingDependencies) {
	let generation = 0;
	let refresh: ReturnType<typeof setTimeout> | undefined;

	function clearQueryListDecorations() {
		for (const toggle of document.querySelectorAll(
			'.github-inbox-tuner-list-collapse-toggle',
		)) {
			toggle.remove();
		}
		for (const chevron of document.querySelectorAll(
			'.github-inbox-tuner-list-collapse-chevron',
		)) {
			chevron.remove();
		}
		for (const row of document.querySelectorAll(
			'.github-inbox-tuner-query-member--collapsed',
		)) {
			row.classList.remove('github-inbox-tuner-query-member--collapsed');
		}
		for (const row of document.querySelectorAll(
			'.github-inbox-tuner-query-member--expanded',
		)) {
			row.classList.remove('github-inbox-tuner-query-member--expanded');
		}
		for (const row of document.querySelectorAll(
			'.github-inbox-tuner-collapse-representative--expanded',
		)) {
			row.classList.remove('github-inbox-tuner-collapse-representative--expanded');
		}
	}

	function placeGroupRowsInOrder(group: QueryItem[]) {
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

	function decorateQueryCollapsedGroup(
		group: QueryItem[],
		surface: Surface,
		signature: string,
		collapsedLabel: string,
		expandedLabel: string,
		representative = group[0],
	) {
		const button = document.createElement('button');
		button.className = 'github-inbox-tuner-collapse-toggle github-inbox-tuner-list-collapse-toggle';
		button.type = 'button';
		const chevron = document.createElement('button');
		chevron.className = 'github-inbox-tuner-collapse-chevron github-inbox-tuner-list-collapse-chevron';
		chevron.type = 'button';
		const icon = document.createElement('span');
		icon.className = 'github-inbox-tuner-collapse-icon';
		chevron.append(icon);
		const placeholders = document.createElement('span');
		placeholders.className = 'github-inbox-tuner-collapse-placeholders';
		placeholders.setAttribute('aria-hidden', 'true');
		for (let index = 0; index < Math.min(group.length - 1, 3); index++) {
			const placeholder = document.createElement('span');
			placeholder.className = 'github-inbox-tuner-collapse-placeholder';
			placeholders.append(placeholder);
		}
		button.append(placeholders);

		const updateExpandedState = (expanded: boolean) => {
			representative.row.classList.toggle(
				'github-inbox-tuner-collapse-representative--expanded',
				expanded,
			);
			button.setAttribute('aria-expanded', String(expanded));
			chevron.setAttribute('aria-expanded', String(expanded));
			button.setAttribute(
				'aria-label',
				expanded
					? expandedLabel
					: `Expand ${group.length} related ${surface === 'pulls' ? 'pull requests' : 'issues'}; ${collapsedLabel}`,
			);
			button.classList.toggle(
				'github-inbox-tuner-collapse-toggle--expanded',
				expanded,
			);
			button.title = expanded
				? expandedLabel
				: `Expand ${group.length} related ${surface === 'pulls' ? 'pull requests' : 'issues'}`;
			chevron.setAttribute('aria-label', expanded ? expandedLabel : collapsedLabel);
			chevron.title = expanded ? expandedLabel : collapsedLabel;
			for (const {row} of group) {
				row.classList.toggle(
					'github-inbox-tuner-query-member--collapsed',
					row !== representative.row && !expanded,
				);
				row.classList.toggle(
					'github-inbox-tuner-query-member--expanded',
					row !== representative.row && expanded,
				);
			}
		};
		const toggleExpanded = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
			const expanded = !expandedGroups.has(signature);
			if (expanded) {
				expandedGroups.add(signature);
			} else {
				expandedGroups.delete(signature);
			}
			updateExpandedState(expanded);
		};
		button.addEventListener('click', toggleExpanded);
		chevron.addEventListener('click', toggleExpanded);
		updateExpandedState(expandedGroups.has(signature));
		const title = representative.row.querySelector(
			'.markdown-title, [data-testid="issue-row-title-link"]',
		) ?? [...representative.row.querySelectorAll<HTMLAnchorElement>('a[href]')].find(link => (
			/^\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+/.test(link.pathname)
		));
		title?.before(chevron);
		representative.row.after(button);
	}

	function decorateQueryGroups(items: QueryItem[], surface: Surface) {
		const groupedRows = new Set<HTMLElement>();
		if (surface === 'pulls') {
			const stackItems = items.filter(
				(item): item is QueryItem & {metadata: PullRequestMetadata} => Boolean(item.metadata),
			);
			for (const component of findStackComponents(stackItems)) {
				const stack = orderStackItems(component);
				for (const item of stack) {
					groupedRows.add(item.row);
				}
				placeGroupRowsInOrder(stack);
				const representative = stack[0];
				const signature = `${location.pathname}:pulls:stack:${stack[0].repository}:${stack
					.map(item => item.number)
					.sort((left, right) => left - right)
					.join(',')}`;
				decorateQueryCollapsedGroup(
					stack,
					surface,
					signature,
					`${stack.length - 1} more ${stack.length === 2 ? 'PR' : 'PRs'} in stack`,
					`Collapse ${stack.length}-PR stack`,
					representative,
				);
			}
		}

		const options = getOptions();
		const authorGroups = new Map<string, QueryItem[]>();
		for (const item of items) {
			if (groupedRows.has(item.row)) {
				continue;
			}
			const author = item.author ?? item.metadata?.author;
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
			const group = authorGroups.get(key) ?? [];
			group.push({...item, author});
			authorGroups.set(key, group);
		}
		for (const group of authorGroups.values()) {
			if (group.length < 2) {
				continue;
			}
			const author = group[0].author;
			const itemLabel = surface === 'pulls' ? 'PRs' : 'issues';
			const signature = `${location.pathname}:${surface}:author:${author.toLowerCase()}:${group
				.map(item => `${item.repository}#${item.number}`)
				.sort()
				.join(',')}`;
			decorateQueryCollapsedGroup(
				group,
				surface,
				signature,
				isDependencyUpdateAuthor(author)
					? `${group.length - 1} more dependency ${group.length === 2 ? 'update' : 'updates'}`
					: `${group.length - 1} more ${group.length === 2 ? itemLabel.slice(0, -1) : itemLabel} by ${author}`,
				isDependencyUpdateAuthor(author)
					? `Collapse dependency updates by ${author}`
					: `Collapse ${itemLabel} by ${author}`,
			);
		}
	}

	async function updateQueryListCollapses(surface: Surface) {
		if (!['pulls', 'issues'].includes(surface)) {
			return;
		}
		const currentGeneration = ++generation;
		clearQueryListDecorations();
		const targets = getTargets(surface)
			.filter(target => !target.row.closest('[aria-label*="pinned issues" i]'));
		const items = targets.map(target => ({
			...target,
			author: getQueryListItemAuthor(target.row),
		}));
		for (const {row} of items) {
			row.querySelector('.commit-build-statuses')?.parentElement
				?.classList.add('github-inbox-tuner-list-check-status');
		}
		if (surface !== 'pulls') {
			decorateQueryGroups(items, surface);
			return;
		}

		const candidates = items.map(item => {
			const reference = {number: item.number, repository: item.repository};
			return {
				...item,
				metadata: getCachedMetadata(reference),
				reference,
			};
		});
		decorateQueryGroups(candidates, surface);
		const loadedItems = await loadMetadata(candidates);
		if (currentGeneration !== generation) {
			return;
		}
		clearQueryListDecorations();
		decorateQueryGroups(
			loadedItems.map(item => ({
				...item,
				author: getQueryListItemAuthor(item.row) ?? item.metadata.author,
			})),
			surface,
		);
	}

	function scheduleQueryListCollapseRefresh(surface: Surface) {
		clearTimeout(refresh);
		refresh = setTimeout(() => {
			void updateQueryListCollapses(surface);
		}, 250);
	}

	return {scheduleQueryListCollapseRefresh, updateQueryListCollapses};
}
