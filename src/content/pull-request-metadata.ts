export type CheckStatus = 'failure' | 'pending' | 'success';

export interface PullRequestReference {
  number: number;
  repository: string;
}

export interface PullRequestMetadata {
  author?: string;
  baseKey?: string;
  checkStatus?: CheckStatus;
  headKey?: string;
  mergeConflict?: boolean;
  number: number;
  state?: string;
  statusBatch?: {
    fields: Array<[string, string]>;
    url: string;
  };
  title?: string;
}

export function parsePullRequestMetadata(
  html: string,
  reference: PullRequestReference,
): PullRequestMetadata | undefined {
  const document_ = new DOMParser().parseFromString(html, 'text/html');
  const checkStatusText = [...document_.querySelectorAll('button, [aria-label], img[alt]')]
    .flatMap((element) => [
      element.textContent?.trim() ?? '',
      element.getAttribute('aria-label') ?? '',
      element.getAttribute('alt') ?? '',
    ])
    .find((text) => /\bchecks (?:failing|pending|passing)\b/i.test(text));
  const checkStatusLabel = checkStatusText
    ?.match(/\bchecks (failing|pending|passing)\b/i)?.[1]
    .toLowerCase();
  const checkStatus: CheckStatus | undefined =
    checkStatusLabel === 'failing'
      ? 'failure'
      : checkStatusLabel === 'pending'
        ? 'pending'
        : checkStatusLabel === 'passing'
          ? 'success'
          : undefined;
  const statusBatchElements = [
    ...document_.querySelectorAll<HTMLElement>(
      'batch-deferred-content[data-url*="checks-statuses-rollups"]',
    ),
  ];
  const getStatusBatch = (headSha?: string) => {
    const element =
      (headSha
        ? statusBatchElements.find(
            (candidate) =>
              candidate.querySelector<HTMLInputElement>('input[name="oid"]')?.value === headSha,
          )
        : undefined) ?? statusBatchElements.at(-1);
    const url = element?.getAttribute('data-url');
    return element && url
      ? {
          fields: [...element.querySelectorAll<HTMLInputElement>('input[name]')].map(
            (input) => [input.name, input.value] as [string, string],
          ),
          url,
        }
      : undefined;
  };
  const metadata: PullRequestMetadata = {
    checkStatus,
    number: reference.number,
    statusBatch: getStatusBatch(),
  };
  for (const script of document_.querySelectorAll<HTMLScriptElement>(
    'script[type="application/json"][data-target="react-app.embeddedData"]',
  )) {
    try {
      const data = JSON.parse(script.textContent ?? '');
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

export function parseCommitStatusPartial(html: string): CheckStatus | undefined {
  const document_ = new DOMParser().parseFromString(html, 'text/html');
  if (document_.querySelector('.color-fg-danger, .octicon-x, .octicon-x-circle-fill')) {
    return 'failure';
  }
  if (
    document_.querySelector(
      '.color-fg-attention, .color-fg-severe, .octicon-dot-fill, .octicon-clock',
    )
  ) {
    return 'pending';
  }
  if (document_.querySelector('.color-fg-success, .octicon-check, .octicon-check-circle-fill')) {
    return 'success';
  }
}

export function parseMergeConflict(payload: any): boolean | undefined {
  const mergeStateStatus = payload?.pullRequest?.mergeStateStatus;
  if (mergeStateStatus === 'DIRTY') {
    return true;
  }
  if (['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'BEHIND', 'BLOCKED'].includes(mergeStateStatus)) {
    return false;
  }
  const conflictCondition = payload?.mergeRequirements?.conditions?.find((condition: any) =>
    /CONFLICT/i.test(condition.type ?? ''),
  );
  if (conflictCondition) {
    return (
      conflictCondition.result === 'FAILED' &&
      (!Array.isArray(conflictCondition.conflicts) || conflictCondition.conflicts.length > 0)
    );
  }
}
