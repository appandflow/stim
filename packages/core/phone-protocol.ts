import type * as Wire from './protocol.ts';
import type * as State from './state/index.ts';

export { ACTIONS, PROTOCOL_VERSION } from './protocol.ts';

export type PhonePlatform = Wire.BuildPlanParams['platform'];
export type PhoneDevicePlatform = Wire.Platform;
export type PhoneReloadPlatform = Exclude<PhoneDevicePlatform, 'macos'>;
export interface PhonePairingPayload {
  v: 1;
  name: string;
  endpoint: string;
  pairingToken: string;
}

export type PhoneSimState = Omit<State.SimulatorState, 'activity' | 'app' | 'appPresence'> & {
  activity?: PhoneDeviceActivity;
  app?: PhoneDeviceAppProcess;
  appPresence?: PhoneAppPresence;
};
export type PhoneDeviceDisk = State.DiskMeasure;
export type PhoneAndroidState = Omit<
  OptionalFields<State.AndroidDeviceState, 'name'>,
  'state' | 'activity' | 'app' | 'appPresence'
> & {
  state?: string;
  activity?: PhoneDeviceActivity;
  app?: PhoneDeviceAppProcess;
  appPresence?: PhoneAppPresence;
};
export type PhoneAppPresence = string | null;
export type PhoneDeviceAppProcess = Omit<State.DeviceAppProcess, 'state'> & { state: string };
export type PhoneDeviceActivity = Omit<State.DeviceActivity, 'state'> & { state: string };
export type PhoneBuildPhase = string;
export type PhoneBuildReport = Omit<
  State.BuildReport,
  | 'outcomeKnown'
  | 'placement'
  | 'missProvisional'
  | 'platform'
  | 'state'
  | 'phase'
  | 'outcome'
  | 'cacheLookupOutcome'
  | 'plannedPhases'
  | 'missReason'
  | 'detail'
> & {
  outcomeKnown?: boolean;
  placement?: PhoneBuildPlacement;
  missProvisional?: boolean;
  platform: string;
  state: string;
  phase: PhoneBuildPhase;
  outcome: string | null;
  cacheLookupOutcome?: string;
  plannedPhases?: { phase: PhoneBuildPhase; expectedMs: number }[] | null;
  missReason?: PhoneBuildMissReason;
  detail?: PhoneBuildDetail;
};
export type PhoneBuildPlacement = string | Exclude<State.BuildPlacement, string>;
export type PhoneBuildDetail = Omit<State.BuildDetail, 'step' | 'unit'> & { step: string | null; unit: string | null };
export type PhoneBuildCacheHit = string | false;
export type PhoneBuildMissCategory = string;
export type PhoneBuildMissChange = Omit<State.BuildMissChange, 'change' | 'category'> & {
  change: string;
  category: PhoneBuildMissCategory;
};
export type PhoneBuildMissReason = Omit<State.BuildMissReason, 'kind' | 'changes' | 'baseline'> & {
  kind: string;
  changes: PhoneBuildMissChange[];
  baseline: (Omit<NonNullable<State.BuildMissReason['baseline']>, 'from'> & { from: string }) | null;
};
export type PhoneBuildPlan = Omit<
  State.BuildPlanPayload,
  'platform' | 'cacheHit' | 'prebuild' | 'outcome' | 'missReason'
> & {
  platform: string;
  cacheHit: PhoneBuildCacheHit;
  prebuild: string | null;
  outcome: string | null;
  missReason?: PhoneBuildMissReason;
};
export type PhoneBuildPlanParams = Wire.BuildPlanParams;
export type PhoneRemoteDeviceState = Omit<State.RemoteDeviceState, 'platform' | 'state' | 'backend'> & {
  platform: string | null;
  state: string;
  backend: string;
};
export type PhonePhysicalDeviceState = Omit<State.PhysicalDeviceState, 'platform' | 'connection' | 'lease'> & {
  platform: string;
  connection: string;
  lease: Omit<State.PhysicalDeviceState['lease'], 'kind'> & { kind: string };
};
export type PhoneWorktreeGit = State.WorktreeGit;
export type PhoneWorktreeFacts = Omit<State.WorktreeFacts, 'pullRequest' | 'gitChip'> & {
  pullRequest?: PhonePullRequestFacts | null;
  gitChip?: PhoneGitChipFacts;
};
export type PhoneGitChipPart = {
  kind: string;
  ahead?: number;
  behind?: number;
  count?: number;
  into?: string;
};
export type PhoneGitChipFacts = Omit<State.GitChip, 'ci' | 'parts'> & { ci: string | null; parts: PhoneGitChipPart[] };
export type PhoneStageFacts = Omit<State.WorkspaceStage, 'kind' | 'platform' | 'closedApps'> & {
  kind: string;
  platform: string | null;
  closedApps: { platform: string; slot: string }[];
};
export type PhonePullRequestFacts = Omit<State.WorktreePullRequest, 'state' | 'reviewDecision'> & {
  state: string;
  reviewDecision: string | null;
};
export type PhoneStatusIssue = Omit<State.StatusIssue, 'code' | 'severity'> & { code: string; severity: string };
export type PhoneWebBrowserState = Omit<
  OptionalFields<State.WebBrowserState, 'targetId'>,
  'browser' | 'viewport' | 'page' | 'activity'
> & {
  browser: string;
  viewport: string;
  page?: (Omit<NonNullable<State.WebBrowserState['page']>, 'state'> & { state: string }) | null;
  activity?: PhoneDeviceActivity;
};
export type PhoneMacosAppState = Omit<State.MacosAppRecord, 'build' | 'hostLaunched' | 'host'> & {
  state: string;
  build: Omit<State.MacosBuild, 'state'> & { state: string };
  hostLaunched?: boolean | string;
  host?: Omit<State.HostedMacosPlacement, 'agent'> & {
    agent: { driver: string; setting?: string; remoteConfig?: string; command?: string };
  };
};
export type PhoneEnvironmentState = Omit<
  State.EnvironmentState,
  | 'slots'
  | 'metro'
  | 'build'
  | 'issues'
  | 'android'
  | 'ios'
  | 'web'
  | 'macos'
  | 'phase'
  | 'stage'
  | 'warmStep'
  | 'memorySource'
  | 'worktree'
  | 'remoteDevices'
  | 'physicalDevices'
  | 'lastBuilds'
  | 'builds'
  | 'agents'
  | 'endedAgents'
> & {
  phase?: string;
  stage?: PhoneStageFacts;
  warmStep?: string;
  memorySource?: string;
  macos?: PhoneMacosAppState | null;
  worktree?: PhoneWorktreeFacts | null;
  remoteDevices?: PhoneRemoteDeviceState[];
  physicalDevices?: PhonePhysicalDeviceState[];
  lastBuilds?: Partial<Record<string, PhoneLastBuild>>;
  builds?: Partial<Record<string, PhoneBuildHistoryEntry[]>>;
  agents?: PhoneAgentSession[];
  endedAgents?: PhoneEndedAgentSession[];
  build?: PhoneBuildReport | null;
  issues?: PhoneStatusIssue[];
  ios?: PhoneSimState | null;
  android?: PhoneAndroidState | null;
  labelOnly?: boolean;
  web?: PhoneWebBrowserState | null;
  slots?: { slot: string; ios?: PhoneSimState | null; android?: PhoneAndroidState | null }[];
  metro?:
    | (Omit<NonNullable<State.EnvironmentState['metro']>, 'lastStop' | 'tunnel' | 'bundle' | 'idleStop'> & {
        lastStop?: { reason: string; at?: string };
        tunnel?: { provider: string; url: string };
        bundle?: PhoneMetroBundle;
        idleStop?: Omit<NonNullable<NonNullable<State.EnvironmentState['metro']>['idleStop']>, 'reason'> & {
          reason: string;
        };
      })
    | null;
};
export type PhoneAgentSession = Omit<State.AgentSession, 'tool'> & { tool: string };
export type PhoneEndedAgentSession = Omit<PhoneAgentSession, 'pid'> & { endedAt: string };
export type PhoneMetroBundle = Omit<State.MetroBundleState, 'last' | 'platform'> & {
  platform?: string;
  last?: Omit<NonNullable<State.MetroBundleState['last']>, 'platform' | 'status'> & {
    platform: string;
    status: string;
  };
};
export type PhoneWorkspaceDisk = State.EnvironmentDisk;
export type PhoneStatusUsage = Omit<Wire.UsageHistory, 'devices'> & {
  devices: (Omit<Wire.DeviceUsageSeries, 'kind'> & { kind: string })[];
};
export type PhoneBuildResult = string;
export type PhoneBuildHistoryEntry = Omit<State.BuildHistoryEntry, keyof State.LastBuildReport | 'result' | 'phases'> &
  PhoneLastBuild & { result: PhoneBuildResult; phases: Partial<Record<string, number>> };
export type PhoneLastBuild = Omit<State.LastBuildReport, 'platform' | 'status' | 'cacheHit' | 'missReason'> & {
  platform: string;
  status: string;
  cacheHit: PhoneBuildCacheHit;
  missReason?: PhoneBuildMissReason;
};
export type PhoneBuildDiagnostic = State.BuildDiagnostic;
export type PhoneDeviceLeaseState = State.DeviceLeaseState;
export type PhoneMaintenanceStatus = Omit<
  State.MaintenanceStatus,
  'mode' | 'lastPass' | 'plan' | 'pressure' | 'sizes' | 'recent'
> & {
  mode: string;
  lastPass:
    | (Omit<State.MaintenancePass, 'mode' | 'freedBytes' | 'stopped'> & {
        mode: string;
        freedBytes: number;
        stopped: number;
      })
    | null;
  plan: (Omit<State.MaintenanceAction, 'kind'> & { kind: string })[];
  pressure:
    | (Omit<State.MaintenancePressure, 'memory'> & {
        memory: Omit<State.MaintenancePressure['memory'], 'level'> & { level: string | null };
      })
    | null;
};
export type PhoneStatusPayload = Omit<
  State.StatusPayload,
  'environments' | 'machine' | 'unprovisionedWorktrees' | 'archived' | 'maintenance'
> & {
  maintenance?: PhoneMaintenanceStatus;
  archived?: (Omit<State.ArchivedWorkspace, 'agents' | 'builds'> & {
    agents: PhoneEndedAgentSession[];
    builds: Omit<State.ArchivedWorkspace['builds'], 'last'> & { last: PhoneLastBuild | null };
  })[];
  unprovisionedWorktrees?: PhoneWorktreeFacts[];
  environments: PhoneEnvironmentState[];
  machine?: PhoneMachineUsageState | null;
  ownLeases?: string[];
};
export type PhoneMachineOwnerKind = string;
export type PhoneMachineOwner = Omit<OptionalFields<State.MachineOwner, 'memoryMb'>, 'kind'> & {
  kind: PhoneMachineOwnerKind;
};
export type PhoneMachineUsageState = Omit<State.MachineUsageState, 'owners' | 'memorySource'> & {
  memorySource?: string;
  owners: PhoneMachineOwner[];
};
export type PhoneLogSource = Wire.LogSource;
export type PhoneLogLevel = Wire.LogLevel;
export interface PhoneStackFrame {
  file?: string | null;
  line?: number | null;
  column?: number | null;
  fn?: string | null;
}

export type PhoneLogRecord = Wire.LogRecord & {
  ts: number;
  src: PhoneLogSource;
  level: PhoneLogLevel;
  msg: string;
  slot?: string;
  event?: string;
  stack?: PhoneStackFrame[];
  deviceId?: string;
};
export type PhoneLogFilter = Wire.LogFilter;
export type PhoneFrameTarget = Wire.FrameTarget;
export type PhoneReplayRate = 0 | 1 | 2;

export type PhoneReplaySpan = Wire.ReplaySpan;
export type PhoneReplayMarker = Omit<Wire.ReplayMarker, 'kind'> & { kind: string };
export type PhoneReplayKeyframe = Omit<Wire.ReplayKeyframe, 'posture'> & { posture?: string };
export type PhoneReplayRange = Omit<Wire.ReplayRange, 'markers'> & { markers: PhoneReplayMarker[] };
export type PhoneReplayEndedEvent = Wire.ReplayEndedEvent;
export type PhoneControlBeginParams = Wire.ControlBeginParams;
export type PhoneControlBeginResult = Omit<Wire.ControlBeginResult, 'platform' | 'postures'> & {
  platform: string;
  postures: string[];
};
export type PhoneSimulatorOptions = Wire.SimulatorOptions;
export type PhoneSimulatorCommand = Wire.SimulatorCommand;
export type PhoneInputSimulatorParams = Wire.InputSimulatorParams;
export type PhoneTouchPhase = Wire.TouchPhase;
export type PhoneInputButton = Wire.InputButton;
export type PhoneInputKey = Wire.InputKey;
export type PhoneKeyModifier = Wire.KeyModifier;
export type PhoneRotateDirection = Wire.RotateDirection;
export type PhoneDevicePosture = Wire.DevicePosture;
export type PhoneActionName = Wire.ActionName;
export type PhoneActionParams = Wire.ActionParams;
export type PhoneActionResult = Omit<Wire.ActionResult, 'action'> & { action: string };
export type PhoneMemoryPressure = string;
export type PhoneMachineVolume = Wire.MachineVolume;
export type PhoneMachineUsage = Omit<OptionalFields<Wire.MachineUsage, 'cpu'>, 'memory'> & {
  memory: Omit<Wire.MachineUsage['memory'], 'pressure'> & { pressure: PhoneMemoryPressure | null };
};
export type PhoneUsageSample = Omit<Wire.UsageSample, 'memoryPressure'> & { memoryPressure: number | null };
export type PhoneMachineHistory = Omit<Wire.MachineHistory, 'samples'> & { samples: PhoneUsageSample[] };
export type PhoneMachineDetails = OptionalFields<Wire.MachineDetails, 'buildMachines'>;
export type PhoneBuildClientSummary = Wire.BuildClientSummary;
export type PhoneBuildMachineReport = Wire.BuildMachineReport;
export type PhoneClientAuth = Wire.PairingAuth | Wire.DeviceAuth;
export type PhonePushEvent = Wire.PushEvent;
export type PhoneNotificationLevel = Wire.NotificationLevel;
export type PhonePushRegisterParams = Wire.PushRegisterParams;
export type PhoneNotificationSuppression = Wire.NotificationSuppression;
export type PhoneNotificationTarget = {
  kind: string;
  path?: string;
  platform?: string;
  slot?: string;
  url?: string;
};
export type PhoneWorkspaceFile = Wire.WorkspaceFile;
export type PhoneWorkspaceFiles = Wire.WorkspaceFiles;
export type PhoneWorkspacePatch = Omit<Wire.WorkspacePatch, 'section' | 'kind'> & { section: string; kind: string };
export type PhoneWorkspaceDiff = Omit<Wire.WorkspaceDiff, 'patches'> & { patches: PhoneWorkspacePatch[] };
export type PhoneNotificationEntry = Omit<Wire.NotificationEntry, 'category' | 'suppressed' | 'target'> & {
  category: string;
  suppressed?: string;
  target: PhoneNotificationTarget;
};
export type PhoneNotificationsListResult = Omit<Wire.NotificationsListResult, 'notifications'> & {
  notifications: PhoneNotificationEntry[];
};
export type PhoneProtocolError = Omit<Wire.ProtocolError, 'code'> & { code: string };
export type PhoneStatusEvent = Omit<Wire.StatusEvent, 'payload' | 'usage'> & {
  payload: PhoneStatusPayload;
  usage?: PhoneStatusUsage;
};
export type PhoneLogsEndedEvent = Wire.LogsEndedEvent;
export type PhoneLogsEvent = Omit<Wire.LogsEvent, 'records'> & { records: PhoneLogRecord[] };
export type PhoneDeviceFrameArtwork = Wire.DeviceFrameArtwork;
export type PhoneDeviceFrameEvent = Wire.DeviceFrameEvent;
export type PhoneMacosWindowsEvent = OptionalFields<Wire.MacosWindowsEvent, 'pinned'>;
export type PhoneFrameEvent = Omit<Wire.FrameEvent, 'platform' | 'posture' | 'mime'> & {
  platform: string;
  posture?: string;
  mime: string;
};
export type PhoneFrameDelayedEvent = Wire.FrameDelayedEvent;
export type PhoneErrorEvent = OptionalFields<Omit<Wire.ErrorEvent, 'error'>, 'subscription'> & {
  error: PhoneProtocolError;
};
export type PhoneControlEndedEvent = Omit<Wire.ControlEndedEvent, 'reason'> & { reason: string };
export type PhoneNotificationEvent = Omit<Wire.NotificationEvent, 'notification'> & {
  notification: PhoneNotificationEntry;
};
export type PhoneServerEvent =
  | Exclude<
      Wire.ServerEvent,
      | Wire.BuildProgressEvent
      | Wire.StatusEvent
      | Wire.LogsEvent
      | Wire.ErrorEvent
      | Wire.FrameEvent
      | Wire.ControlEndedEvent
      | Wire.NotificationEvent
      | Wire.MacosWindowsEvent
    >
  | PhoneMacosWindowsEvent
  | PhoneStatusEvent
  | PhoneLogsEvent
  | PhoneErrorEvent
  | PhoneFrameEvent
  | PhoneControlEndedEvent
  | PhoneNotificationEvent;

/** Fields introduced after protocol v1's initial release remain optional on the receiving client. */
type OptionalFields<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type PhoneHelloResult = OptionalFields<
  Omit<Wire.HelloResult, 'server' | 'features' | 'capabilities' | 'actions' | 'approval'>,
  'device'
> & {
  actions?: string[];
  server: OptionalFields<Wire.HelloResult['server'], 'home'>;
  features?: string[];
  capabilities: string[];
  approval?: { state: string; expiresAt: string };
};

export type PhoneMethods = Omit<
  Wire.Methods,
  | (typeof Wire.BUILD_METHODS)[number]
  | (typeof Wire.DEVICE_HOST_METHODS)[number]
  | (typeof Wire.SERVER_UPDATE_METHODS)[number]
  | 'machines.update.start'
  | 'machines.update.status'
  | 'route.setup'
  | 'hello'
  | 'logs.query'
  | 'machine.get'
  | 'machine.details'
  | 'machine.history'
  | 'workspace.diff'
  | 'frames.subscribe'
  | 'replay.range'
  | 'replay.keyframe'
  | 'build.plan'
  | 'action'
  | 'control.begin'
  | 'notifications.list'
> & {
  hello: { params: Omit<Wire.HelloParams, 'auth'> & { auth: PhoneClientAuth }; result: PhoneHelloResult };
  'machine.history': { params: Wire.Methods['machine.history']['params']; result: PhoneMachineHistory };
  'workspace.diff': { params: Wire.Methods['workspace.diff']['params']; result: PhoneWorkspaceDiff };
  'frames.subscribe': {
    params: Wire.FrameTarget;
    result: Omit<Wire.FramesSubscribeResult, 'video'> & { video?: string };
  };
  'replay.range': { params: Wire.ReplayTarget; result: PhoneReplayRange };
  'replay.keyframe': { params: Wire.ReplayKeyframeParams; result: PhoneReplayKeyframe };
  'build.plan': { params: Wire.BuildPlanParams; result: PhoneBuildPlan };
  action: { params: Wire.ActionParams; result: PhoneActionResult };
  'control.begin': { params: Wire.ControlBeginParams; result: PhoneControlBeginResult };
  'notifications.list': { params: Wire.Methods['notifications.list']['params']; result: PhoneNotificationsListResult };
  'machine.get': { params?: Record<string, never>; result: PhoneMachineUsage };
  'machine.details': { params?: Record<string, never>; result: PhoneMachineDetails };
  'logs.query': {
    params: Wire.LogFilter;
    result: Omit<Wire.LogsQueryResult, 'records'> & { records: PhoneLogRecord[] };
  };
};
export type PhoneMethod = keyof PhoneMethods;
export type PhoneResponse<M extends PhoneMethod = PhoneMethod> =
  | { id: number; result: PhoneMethods[M]['result'] }
  | { id: number; error: PhoneProtocolError };
export type PhoneServerMessage = PhoneResponse | PhoneServerEvent;

export type {
  PhonePlatform as Platform,
  PhoneDevicePlatform as DevicePlatform,
  PhoneReloadPlatform as ReloadPlatform,
  PhonePairingPayload as PairingPayload,
  PhoneSimState as SimState,
  PhoneDeviceDisk as DeviceDisk,
  PhoneAndroidState as AndroidState,
  PhoneAppPresence as AppPresence,
  PhoneDeviceAppProcess as DeviceAppProcess,
  PhoneDeviceActivity as DeviceActivity,
  PhoneBuildPhase as BuildPhase,
  PhoneBuildReport as BuildReport,
  PhoneBuildPlacement as BuildPlacement,
  PhoneBuildDetail as BuildDetail,
  PhoneBuildCacheHit as BuildCacheHit,
  PhoneBuildMissCategory as BuildMissCategory,
  PhoneBuildMissChange as BuildMissChange,
  PhoneBuildMissReason as BuildMissReason,
  PhoneBuildPlan as BuildPlan,
  PhoneBuildPlanParams as BuildPlanParams,
  PhoneRemoteDeviceState as RemoteDeviceState,
  PhonePhysicalDeviceState as PhysicalDeviceState,
  PhoneWorktreeGit as WorktreeGit,
  PhoneWorktreeFacts as WorktreeFacts,
  PhoneGitChipPart as GitChipPart,
  PhoneGitChipFacts as GitChipFacts,
  PhoneStageFacts as StageFacts,
  PhonePullRequestFacts as PullRequestFacts,
  PhoneStatusIssue as StatusIssue,
  PhoneWebBrowserState as WebBrowserState,
  PhoneMacosAppState as MacosAppState,
  PhoneEnvironmentState as EnvironmentState,
  PhoneAgentSession as AgentSession,
  PhoneEndedAgentSession as EndedAgentSession,
  PhoneMetroBundle as MetroBundle,
  PhoneWorkspaceDisk as WorkspaceDisk,
  PhoneStatusUsage as StatusUsage,
  PhoneBuildResult as BuildResult,
  PhoneBuildHistoryEntry as BuildHistoryEntry,
  PhoneLastBuild as LastBuild,
  PhoneBuildDiagnostic as BuildDiagnostic,
  PhoneDeviceLeaseState as DeviceLeaseState,
  PhoneStatusPayload as StatusPayload,
  PhoneMachineOwnerKind as MachineOwnerKind,
  PhoneMachineOwner as MachineOwner,
  PhoneMachineUsageState as MachineUsageState,
  PhoneLogSource as LogSource,
  PhoneLogLevel as LogLevel,
  PhoneStackFrame as StackFrame,
  PhoneLogRecord as LogRecord,
  PhoneLogFilter as LogFilter,
  PhoneFrameTarget as FrameTarget,
  PhoneReplayRate as ReplayRate,
  PhoneReplaySpan as ReplaySpan,
  PhoneReplayMarker as ReplayMarker,
  PhoneReplayKeyframe as ReplayKeyframe,
  PhoneReplayRange as ReplayRange,
  PhoneReplayEndedEvent as ReplayEndedEvent,
  PhoneControlBeginParams as ControlBeginParams,
  PhoneControlBeginResult as ControlBeginResult,
  PhoneSimulatorOptions as SimulatorOptions,
  PhoneSimulatorCommand as SimulatorCommand,
  PhoneInputSimulatorParams as InputSimulatorParams,
  PhoneTouchPhase as TouchPhase,
  PhoneInputButton as InputButton,
  PhoneInputKey as InputKey,
  PhoneKeyModifier as KeyModifier,
  PhoneRotateDirection as RotateDirection,
  PhoneDevicePosture as DevicePosture,
  PhoneActionName as ActionName,
  PhoneActionParams as ActionParams,
  PhoneActionResult as ActionResult,
  PhoneMemoryPressure as MemoryPressure,
  PhoneMachineVolume as MachineVolume,
  PhoneMachineUsage as MachineUsage,
  PhoneUsageSample as UsageSample,
  PhoneMachineHistory as MachineHistory,
  PhoneMachineDetails as MachineDetails,
  PhoneBuildClientSummary as BuildClientSummary,
  PhoneBuildMachineReport as BuildMachineReport,
  PhoneClientAuth as ClientAuth,
  PhonePushEvent as PushEvent,
  PhoneNotificationLevel as NotificationLevel,
  PhonePushRegisterParams as PushRegisterParams,
  PhoneNotificationSuppression as NotificationSuppression,
  PhoneNotificationTarget as NotificationTarget,
  PhoneWorkspaceFile as WorkspaceFile,
  PhoneWorkspaceFiles as WorkspaceFiles,
  PhoneWorkspacePatch as WorkspacePatch,
  PhoneWorkspaceDiff as WorkspaceDiff,
  PhoneNotificationEntry as NotificationEntry,
  PhoneNotificationsListResult as NotificationsListResult,
  PhoneProtocolError as ProtocolError,
  PhoneStatusEvent as StatusEvent,
  PhoneLogsEvent as LogsEvent,
  PhoneLogsEndedEvent as LogsEndedEvent,
  PhoneDeviceFrameArtwork as DeviceFrameArtwork,
  PhoneDeviceFrameEvent as DeviceFrameEvent,
  PhoneMacosWindowsEvent as MacosWindowsEvent,
  PhoneFrameEvent as FrameEvent,
  PhoneFrameDelayedEvent as FrameDelayedEvent,
  PhoneErrorEvent as ErrorEvent,
  PhoneControlEndedEvent as ControlEndedEvent,
  PhoneNotificationEvent as NotificationEvent,
  PhoneServerEvent as ServerEvent,
  PhoneHelloResult as HelloResult,
  PhoneMethods as Methods,
  PhoneMethod as Method,
  PhoneResponse as Response,
  PhoneServerMessage as ServerMessage,
};
