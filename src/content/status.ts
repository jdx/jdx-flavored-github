import type {NotificationFacts} from '../shared/types.js';

interface StatusBadge {
	icon?: string;
	label: string;
	priority?: boolean;
	state?: string;
}

function createStatusBadge({icon, label, priority, state}: StatusBadge): HTMLElement {
	const badge = document.createElement('span');
	badge.className = 'github-inbox-tuner-status';
	badge.classList.toggle('github-inbox-tuner-status--priority', Boolean(priority));
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

function updateMergeConflictIcon(row: HTMLElement, facts: NotificationFacts): void {
	const original = row.querySelector(
		':is(.octicon-git-pull-request, .octicon-git-pull-request-draft, .octicon-git-pull-request-closed, .octicon-git-merge)',
	);
	let conflictIcon = row.querySelector<SVGElement>('.github-inbox-tuner-conflict-icon');
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

export function updateStatusBadges(row: HTMLElement, facts: NotificationFacts): void {
	const title = row.querySelector<HTMLElement>('.markdown-title');
	if (!title) {
		return;
	}
	title.dataset.githubInboxTunerOriginalTitle ??= title.textContent?.trim() ?? '';
	updateMergeConflictIcon(row, facts);
	let checkBadge: StatusBadge | undefined;
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

	let checkContainer = row.querySelector<HTMLElement>('.github-inbox-tuner-check-status');
	if (!checkBadge) {
		checkContainer?.remove();
	} else {
		const identifier = title.parentElement
			?.querySelector<HTMLElement>(':scope > .d-flex > p.m-0.f6.flex-auto > span');
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

	const badges: StatusBadge[] = [];
	if (facts.directMention) {
		badges.push({label: 'Direct mention', priority: true});
	}
	let container = row.querySelector<HTMLElement>('.github-inbox-tuner-statuses');
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

export function updateRevealedIndicator(row: HTMLElement, reasons: string[]): void {
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
