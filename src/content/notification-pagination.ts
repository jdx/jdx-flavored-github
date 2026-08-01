import {getNotificationRepository} from './notification-dom.js';

export interface ExtraNotificationPageState {
	enabled: boolean;
	hasNextPage: boolean;
	loadedPages: number;
	maxPages: number;
	target: number;
	visibleCount: number;
}

// GitHub paginates the inbox, so a view that hides most of a page can leave a
// nearly empty list. Keep pulling the next page until the active view has
// enough rows, bounded so a strict view cannot walk the whole inbox.
export function shouldLoadExtraNotificationPage(
	state: ExtraNotificationPageState,
): boolean {
	return state.enabled
		&& state.hasNextPage
		&& state.loadedPages < state.maxPages
		&& state.visibleCount < state.target;
}

export const hiddenClassName = 'github-inbox-tuner-hidden';

// A Next link this run already hid points into pages that are on screen, so its
// href stops being a usable continuation once the inbox has run out. GitHub
// renders a fresh, unhidden link whenever it re-renders the list.
export function getUsableNextPageHref(
	link?: Element | null,
): string | undefined {
	if (!link || link.classList.contains(hiddenClassName)) {
		return undefined;
	}
	return link.getAttribute('href') ?? undefined;
}

export function getNotificationRowKey(row: Element): string | undefined {
	const id = (row as HTMLElement).dataset?.notificationId;
	if (id) {
		return `id:${id}`;
	}

	const href = row
		.querySelector<HTMLAnchorElement>('.notification-list-item-link[href]')
		?.getAttribute('href');
	return href ? `href:${href}` : undefined;
}

export function getLoadedNotificationRowKeys(root: ParentNode): Set<string> {
	const keys = new Set<string>();
	for (const row of root.querySelectorAll('.notifications-list-item')) {
		const key = getNotificationRowKey(row);
		if (key) {
			keys.add(key);
		}
	}
	return keys;
}

function getNotificationGroup(row: Element): Element | undefined {
	return row.closest('.js-notifications-group')
		?? row.parentElement?.parentElement
		?? undefined;
}

// Rows arrive from a parsed copy of the next inbox page. Merge them into the
// repository group they belong to when it is already on screen, and otherwise
// clone the fetched group so its repository header comes along.
export function appendNotificationRows(
	document_: Document,
	rows: HTMLElement[],
): HTMLElement[] {
	const keys = getLoadedNotificationRowKeys(document_);
	const fresh: HTMLElement[] = [];
	for (const row of rows) {
		const key = getNotificationRowKey(row);
		if (key && keys.has(key)) {
			continue;
		}
		if (key) {
			keys.add(key);
		}
		fresh.push(row);
	}
	if (fresh.length === 0) {
		return [];
	}

	const listsByRepository = new Map<string, Element>();
	let lastList: Element | undefined;
	let lastGroup: Element | undefined;
	for (const row of document_.querySelectorAll('.notifications-list-item')) {
		const list = row.parentElement;
		if (!list) {
			continue;
		}
		const repository = getNotificationRepository(list);
		if (repository && !listsByRepository.has(repository)) {
			listsByRepository.set(repository, list);
		}
		lastList = list;
		lastGroup = row.closest('.js-notifications-group') ?? lastGroup;
	}

	const rowsByGroup = new Map<Element | undefined, HTMLElement[]>();
	for (const row of fresh) {
		const group = getNotificationGroup(row);
		const items = rowsByGroup.get(group) ?? [];
		items.push(row);
		rowsByGroup.set(group, items);
	}

	const appended: HTMLElement[] = [];
	for (const [group, items] of rowsByGroup) {
		const repository = getNotificationRepository(items[0]);
		const existingList = repository
			? listsByRepository.get(repository)
			: undefined;
		const fetchedGroup = items[0].closest('.js-notifications-group')
			? group
			: undefined;
		if (!existingList && fetchedGroup && lastGroup) {
			const adopted = document_.adoptNode(fetchedGroup) as Element;
			for (const row of adopted.querySelectorAll<HTMLElement>(
				'.notifications-list-item',
			)) {
				if (!items.includes(row)) {
					row.remove();
				}
			}
			lastGroup.after(adopted);
			lastGroup = adopted;
			lastList = items[0].parentElement ?? lastList;
			if (repository && items[0].parentElement) {
				listsByRepository.set(repository, items[0].parentElement);
			}
			appended.push(...items);
			continue;
		}

		// Without repository groups the inbox is one flat list, so the trailing
		// list is the only place these rows can go. Leave it out of the
		// repository index, which is only meaningful for grouped inboxes.
		const list = existingList ?? lastList;
		if (!list) {
			continue;
		}
		for (const row of items) {
			list.append(document_.adoptNode(row));
		}
		appended.push(...items);
	}
	return appended;
}
