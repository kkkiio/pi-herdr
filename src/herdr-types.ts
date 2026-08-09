export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentSessionInfo {
	source: string;
	agent: string;
	kind: "id" | "path";
	value: string;
}

export interface PaneScrollInfo {
	offset_from_bottom: number;
	max_offset_from_bottom: number;
	viewport_rows: number;
}

export interface AgentInfo {
	terminal_id: string;
	agent_status: AgentStatus;
	workspace_id: string;
	tab_id: string;
	pane_id: string;
	focused: boolean;
	revision: number;
	agent?: string | null;
	agent_session?: AgentSessionInfo | null;
	cwd?: string | null;
	display_agent?: string | null;
	foreground_cwd?: string | null;
	interactive_ready?: boolean;
	launch_pending?: boolean;
	name?: string | null;
	screen_detection_skipped?: boolean;
	state_change_seq?: number;
	state_labels?: Record<string, string>;
	terminal_title?: string | null;
	terminal_title_stripped?: string | null;
	title?: string | null;
	tokens?: Record<string, string>;
	[key: string]: unknown;
}

export interface PaneInfo {
	pane_id: string;
	terminal_id: string;
	workspace_id: string;
	tab_id: string;
	focused: boolean;
	agent_status: AgentStatus;
	revision: number;
	agent?: string | null;
	agent_session?: AgentSessionInfo | null;
	cwd?: string | null;
	display_agent?: string | null;
	foreground_cwd?: string | null;
	label?: string | null;
	scroll?: PaneScrollInfo | null;
	state_labels?: Record<string, string>;
	terminal_title?: string | null;
	terminal_title_stripped?: string | null;
	title?: string | null;
	tokens?: Record<string, string>;
	[key: string]: unknown;
}

export interface TabInfo {
	tab_id: string;
	workspace_id: string;
	number: number;
	label: string;
	focused: boolean;
	pane_count: number;
	agent_status: AgentStatus;
	[key: string]: unknown;
}

export interface WorkspaceWorktreeInfo {
	repo_key: string;
	repo_name: string;
	repo_root: string;
	checkout_path: string;
	is_linked_worktree: boolean;
}

export interface WorkspaceInfo {
	workspace_id: string;
	number: number;
	label: string;
	focused: boolean;
	pane_count: number;
	tab_count: number;
	active_tab_id: string;
	agent_status: AgentStatus;
	tokens?: Record<string, string>;
	worktree?: WorkspaceWorktreeInfo | null;
	[key: string]: unknown;
}

export interface WorktreeInfo {
	path: string;
	branch?: string | null;
	is_bare: boolean;
	is_detached: boolean;
	is_prunable: boolean;
	is_linked_worktree: boolean;
	label: string;
	open_workspace_id?: string | null;
	[key: string]: unknown;
}

export interface PaneLayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PaneLayoutPane {
	pane_id: string;
	focused: boolean;
	rect: PaneLayoutRect;
}

export interface PaneLayoutSplit {
	id: string;
	direction: "right" | "down";
	ratio: number;
	rect: PaneLayoutRect;
}

export interface PaneLayoutSnapshot {
	workspace_id: string;
	tab_id: string;
	zoomed: boolean;
	area: PaneLayoutRect;
	focused_pane_id: string;
	panes: PaneLayoutPane[];
	splits: PaneLayoutSplit[];
	[key: string]: unknown;
}

export interface SessionSnapshot {
	version: string;
	protocol: number;
	workspaces: WorkspaceInfo[];
	tabs: TabInfo[];
	panes: PaneInfo[];
	layouts: PaneLayoutSnapshot[];
	agents: AgentInfo[];
	focused_workspace_id?: string | null;
	focused_tab_id?: string | null;
	focused_pane_id?: string | null;
	[key: string]: unknown;
}

export interface PongResult {
	type: "pong";
	version: string;
	protocol: number;
	capabilities?: {
		live_handoff: boolean;
		detached_server_daemon?: boolean;
		[key: string]: unknown;
	} | null;
}

export interface SessionSnapshotResult {
	type: "session_snapshot";
	snapshot: SessionSnapshot;
}

export interface TabInfoResult {
	type: "tab_info";
	tab: TabInfo;
}

export interface TabCreatedResult {
	type: "tab_created";
	tab: TabInfo;
	root_pane: PaneInfo;
}

export interface WorktreeCreatedResult {
	type: "worktree_created";
	workspace: WorkspaceInfo;
	tab: TabInfo;
	root_pane: PaneInfo;
	worktree: WorktreeInfo;
}

export interface WorktreeRemovedResult {
	type: "worktree_removed";
	workspace_id: string;
	path: string;
	forced: boolean;
}

export interface AgentInfoResult {
	type: "agent_info";
	agent: AgentInfo;
}

export interface AgentStartedResult {
	type: "agent_started";
	agent: AgentInfo;
	argv: string[];
}

export interface AgentPromptedResult {
	type: "agent_prompted";
	agent: AgentInfo;
}

export interface AgentListResult {
	type: "agent_list";
	agents: AgentInfo[];
}

export interface PaneInfoResult {
	type: "pane_info";
	pane: PaneInfo;
}

export interface PaneCurrentResult {
	type: "pane_current";
	pane: PaneInfo;
}

export interface SubscriptionStartedResult {
	type: "subscription_started";
}

export interface OkResult {
	type: "ok";
}

export type HerdrResult =
	| PongResult
	| SessionSnapshotResult
	| TabInfoResult
	| TabCreatedResult
	| WorktreeCreatedResult
	| WorktreeRemovedResult
	| AgentInfoResult
	| AgentStartedResult
	| AgentPromptedResult
	| AgentListResult
	| PaneInfoResult
	| PaneCurrentResult
	| SubscriptionStartedResult
	| OkResult;

export interface HerdrSuccessResponse<T = HerdrResult> {
	id: string;
	result: T;
}

export interface HerdrErrorResponse {
	id: string;
	error: {
		code: string;
		message: string;
	};
}

export interface TabCreateParams {
	workspace_id?: string | null;
	cwd?: string | null;
	env?: Record<string, string>;
	focus?: boolean;
	label?: string | null;
}

export interface TabRenameParams {
	tab_id: string;
	label: string;
}

export type WorktreeCreateParams = {
	base?: string | null;
	branch?: string | null;
	focus?: boolean;
	label?: string | null;
	path?: string | null;
} & ({ workspace_id: string; cwd?: null } | { cwd: string; workspace_id?: null } | { workspace_id?: null; cwd?: null });

export interface WorktreeRemoveParams {
	workspace_id: string;
	force?: boolean;
}

export interface AgentStartParams {
	name: string;
	kind: string;
	pane_id: string;
	args?: string[];
	timeout_ms?: number | null;
}

export interface AgentPromptParams {
	target: string;
	text: string;
	wait?: {
		until?: AgentStatus[];
		timeout_ms?: number | null;
	} | null;
}

export interface AgentTargetParams {
	target: string;
}

export interface AgentRenameParams extends AgentTargetParams {
	name?: string | null;
}

export interface PaneCurrentParams {
	caller_pane_id?: string | null;
}

export interface PaneTargetParams {
	pane_id: string;
}

export interface TabTargetParams {
	tab_id: string;
}

export type HerdrReadMethod =
	"ping" | "session.snapshot" | "agent.list" | "agent.get" | "pane.current" | "pane.get" | "tab.get";

export type HerdrMutationMethod =
	| "tab.create"
	| "tab.rename"
	| "tab.close"
	| "worktree.create"
	| "worktree.remove"
	| "agent.start"
	| "agent.prompt"
	| "agent.rename"
	| "pane.close";

export interface HerdrMethodParams {
	ping: Record<string, never>;
	"session.snapshot": Record<string, never>;
	"agent.list": Record<string, never>;
	"agent.get": AgentTargetParams;
	"pane.current": PaneCurrentParams;
	"pane.get": PaneTargetParams;
	"tab.get": TabTargetParams;
	"tab.create": TabCreateParams;
	"tab.rename": TabRenameParams;
	"tab.close": TabTargetParams;
	"worktree.create": WorktreeCreateParams;
	"worktree.remove": WorktreeRemoveParams;
	"agent.start": AgentStartParams;
	"agent.prompt": AgentPromptParams;
	"agent.rename": AgentRenameParams;
	"pane.close": PaneTargetParams;
}

export interface HerdrMethodResults {
	ping: PongResult;
	"session.snapshot": SessionSnapshotResult;
	"agent.list": AgentListResult;
	"agent.get": AgentInfoResult;
	"pane.current": PaneCurrentResult;
	"pane.get": PaneInfoResult;
	"tab.get": TabInfoResult;
	"tab.create": TabCreatedResult;
	"tab.rename": TabInfoResult;
	"tab.close": OkResult;
	"worktree.create": WorktreeCreatedResult;
	"worktree.remove": WorktreeRemovedResult;
	"agent.start": AgentStartedResult;
	"agent.prompt": AgentPromptedResult;
	"agent.rename": AgentInfoResult;
	"pane.close": OkResult;
}

export type HerdrSubscription =
	| { type: "pane.agent_detected" }
	| { type: "pane.agent_status_changed"; pane_id: string; agent_status?: AgentStatus | null }
	| { type: "pane.closed" }
	| { type: "pane.exited" }
	| { type: "tab.closed" }
	| { type: "tab.renamed" };

export interface PaneAgentDetectedEvent {
	event: "pane_agent_detected";
	data: {
		type: "pane_agent_detected";
		pane_id: string;
		workspace_id: string;
		agent?: string | null;
		released?: boolean;
		final_status?: AgentStatus | null;
		[key: string]: unknown;
	};
}

export interface TrackedPaneAgentStatusChangedEvent {
	event: "pane.agent_status_changed";
	data: {
		pane_id: string;
		workspace_id: string;
		agent_status: AgentStatus;
		agent?: string | null;
		title?: string | null;
		display_agent?: string | null;
		state_labels?: Record<string, string>;
		[key: string]: unknown;
	};
}

export interface PaneClosedEvent {
	event: "pane_closed";
	data: {
		type: "pane_closed";
		pane_id: string;
		workspace_id: string;
		[key: string]: unknown;
	};
}

export interface PaneExitedEvent {
	event: "pane_exited";
	data: {
		type: "pane_exited";
		pane_id: string;
		workspace_id: string;
		[key: string]: unknown;
	};
}

export interface TabClosedEvent {
	event: "tab_closed";
	data: {
		type: "tab_closed";
		tab_id: string;
		workspace_id: string;
		[key: string]: unknown;
	};
}

export interface TabRenamedEvent {
	event: "tab_renamed";
	data: {
		type: "tab_renamed";
		tab_id: string;
		workspace_id: string;
		label: string;
		[key: string]: unknown;
	};
}

export type HerdrEvent =
	| PaneAgentDetectedEvent
	| TrackedPaneAgentStatusChangedEvent
	| PaneClosedEvent
	| PaneExitedEvent
	| TabClosedEvent
	| TabRenamedEvent;

export type HerdrEventListener = (event: HerdrEvent) => void | Promise<void>;
