export type Surface = 'notifications' | 'pulls' | 'issues';

export interface BulkActionStep {
	type: string;
	value?: string;
}

export interface BulkAction {
	id: string;
	label: string;
	steps: BulkActionStep[];
}

export interface ViewDefinition {
	id: string;
	label: string;
	dsl: string;
	actions?: BulkAction[];
}

export interface NotificationRule extends ViewDefinition {
	showAsReason?: boolean;
	showAsView?: boolean;
}

export interface SurfaceOverride {
	defaultViewId?: string;
	rules?: NotificationRule[];
	views?: ViewDefinition[];
}

export type ScopeOverrides = Record<string, Partial<Record<Surface, SurfaceOverride>>>;

export interface ExtensionOptions {
	collapseDependencyUpdates: boolean;
	collapseSameAuthorNotifications: boolean;
	dimBotNotifications: boolean;
	showHeaderSettingsButton: boolean;
	ownerViewOverrides: ScopeOverrides;
	repositoryViewOverrides: ScopeOverrides;
	viewOverrides: Partial<Record<Surface, SurfaceOverride>>;
}

export interface NotificationFacts {
	author?: string;
	bot: boolean;
	checkStatus?: string;
	closedIssue: boolean;
	closedPullRequest: boolean;
	directMention: boolean;
	done: boolean;
	draft: boolean;
	failingChecks: boolean;
	issue: boolean;
	labels: string[];
	mergeConflict: boolean;
	mergedPullRequest: boolean;
	notificationType?: string;
	organization?: string;
	ownPullRequest: boolean;
	pullRequest: boolean;
	read: boolean;
	reason?: string;
	repository?: string;
	saved: boolean;
	title: string;
}

export const defaultOptions: ExtensionOptions = {
	collapseDependencyUpdates: true,
	collapseSameAuthorNotifications: false,
	dimBotNotifications: true,
	showHeaderSettingsButton: false,
	ownerViewOverrides: {},
	repositoryViewOverrides: {},
	viewOverrides: {},
};
