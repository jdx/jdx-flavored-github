import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as dsl from '../src/dsl/index.ts';

const extensionRoot = new URL('../', import.meta.url);
const contentCssSource = await readFile(new URL('content.css', extensionRoot), 'utf8');
const optionsCssSource = await readFile(new URL('options.css', extensionRoot), 'utf8');

const facts = overrides => ({
	author: 'jdx',
	bot: false,
	checkStatus: 'success',
	closedIssue: false,
	closedPullRequest: false,
	done: false,
	draft: false,
	issue: false,
	labels: [],
	mergeConflict: false,
	mergedPullRequest: false,
	notificationType: 'pr',
	organization: 'jdx',
	ownPullRequest: false,
	pullRequest: true,
	read: true,
	reason: 'comment',
	repository: 'jdx/mise',
	saved: false,
	title: 'fix: ordinary pull request',
	...overrides,
});

function evaluate(source, overrides = {}) {
	const notificationFacts = facts(overrides);
	const evaluateRule = (ruleId, evaluating = new Set()) => {
		if (evaluating.has(ruleId)) {
			return false;
		}
		const rule = dsl.builtInNotificationRules.find(candidate => candidate.id === ruleId);
		if (!rule) {
			return false;
		}
		const next = new Set(evaluating).add(ruleId);
		return dsl.evaluateNotificationDsl(
			dsl.parseNotificationDsl(rule.dsl),
			notificationFacts,
			referencedId => evaluateRule(referencedId, next),
		);
	};
	return dsl.evaluateNotificationDsl(
		dsl.parseNotificationDsl(source),
		notificationFacts,
		ruleId => evaluateRule(ruleId),
	);
}

for (const view of dsl.builtInViews.notifications) {
	assert.doesNotThrow(() => dsl.parseNotificationDsl(view.dsl), view.label);
}
assert.doesNotThrow(() => dsl.validateNotificationRules(dsl.builtInNotificationRules));
for (const surface of ['notifications', 'pulls', 'issues'] as const) {
	assert.doesNotThrow(() => dsl.validateBulkActions(
		surface === 'notifications'
			? dsl.builtInNotificationRules
			: dsl.builtInViews[surface],
		surface,
	));
}
assert.throws(
	() => dsl.validateBulkActions([{
		id: 'example',
		label: 'Example',
		dsl: 'is:open is:pr',
		actions: [{
			id: 'bad-order',
			label: 'Bad order',
			steps: [{type: 'pr:close'}, {type: 'open'}],
		}],
	}], 'pulls'),
	/must put its lifecycle or label step last/,
);
assert.equal(
	dsl.builtInNotificationRules.find(rule => rule.id === 'draft').showAsReason,
	true,
);
assert.equal(
	dsl.builtInNotificationRules.find(rule => rule.id === 'draft').showAsView,
	false,
);
assert.throws(
	() => dsl.validateNotificationRules([
		{id: 'one', dsl: 'rule:missing'},
	]),
	/missing rule:missing/,
);
assert.throws(
	() => dsl.validateNotificationRules([
		{id: 'one', dsl: 'rule:two'},
		{id: 'two', dsl: 'rule:one'},
	]),
	/Rule cycle/,
);

const focused = dsl.builtInViews.notifications[0].dsl;
assert.equal(evaluate(focused), true);
assert.equal(evaluate(focused, {draft: true}), false);
assert.equal(evaluate(focused, {checkStatus: 'failure'}), false);
assert.equal(evaluate(focused, {checkStatus: 'pending'}), false);
assert.equal(evaluate(focused, {checkStatus: 'failure', ownPullRequest: true}), true);
assert.equal(evaluate(focused, {checkStatus: 'pending', ownPullRequest: true}), true);
assert.equal(evaluate(focused, {mergeConflict: true}), false);
assert.equal(evaluate(focused, {mergeConflict: true, ownPullRequest: true}), true);
assert.equal(evaluate(focused, {mergeConflict: true, reason: 'mention'}), true);
assert.equal(evaluate(focused, {draft: true, reason: 'mention'}), true);
assert.equal(evaluate(focused, {checkStatus: 'failure', reason: 'mention'}), true);
assert.equal(evaluate(focused, {reason: 'team_mention'}), false);

assert.equal(evaluate('repo:jdx/mise org:jdx is:pr status:success'), true);
assert.equal(evaluate('reason:comment OR reason:mention AND draft:true'), true);
assert.equal(evaluate('(reason:comment OR reason:mention) AND draft:true'), false);
assert.equal(evaluate('-reason:team-mention -draft:true'), true);
assert.equal(evaluate('NOT reason:team-mention AND NOT draft:true'), true);
assert.equal(evaluate('title:/ordinary pull/i'), true);
assert.equal(evaluate('bot:false author:@me', {ownPullRequest: true}), true);
assert.equal(evaluate('rule:draft', {draft: true}), true);
assert.equal(evaluate('NOT rule:draft', {draft: true}), false);
assert.equal(evaluate('label:release', {labels: ['release']}), true);
assert.equal(evaluate('label:"release candidate"', {labels: ['Release Candidate']}), true);
assert.equal(evaluate('conflict:true', {mergeConflict: true}), true);
assert.equal(evaluate('conflict:false', {mergeConflict: false}), true);
assert.equal(evaluate('-label:release', {labels: ['bug']}), true);
assert.deepEqual(
	[...dsl.getNotificationQualifierValues(
		'label:release OR label:"release candidate"',
		'label',
	)],
	['release', 'release candidate'],
);
assert.equal(evaluate('author:me', {ownPullRequest: true}), false);
assert.equal(evaluate('is:issue-or-pull-request'), true);
assert.equal(evaluate('is:merged', {mergedPullRequest: true}), true);
assert.equal(evaluate('is:closed', {mergedPullRequest: true}), true);
assert.equal(evaluate('is:unread', {read: false}), true);
assert.equal(evaluate('is:done', {done: true}), true);
assert.equal(evaluate('is:saved', {saved: true}), true);
assert.equal(evaluate('is:repository-vulnerability-alert', {
	notificationType: 'repository-vulnerability-alert',
}), true);

for (const removedAtom of [
	'all',
	'mention',
	'team-mention',
	'review-requested',
	'draft',
	'failing',
	'pending',
]) {
	assert.throws(
		() => dsl.parseNotificationDsl(removedAtom),
		/Unknown notification condition/,
		`Removed atom still accepted: ${removedAtom}`,
	);
}

for (const invalid of [
	'',
	'NOT',
	'reason:nope',
	'status:nope',
	'draft:maybe',
	'is:nope',
	'(reason:mention',
	'reason:mention OR',
]) {
	assert.throws(() => dsl.parseNotificationDsl(invalid), undefined, invalid);
}

const manifest = JSON.parse(await readFile(new URL('manifest.json', extensionRoot), 'utf8'));
const packageManifest = JSON.parse(
	await readFile(new URL('package.json', extensionRoot), 'utf8'),
);
assert.equal(manifest.version, '0.1.0');
assert.equal(packageManifest.packageManager, 'aube@1.36.0');
assert.deepEqual(
	manifest.content_scripts[0].js,
	['content.js'],
	'The content bundle must be self-contained',
);
for (const relativePath of [
	'content.css',
	'options.css',
	'options.html',
	'README.md',
	'aube-lock.yaml',
	'mise.toml',
	'src/background.ts',
	'src/content/index.ts',
	'src/dsl/index.ts',
	'src/options/index.ts',
	'tsconfig.json',
	'dist/background.js',
	'dist/content.js',
	'dist/options.js',
]) {
	await assert.doesNotReject(() => readFile(new URL(relativePath, extensionRoot)));
}

const contentSource = (await Promise.all([
	'src/content/index.ts',
	'src/content/grouping.ts',
	'src/content/notification-dom.ts',
	'src/content/page.ts',
	'src/content/pull-request-metadata.ts',
	'src/content/query-collapsing.ts',
	'src/content/status.ts',
].map(path => readFile(new URL(path, extensionRoot), 'utf8')))).join('\n');
const dslSource = await readFile(new URL('src/dsl/index.ts', extensionRoot), 'utf8');
const optionsSource = await readFile(new URL('src/options/index.ts', extensionRoot), 'utf8');
const backgroundSource = await readFile(new URL('src/background.ts', extensionRoot), 'utf8');
const optionsHtmlSource = await readFile(new URL('options.html', extensionRoot), 'utf8');
const allText = [
	contentSource,
	dslSource,
	optionsSource,
	backgroundSource,
	optionsHtmlSource,
];
assert.doesNotMatch(
	allText.join('\n'),
	/\b(?:legacy|migration)\b/i,
	'Do not add compatibility or migration paths before the first release',
);
assert.match(contentSource, /scheduleRecentNotificationsAlertRefresh\(\);/);
assert.match(contentSource, /svg\.octicon-inbox/);
assert.match(contentSource, /new URL\('\/search\/count'/);
assert.match(contentSource, /showAsReason/);
assert.match(contentSource, /github-inbox-tuner-revealed/);
assert.match(contentSource, /Temporarily revealed; filtered by/);
assert.match(contentSource, /github-inbox-tuner-editor-workspace/);
assert.match(contentSource, /createInlineEditorHelp/);
assert.match(contentSource, /Notification rule syntax/);
assert.match(contentSource, /aria-expanded/);
assert.match(contentSource, /github-inbox-tuner-settings-button/);
assert.match(contentSource, /chrome\.runtime\.sendMessage\(\{type: 'open-options'\}\)/);
assert.match(backgroundSource, /chrome\.runtime\.openOptionsPage\(\)/);
assert.match(contentSource, /event\.target\.closest\('\.github-inbox-tuner-settings-button'\)/);
assert.match(contentSource, /event\.stopPropagation\(\)/);
assert.match(contentSource, /scheduleHeaderSettingsButton/);
assert.match(contentSource, /if \(!options\.showHeaderSettingsButton\)/);
assert.match(optionsSource, /showHeaderSettingsButton: 'show-header-settings-button'/);
assert.match(optionsHtmlSource, /id="show-header-settings-button"/);
assert.match(contentSource, /chip\.hidden = count === 0 && chip\.dataset\.viewId !== activeViewId/);
assert.match(contentSource, /updateViewChipCount/);
assert.match(contentSource, /showsArchivedNotifications/);
assert.match(contentSource, /scheduleNotificationViewRefresh/);
assert.match(contentSource, /attributeOldValue: true/);
assert.match(contentSource, /!className\.includes\('notificationIndicator'\)/);
assert.match(contentCssSource, /\.github-inbox-tuner-settings-icon/);
assert.match(contentSource, /list\.closest\('\.js-notifications-group'\)/);
assert.match(contentSource, /updateRepositoryBulkActions/);
assert.match(contentSource, /github-inbox-tuner-repository-actions/);
assert.match(contentCssSource, /\.github-inbox-tuner-repository-actions/);
assert.match(contentSource, /createBulkActionsMenu/);
assert.match(contentSource, /openBulkActionPreview/);
assert.match(contentSource, /executeNativeListStep/);
assert.match(contentSource, /\.js-issue-triage-menu > summary/);
assert.doesNotMatch(contentSource, /close_pull_request/);
assert.match(contentSource, /page_data\/merge_box/);
assert.match(contentSource, /parseMergeConflict/);
assert.match(contentSource, /isTerminalPullRequestRow/);
assert.match(contentSource, /is:pr is:open status:failure/);
assert.match(contentSource, /\['CLOSED', 'MERGED'\]\.includes\(value\.state\)/);
assert.match(contentSource, /github-inbox-tuner-conflict-icon/);
assert.match(contentSource, /githubInboxTunerMergeConflict/);
assert.doesNotMatch(contentSource, /updateRepositoryMergedDoneActions/);
assert.doesNotMatch(contentSource, /updateMergedDoneAction/);
assert.match(contentSource, /exactStatuses/);
assert.match(contentSource, /enrichExactPullRequestMetadata\(rows\)/);
assert.match(contentSource, /String\(checkStatus === 'failure'\)/);
assert.match(contentSource, /githubInboxTunerCheckStatusSource = exactStatus \? 'exact' : 'search'/);
assert.match(contentSource, /\{cache: 'no-store', credentials: 'same-origin'\}/);
assert.match(contentSource, /checks-statuses-rollups/);
assert.match(contentSource, /items\[item-0\]\[\$\{name\}\]/);
assert.match(contentSource, /statusPayload\['item-0'\]/);
assert.match(contentSource, /\.color-fg-danger, \.octicon-x/);
assert.match(contentSource, /ownerViewOverrides/);
assert.match(contentSource, /return checkStatus \|\| metadata\.statusBatch \? metadata : undefined/);
assert.match(contentSource, /'button, \[aria-label\], img\[alt\]'/);
assert.match(contentSource, /\\bchecks \(failing\|pending\|passing\)\\b/);
assert.doesNotMatch(contentSource, /\^checks \(\?:failing\|pending\|passing\)\$/);
assert.match(optionsSource, /jdx-flavored-github-settings\.json/);
assert.match(optionsSource, /normalizeImportedSettings/);
assert.match(optionsSource, /createBulkActionsEditor/);
assert.match(contentSource, /createInlineBulkActionsEditor/);
assert.match(contentSource, /validateBulkActions/);
assert.match(optionsSource, /chrome\.storage\.sync\.set\(imported\)/);
assert.doesNotMatch(contentSource, /console\.(?:debug|log|warn)\(/);
assert.match(
	contentCssSource,
	/#github-inbox-tuner-views\s*\{[^}]*flex-wrap:\s*wrap\s*!important;[^}]*overflow:\s*visible\s*!important;/s,
);
assert.match(contentCssSource, /max-width:\s*100%\s*!important/);
assert.match(contentCssSource, /width:\s*100%\s*!important/);
assert.match(
	contentCssSource,
	/#github-inbox-tuner-views\s*\{[^}]*min-height:\s*36px;[^}]*padding:\s*2px 0 8px\s*!important;/s,
);
assert.match(
	contentCssSource,
	/\.github-inbox-tuner-view-chip\s*\{[^}]*box-sizing:\s*border-box;[^}]*line-height:\s*20px;[^}]*min-height:\s*26px;[^}]*padding:\s*2px 8px;/s,
);
assert.match(contentSource, /bar\.style\.removeProperty\('max-width'\)/);
assert.match(contentSource, /updateQueryListCollapses/);
assert.match(contentSource, /scheduleQueryListCollapseRefresh/);
assert.match(contentSource, /github-inbox-tuner-query-member--collapsed/);
assert.match(contentSource, /getQueryListItemAuthor/);
assert.match(contentSource, /getCachedMetadata/);
assert.match(contentSource, /loadMetadata/);
assert.match(contentSource, /findStackComponents\(stackItems\)/);
assert.match(contentSource, /more \$\{stack\.length === 2 \? 'PR' : 'PRs'\} in stack/);
assert.match(contentCssSource, /\.github-inbox-tuner-query-member--collapsed/);
assert.match(contentSource, /github-inbox-tuner-collapse-placeholders/);
assert.match(contentSource, /github-inbox-tuner-collapse-member--expanded/);
assert.match(contentSource, /github-inbox-tuner-query-member--expanded/);
assert.match(contentSource, /Collapse dependency updates by/);
assert.doesNotMatch(contentSource, /Collapse nested items/);
assert.match(contentSource, /pullRequestMetadataStorageKey = 'pullRequestMetadataCache'/);
assert.match(contentSource, /hydratePullRequestMetadataCache\(\)/);
assert.match(contentSource, /persistPullRequestMetadataCache\(\)/);
assert.match(contentSource, /complete: false/);
assert.match(contentSource, /getCachedPullRequestGroupingMetadata/);
assert.match(contentSource, /decorateNotificationGroups\(cachedItems\)/);
assert.match(contentCssSource, /\.github-inbox-tuner-collapse-placeholder/);
assert.match(contentCssSource, /\.github-inbox-tuner-collapse-member--expanded/);
assert.match(contentCssSource, /\.notifications-list-item\.github-inbox-tuner-revealed/);
assert.match(contentCssSource, /\.github-inbox-tuner-editor-workspace/);
assert.match(contentCssSource, /\.github-inbox-tuner-editor-help/);
assert.match(contentCssSource, /\.github-inbox-tuner-settings-button/);
assert.match(optionsCssSource, /\.view-workspace/);
assert.match(optionsCssSource, /\.view-master-row/);
assert.match(optionsCssSource, /\.view-detail/);

console.log('jdx Flavored GitHub automated tests passed');
