import type {ExtensionOptions, Surface} from '../shared/types.js';
import {isDependencyUpdateAuthor} from './grouping.js';

interface QueryTarget {
	number: number;
	repository: string;
	row: HTMLElement;
}

interface QueryCollapsingDependencies {
	expandedGroups: Set<string>;
	getOptions: () => ExtensionOptions;
	getTargets: (surface: Surface) => QueryTarget[];
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
	getOptions,
	getTargets,
}: QueryCollapsingDependencies) {
	let refresh: ReturnType<typeof setTimeout> | undefined;

	function decorateQueryCollapsedGroup(
		group: Array<QueryTarget & {author: string}>,
		surface: Surface,
		author: string,
	) {
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
		const placeholders = document.createElement('span');
		placeholders.className = 'github-inbox-tuner-collapse-placeholders';
		placeholders.setAttribute('aria-hidden', 'true');
		for (let index = 0; index < Math.min(group.length - 1, 3); index++) {
			const placeholder = document.createElement('span');
			placeholder.className = 'github-inbox-tuner-collapse-placeholder';
			placeholders.append(placeholder);
		}
		const text = document.createElement('span');
		const itemLabel = surface === 'pulls' ? 'PRs' : 'issues';
		text.textContent = isDependencyUpdateAuthor(author)
			? `${group.length - 1} more dependency ${group.length === 2 ? 'update' : 'updates'}`
			: `${group.length - 1} more ${group.length === 2 ? itemLabel.slice(0, -1) : itemLabel} by ${author}`;
		const collapsedLabel = text.textContent;
		button.append(icon, placeholders, text);

		const updateExpandedState = (expanded: boolean) => {
			representative.row.classList.toggle(
				'github-inbox-tuner-collapse-representative--expanded',
				expanded,
			);
			button.setAttribute('aria-expanded', String(expanded));
			text.textContent = expanded ? 'Collapse nested items' : collapsedLabel;
			button.title = expanded
				? `Collapse these ${itemLabel}`
				: `Expand ${group.length} ${itemLabel}`;
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
		button.addEventListener('click', () => {
			const expanded = !expandedGroups.has(signature);
			if (expanded) {
				expandedGroups.add(signature);
			} else {
				expandedGroups.delete(signature);
			}
			updateExpandedState(expanded);
		});
		updateExpandedState(expandedGroups.has(signature));
		const title = representative.row.querySelector(
			'.markdown-title, [data-testid="issue-row-title-link"]',
		) ?? [...representative.row.querySelectorAll<HTMLAnchorElement>('a[href]')].find(link => (
			/^\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+/.test(link.pathname)
		));
		title?.after(button);
	}

	function updateQueryListCollapses(surface: Surface) {
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
		for (const row of document.querySelectorAll(
			'.github-inbox-tuner-query-member--expanded',
		)) {
			row.classList.remove('github-inbox-tuner-query-member--expanded');
		}
		const options = getOptions();
		const groups = new Map<string, Array<QueryTarget & {author: string}>>();
		for (const target of getTargets(surface)) {
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

	function scheduleQueryListCollapseRefresh(surface: Surface) {
		clearTimeout(refresh);
		refresh = setTimeout(() => updateQueryListCollapses(surface), 250);
	}

	return {scheduleQueryListCollapseRefresh, updateQueryListCollapses};
}
