import type {Surface} from '../shared/types.js';

export function getOwner(repository?: string): string | undefined {
	return repository?.split('/')[0];
}

export function getCurrentRepository(): string | undefined {
	const match = location.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:pulls|issues)\/?$/);
	return match ? `${match[1]}/${match[2]}` : undefined;
}

export function isNotificationsPage(): boolean {
	return location.pathname === '/notifications';
}

export function showsArchivedNotifications(): boolean {
	const url = new URL(location.href);
	const query = url.searchParams.get('query')
		?? url.searchParams.get('q')
		?? '';
	return /(?:^|\s)is:(?:done|saved)(?:\s|$)/i.test(query);
}

export function isPullRequestList(): boolean {
	return location.pathname === '/pulls'
		|| /^\/[^/]+\/[^/]+\/pulls\/?$/.test(location.pathname);
}

export function isIssueList(): boolean {
	return location.pathname === '/issues'
		|| /^\/[^/]+\/[^/]+\/issues\/?$/.test(location.pathname);
}

export function getSurface(): Surface | undefined {
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
