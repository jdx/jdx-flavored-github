import type {NotificationFacts} from '../shared/types.js';
import type {PullRequestReference} from './pull-request-metadata.js';

export function filterNotificationRowsForFolder<
  T extends {classList: {contains: (token: string) => boolean}},
>(rows: Iterable<T>, includeArchived: boolean): T[] {
  return [...rows].filter(
    (row) => includeArchived || !row.classList.contains('notification-archived'),
  );
}

export function filterNotificationStackRows<
  T extends {classList: {contains: (token: string) => boolean}},
>(rows: Iterable<T>, includeArchived: boolean): T[] {
  return filterNotificationRowsForFolder(rows, includeArchived).filter(
    (row) => !row.classList.contains('github-inbox-tuner-hidden'),
  );
}

export function getNotificationRepository(element?: Element): string | undefined {
  const itemLink = element?.classList.contains('notifications-list-item')
    ? element.querySelector<HTMLAnchorElement>('.notification-list-item-link[href]')
    : element
        ?.closest('.notifications-list-item')
        ?.querySelector<HTMLAnchorElement>('.notification-list-item-link[href]');
  if (itemLink) {
    const match = new URL(itemLink.href, location.origin).pathname.match(
      /^\/([^/]+)\/([^/]+)(?:\/|$)/,
    );
    if (match) {
      return `${match[1]}/${match[2]}`;
    }
  }

  const list = element?.classList.contains('js-notifications-list')
    ? element
    : (element?.closest('.js-notifications-list') ?? element?.parentElement);
  const group =
    list?.closest('.js-navigation-container, section, [data-repository-hovercards-enabled]') ??
    list?.parentElement;
  for (const link of group?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? []) {
    const match = new URL(link.href, location.origin).pathname.match(/^\/([^/]+)\/([^/]+)(?:\/|$)/);
    if (match && !['apps', 'notifications', 'settings', 'orgs', 'users'].includes(match[1])) {
      return `${match[1]}/${match[2]}`;
    }
  }

  const heading = group?.querySelector('h1, h2, h3, [data-repository-name]');
  const match = heading?.textContent?.trim().match(/([\w.-]+)\/([\w.-]+)/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export function hasOnlyVisibleBotParticipants(row: Element): boolean {
  const participants = [...row.querySelectorAll<HTMLAnchorElement>('.AvatarStack a[href]')];
  return (
    participants.length > 0 && participants.every((link) => link.pathname.startsWith('/apps/'))
  );
}

export function isTerminalPullRequestRow(row: Element): boolean {
  return Boolean(row.querySelector(':is(.octicon-git-pull-request-closed, .octicon-git-merge)'));
}

function getNotificationMetadata(row: Element) {
  const link = row.querySelector<HTMLElement>('.notification-list-item-link[data-hydro-click]');
  if (!link) {
    return {};
  }
  try {
    const event = JSON.parse(link.dataset.hydroClick ?? '{}');
    return {
      reason: event.payload?.metadata?.reason as string | undefined,
      threadType: event.payload?.thread_type as string | undefined,
    };
  } catch {
    return {};
  }
}

export function getNotificationFacts(row: HTMLElement): NotificationFacts {
  const {reason, threadType} = getNotificationMetadata(row);
  const titleElement = row.querySelector<HTMLElement>('.markdown-title');
  const itemLink = row.querySelector<HTMLAnchorElement>('.notification-list-item-link[href]');
  const pathname = itemLink?.pathname ?? '';
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
  const terminalPullRequest = isTerminalPullRequestRow(row);
  return {
    author: row.dataset.githubInboxTunerAuthor,
    bot: hasOnlyVisibleBotParticipants(row),
    directMention: reason === 'mention',
    done: row.classList.contains('notification-archived'),
    draft: Boolean(row.querySelector('.octicon-git-pull-request-draft')),
    failingChecks: !terminalPullRequest && row.dataset.githubInboxTunerFailingChecks === 'true',
    checkStatus: terminalPullRequest ? '' : row.dataset.githubInboxTunerCheckStatus,
    issue: Boolean(
      row.querySelector(':is(.octicon-issue-opened, .octicon-issue-closed, .octicon-skip)'),
    ),
    labels: JSON.parse(row.dataset.githubInboxTunerLabels ?? '[]'),
    mergeConflict: !terminalPullRequest && row.dataset.githubInboxTunerMergeConflict === 'true',
    mergedPullRequest: Boolean(row.querySelector('.octicon-git-merge')),
    ownPullRequest: row.dataset.githubInboxTunerOwnPullRequest === 'true',
    pullRequest: Boolean(
      row.querySelector('[class*="octicon-git-pull-request"], .octicon-git-merge') ||
      row.querySelector('a[href*="/pull/"]'),
    ),
    notificationType,
    organization: repository?.split('/')[0],
    read: !row.classList.contains('notification-unread'),
    reason,
    repository,
    saved: Boolean(row.querySelector('.notification-is-starred-icon.color-fg-severe')),
    title:
      titleElement?.dataset.githubInboxTunerOriginalTitle ??
      titleElement?.textContent?.trim() ??
      '',
    closedPullRequest: Boolean(row.querySelector('.octicon-git-pull-request-closed')),
    closedIssue: Boolean(row.querySelector(':is(.octicon-issue-closed, .octicon-skip)')),
  };
}

export function getPullRequestReference(row: Element): PullRequestReference | undefined {
  const href = row.querySelector<HTMLAnchorElement>(
    '.notification-list-item-link[href*="/pull/"]',
  )?.href;
  if (!href) {
    return;
  }
  const match = new URL(href).pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return match ? {number: Number(match[3]), repository: `${match[1]}/${match[2]}`} : undefined;
}
