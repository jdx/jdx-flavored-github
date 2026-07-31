import type {
	NotificationFacts,
	NotificationRule,
	Surface,
	ViewDefinition,
} from '../shared/types.js';

interface BulkActionType {
	label: string;
	needsValue?: boolean;
	type: string;
}

const builtInNotificationRules: NotificationRule[] = [
		{
			id: 'focused',
			label: 'Focused',
			dsl: `rule:direct-mention OR (
  NOT (rule:draft AND NOT author:@me)
  AND NOT rule:team-mention
  AND NOT rule:other-failing
  AND NOT rule:other-pending
  AND NOT rule:other-conflicting
)`,
			showAsView: true,
			showAsReason: false,
		},
		{
			id: 'mentions',
			label: 'Mentions',
			dsl: 'rule:direct-mention',
			showAsView: true,
			showAsReason: false,
		},
		{
			id: 'reviews',
			label: 'Review requests',
			dsl: 'reason:review-requested',
			showAsView: true,
			showAsReason: false,
		},
		{
			id: 'my-failing',
			label: 'My failing PRs',
			dsl: 'status:failure author:@me',
			showAsView: true,
			showAsReason: false,
		},
		{
			id: 'all',
			label: 'All',
			dsl: 'is:any',
			showAsView: true,
			showAsReason: false,
		},
		{
			id: 'direct-mention',
			label: 'Direct mention',
			dsl: 'reason:mention',
			showAsView: false,
			showAsReason: false,
		},
		{
			id: 'draft',
			label: 'Draft pull request',
			dsl: 'draft:true',
			showAsView: false,
			showAsReason: true,
		},
		{
			id: 'team-mention',
			label: 'Team mention',
			dsl: 'reason:team-mention',
			showAsView: false,
			showAsReason: true,
		},
		{
			id: 'other-failing',
			label: 'Failing checks on someone else’s PR',
			dsl: 'status:failure NOT author:@me',
			showAsView: false,
			showAsReason: true,
		},
		{
			id: 'other-pending',
			label: 'Pending checks on someone else’s PR',
			dsl: 'status:pending NOT author:@me',
			showAsView: false,
			showAsReason: true,
		},
		{
			id: 'other-conflicting',
			label: 'Merge conflicts on someone else’s PR',
			dsl: 'conflict:true NOT author:@me',
			showAsView: false,
			showAsReason: true,
		},
		{
			id: 'merged',
			label: 'Merged pull requests',
			dsl: 'is:merged',
			showAsView: false,
			showAsReason: false,
			actions: [
				{
					id: 'mark-done',
					label: 'Mark as done',
					steps: [{type: 'notification:done'}],
				},
			],
		},
	];
	const builtInViews: Record<Surface, ViewDefinition[]> = {
		notifications: builtInNotificationRules.filter(rule => rule.showAsView),
		pulls: [
			{id: 'ready', label: 'Ready', dsl: 'is:open is:pr draft:false'},
			{id: 'reviews', label: 'Review requested', dsl: 'is:open is:pr draft:false user-review-requested:@me'},
			{id: 'mine', label: 'My PRs', dsl: 'is:open is:pr author:@me'},
			{id: 'failing', label: 'Failing', dsl: 'is:open is:pr status:failure'},
			{id: 'all', label: 'All', dsl: 'is:open is:pr'},
		],
		issues: [
			{id: 'assigned', label: 'Assigned', dsl: 'is:open is:issue assignee:@me'},
			{id: 'mentioned', label: 'Mentioned', dsl: 'is:open is:issue mentions:@me'},
			{id: 'mine', label: 'Created by me', dsl: 'is:open is:issue author:@me'},
			{id: 'untriaged', label: 'Untriaged', dsl: 'is:open is:issue no:label'},
			{id: 'all', label: 'All', dsl: 'is:open is:issue'},
		],
	};
	const builtInDefaultViewIds = {
		notifications: 'focused',
		pulls: 'ready',
		issues: 'all',
	};
	const bulkActionTypes: Record<Surface, BulkActionType[]> = {
		notifications: [
			{type: 'notification:done', label: 'Mark as done'},
			{type: 'notification:read', label: 'Mark as read'},
			{type: 'notification:unread', label: 'Mark as unread'},
			{type: 'open', label: 'Open in tabs'},
		],
		pulls: [
			{type: 'pr:close', label: 'Close pull requests'},
			{type: 'pr:reopen', label: 'Reopen pull requests'},
			{type: 'label:add', label: 'Add label', needsValue: true},
			{type: 'label:remove', label: 'Remove label', needsValue: true},
			{type: 'open', label: 'Open in tabs'},
		],
		issues: [
			{type: 'issue:close', label: 'Close issues'},
			{type: 'issue:reopen', label: 'Reopen issues'},
			{type: 'label:add', label: 'Add label', needsValue: true},
			{type: 'label:remove', label: 'Remove label', needsValue: true},
			{type: 'open', label: 'Open in tabs'},
		],
	};

	function cloneBuiltInViews() {
		return JSON.parse(JSON.stringify(builtInViews));
	}

	function cloneBuiltInNotificationRules() {
		return JSON.parse(JSON.stringify(builtInNotificationRules));
	}

	function getBulkActionTypes(surface: Surface): BulkActionType[] {
		return bulkActionTypes[surface] ?? [];
	}

	function validateBulkActions(items: ViewDefinition[], surface: Surface) {
		const supportedTypes = new Map(
			getBulkActionTypes(surface).map(action => [action.type, action]),
		);
		for (const item of items) {
			const actionIds = new Set();
			for (const action of item.actions ?? []) {
				if (
					!/^[a-z0-9][a-z0-9-]*$/.test(action.id)
					|| actionIds.has(action.id)
				) {
					throw new Error(`Invalid or duplicate bulk action ID “${action.id}”`);
				}
				actionIds.add(action.id);
				if (!action.label?.trim() || !Array.isArray(action.steps) || action.steps.length === 0) {
					throw new Error(`${item.label} has an incomplete bulk action`);
				}
				for (const step of action.steps) {
					const definition = supportedTypes.get(step.type);
					if (!definition) {
						throw new Error(`Unsupported ${surface} bulk action “${step.type}”`);
					}
					if (definition.needsValue && !step.value?.trim()) {
						throw new Error(`${definition.label} needs a value`);
					}
				}
				const nativeStepIndex = action.steps.findIndex(step => (
					step.type.startsWith('issue:')
						|| step.type.startsWith('pr:')
						|| step.type.startsWith('label:')
				));
				if (
					nativeStepIndex >= 0
					&& nativeStepIndex !== action.steps.length - 1
				) {
					throw new Error(
						`${action.label} must put its lifecycle or label step last because GitHub reloads the list`,
					);
				}
			}
		}
	}

	function tokenize(source) {
		const tokens = [];
		let index = 0;
		const tokenPattern = /\s*(\(|\)|and\b|or\b|not\b|-?title:\/(?:\\.|[^/])*\/[dgimsuvy]*|-?label:"(?:\\.|[^"])*"|-?[^\s()]+)/iy;
		while (index < source.length) {
			tokenPattern.lastIndex = index;
			const match = tokenPattern.exec(source);
			if (!match) {
				throw new SyntaxError(`Unexpected input near “${source.slice(index, index + 16)}”`);
			}

			tokens.push(match[1]);
			index = tokenPattern.lastIndex;
		}
		return tokens;
	}

	function parseNotificationDsl(source) {
		const tokens = tokenize(source.trim());
		let position = 0;
		const supportedIsValues = new Set([
			'any',
			'check-suite',
			'closed',
			'commit',
			'discussion',
			'done',
			'gist',
			'issue',
			'issue-or-pull-request',
			'merged',
			'open',
			'pr',
			'read',
			'release',
			'repository-advisory',
			'repository-invitation',
			'repository-vulnerability-alert',
			'saved',
			'unread',
		]);
		const supportedReasons = new Set([
			'assign',
			'author',
			'ci-activity',
			'comment',
			'invitation',
			'manual',
			'mention',
			'participating',
			'review-requested',
			'security-alert',
			'state-change',
			'subscribed',
			'team-mention',
		]);

		function validateAtom(token) {
			const normalized = token.toLowerCase();
			const [qualifier, value = ''] = normalized.split(':', 2);
			const labelMatch = token.match(/^label:(?:"((?:\\.|[^"])*)"|([^\s()]+))$/i);
			if (
				(qualifier === 'is' && supportedIsValues.has(value))
				|| (qualifier === 'reason' && supportedReasons.has(value))
				|| (qualifier === 'status' && /^(?:failure|pending|success)$/.test(value))
				|| (qualifier === 'draft' && /^(?:true|false)$/.test(value))
				|| (qualifier === 'conflict' && /^(?:true|false)$/.test(value))
				|| (qualifier === 'bot' && /^(?:true|false)$/.test(value))
				|| (qualifier === 'repo' && /^[^/\s]+\/[^/\s]+$/.test(value))
				|| (qualifier === 'org' && value.length > 0)
				|| (qualifier === 'author' && value.length > 0)
				|| (qualifier === 'rule' && /^[a-z0-9][a-z0-9-]*$/.test(value))
				|| (
					labelMatch
					&& decodeQuotedValue(labelMatch[1] ?? labelMatch[2]).length > 0
				)
			) {
				return;
			}

			const titleMatch = token.match(/^title:\/((?:\\.|[^/])*)\/([dgimsuvy]*)$/i);
			if (titleMatch) {
				new RegExp(titleMatch[1], titleMatch[2]);
				return;
			}

			throw new SyntaxError(`Unknown notification condition “${token}”`);
		}

		function parsePrimary() {
			const token = tokens[position++];
			if (!token) {
				throw new SyntaxError('Expected a condition');
			}

			if (token === '(') {
				const expression = parseOr();
				if (tokens[position++] !== ')') {
					throw new SyntaxError('Expected “)”');
				}
				return expression;
			}

			if (token === ')') {
				throw new SyntaxError('Unexpected “)”');
			}

			validateAtom(token);
			return {type: 'atom', value: token};
		}

		function parseUnary() {
			if (tokens[position]?.toLowerCase() === 'not') {
				position++;
				return {type: 'not', expression: parseUnary()};
			}
			if (tokens[position]?.startsWith('-') && tokens[position].length > 1) {
				const token = tokens[position++].slice(1);
				validateAtom(token);
				return {type: 'not', expression: {type: 'atom', value: token}};
			}
			return parsePrimary();
		}

		function parseAnd() {
			let expression = parseUnary();
			while (
				position < tokens.length
				&& tokens[position] !== ')'
				&& tokens[position].toLowerCase() !== 'or'
			) {
				if (tokens[position].toLowerCase() === 'and') {
					position++;
				}
				expression = {type: 'and', left: expression, right: parseUnary()};
			}
			return expression;
		}

		function parseOr() {
			let expression = parseAnd();
			while (tokens[position]?.toLowerCase() === 'or') {
				position++;
				expression = {type: 'or', left: expression, right: parseAnd()};
			}
			return expression;
		}

		if (tokens.length === 0) {
			throw new SyntaxError('A notification view needs a DSL expression');
		}

		const tree = parseOr();
		if (position !== tokens.length) {
			throw new SyntaxError(`Expected “and” or “or” before “${tokens[position]}”`);
		}
		return tree;
	}

	function decodeQuotedValue(value) {
		return value.replace(/\\(["\\])/g, '$1');
	}

	function getNotificationQualifierValues(source, qualifier) {
		const tree = parseNotificationDsl(source);
		const values = new Set();
		const visit = node => {
			if (node.type === 'atom') {
				const match = node.value.match(
					new RegExp(`^${qualifier}:(?:"((?:\\\\.|[^"])*)"|([^\\s()]+))$`, 'i'),
				);
				if (match) {
					values.add(decodeQuotedValue(match[1] ?? match[2]).toLowerCase());
				}
				return;
			}
			if (node.expression) {
				visit(node.expression);
			}
			if (node.left) {
				visit(node.left);
				visit(node.right);
			}
		};
		visit(tree);
		return [...values];
	}

	function evaluateNotificationDsl(tree, facts, resolveRule) {
		switch (tree.type) {
			case 'and': {
				return evaluateNotificationDsl(tree.left, facts, resolveRule)
					&& evaluateNotificationDsl(tree.right, facts, resolveRule);
			}
			case 'or': {
				return evaluateNotificationDsl(tree.left, facts, resolveRule)
					|| evaluateNotificationDsl(tree.right, facts, resolveRule);
			}
			case 'not': {
				return !evaluateNotificationDsl(tree.expression, facts, resolveRule);
			}
			case 'atom': {
				return evaluateAtom(tree.value, facts, resolveRule);
			}
			default: {
				return false;
			}
		}
	}

	function evaluateAtom(rawAtom, facts, resolveRule) {
		const atom = rawAtom.toLowerCase();
		const titleMatch = rawAtom.match(/^title:\/((?:\\.|[^/])*)\/([dgimsuvy]*)$/i);
		if (titleMatch) {
			try {
				return new RegExp(titleMatch[1], titleMatch[2]).test(facts.title);
			} catch {
				return false;
			}
		}

		const separator = atom.indexOf(':');
		const qualifier = atom.slice(0, separator);
		const value = atom.slice(separator + 1);
		if (qualifier === 'rule') {
			return Boolean(resolveRule?.(value));
		}
		if (qualifier === 'reason') {
			return (facts.reason ?? '').replaceAll('_', '-') === value;
		}
		if (qualifier === 'repo') {
			return facts.repository?.toLowerCase() === value;
		}
		if (qualifier === 'org') {
			return facts.organization?.toLowerCase() === value;
		}
		if (qualifier === 'author') {
			return value === '@me'
				? facts.ownPullRequest || facts.reason === 'author'
				: facts.author?.toLowerCase() === value.replace(/^@/, '');
		}
		if (qualifier === 'label') {
			const labelMatch = rawAtom.match(/^label:(?:"((?:\\.|[^"])*)"|([^\s()]+))$/i);
			const label = decodeQuotedValue(labelMatch?.[1] ?? labelMatch?.[2] ?? '')
				.toLowerCase();
			return facts.labels?.some(candidate => candidate.toLowerCase() === label) ?? false;
		}
		if (qualifier === 'status') {
			return facts.checkStatus === value;
		}
		if (qualifier === 'draft') {
			return facts.draft === (value === 'true');
		}
		if (qualifier === 'conflict') {
			return facts.mergeConflict === (value === 'true');
		}
		if (qualifier === 'bot') {
			return facts.bot === (value === 'true');
		}
		if (qualifier === 'is') {
			const values = {
				'any': true,
				'check-suite': facts.notificationType === 'check-suite',
				'closed': facts.closedIssue || facts.closedPullRequest || facts.mergedPullRequest,
				'commit': facts.notificationType === 'commit',
				'discussion': facts.notificationType === 'discussion',
				'done': facts.done,
				'gist': facts.notificationType === 'gist',
				'issue': facts.issue,
				'issue-or-pull-request': facts.issue || facts.pullRequest,
				'merged': facts.mergedPullRequest,
				'open': (
					(facts.issue && !facts.closedIssue)
					|| (facts.pullRequest && !facts.closedPullRequest && !facts.mergedPullRequest)
				),
				'pr': facts.pullRequest,
				'read': facts.read,
				'release': facts.notificationType === 'release',
				'repository-advisory': facts.notificationType === 'repository-advisory',
				'repository-invitation': facts.notificationType === 'repository-invitation',
				'repository-vulnerability-alert': facts.notificationType === 'repository-vulnerability-alert',
				'saved': facts.saved,
				'unread': !facts.read,
			};
			return Boolean(values[value]);
		}

		return false;
	}

	function validateNotificationRules(rules) {
		const ids = new Set();
		const references = new Map();
		for (const rule of rules) {
			if (!/^[a-z0-9][a-z0-9-]*$/.test(rule.id)) {
				throw new Error(`Invalid rule ID “${rule.id}”`);
			}
			if (ids.has(rule.id)) {
				throw new Error(`Duplicate rule:${rule.id}`);
			}
			ids.add(rule.id);
			parseNotificationDsl(rule.dsl);
			references.set(
				rule.id,
				[...rule.dsl.matchAll(/\brule:([a-z0-9][a-z0-9-]*)/gi)]
					.map(match => match[1].toLowerCase()),
			);
		}
		for (const [ruleId, ruleReferences] of references) {
			for (const reference of ruleReferences) {
				if (!ids.has(reference)) {
					throw new Error(`rule:${ruleId} references missing rule:${reference}`);
				}
			}
		}
		const visited = new Set();
		const visiting = new Set();
		const visit = ruleId => {
			if (visiting.has(ruleId)) {
				throw new Error(`Rule cycle includes rule:${ruleId}`);
			}
			if (visited.has(ruleId)) {
				return;
			}
			visiting.add(ruleId);
			for (const reference of references.get(ruleId) ?? []) {
				visit(reference);
			}
			visiting.delete(ruleId);
			visited.add(ruleId);
		};
		for (const ruleId of ids) {
			visit(ruleId);
		}
	}

export {
	builtInDefaultViewIds,
	builtInNotificationRules,
	builtInViews,
	cloneBuiltInNotificationRules,
	cloneBuiltInViews,
	evaluateNotificationDsl,
	getBulkActionTypes,
	getNotificationQualifierValues,
	parseNotificationDsl,
	validateBulkActions,
	validateNotificationRules,
};
