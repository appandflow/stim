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

export type PhoneSimState = State.SimulatorState;
export type PhoneDeviceDisk = State.DiskMeasure;
export type PhoneAndroidState = OptionalFields<State.AndroidDeviceState, 'name'>;
export type PhoneAppPresence = State.AppPresence;
export type PhoneDeviceAppProcess = State.DeviceAppProcess;
export type PhoneDeviceActivity = State.DeviceActivity;
export type PhoneBuildPhase = State.BuildPhase;
export type PhoneBuildReport = OptionalFields<State.BuildReport, 'outcomeKnown' | 'plannedPhases' | 'placement'>;
export type PhoneBuildPlacement = State.BuildPlacement;
export type PhoneBuildDetail = State.BuildDetail;
export type PhoneBuildCacheHit = State.BuildCacheHit;
export type PhoneBuildMissCategory = State.BuildMissCategory;
export type PhoneBuildMissChange = State.BuildMissChange;
export type PhoneBuildMissReason = State.BuildMissReason;
export type PhoneBuildPlan = State.BuildPlanPayload;
export type PhoneBuildPlanParams = Wire.BuildPlanParams;
export type PhoneRemoteDeviceState = State.RemoteDeviceState;
export type PhonePhysicalDeviceState = State.PhysicalDeviceState;
export type PhoneWorktreeGit = State.WorktreeGit;
export type PhoneWorktreeFacts = State.WorktreeFacts;
export type PhoneGitChipPart = State.GitChipPart;
export type PhoneGitChipFacts = State.GitChip;
export type PhoneStageFacts = State.WorkspaceStage;
export type PhonePullRequestFacts = State.WorktreePullRequest;
export type PhoneStatusIssue = Omit<State.StatusIssue, 'code'> & { code: string };
export type PhoneWebBrowserState = OptionalFields<State.WebBrowserState, 'targetId'>;
export type PhoneMacosAppState = State.MacosAppState;
export type PhoneEnvironmentState = Omit<
  State.EnvironmentState,
  'slots' | 'metro' | 'build' | 'issues' | 'android' | 'ios' | 'web'
> & {
  build?: PhoneBuildReport | null;
  issues?: PhoneStatusIssue[];
  ios?: PhoneSimState | null;
  android?: PhoneAndroidState | null;
  labelOnly?: boolean;
  web?: PhoneWebBrowserState | null;
  slots?: { slot: string; ios?: PhoneSimState | null; android?: PhoneAndroidState | null }[];
  metro?:
    | (Omit<NonNullable<State.EnvironmentState['metro']>, 'lastStop'> & { lastStop?: { reason: string; at?: string } })
    | null;
};
export type PhoneAgentSession = State.AgentSession;
export type PhoneEndedAgentSession = State.EndedAgentSession;
export type PhoneMetroBundle = State.MetroBundleState;
export type PhoneWorkspaceDisk = State.EnvironmentDisk;
export type PhoneStatusUsage = Wire.UsageHistory;
export type PhoneBuildResult = State.BuildResult;
export type PhoneBuildHistoryEntry = State.BuildHistoryEntry;
export type PhoneLastBuild = State.LastBuildReport;
export type PhoneBuildDiagnostic = State.BuildDiagnostic;
export type PhoneDeviceLeaseState = State.DeviceLeaseState;
export type PhoneStatusPayload = OptionalFields<
  Omit<State.StatusPayload, 'environments' | 'machine'>,
  'unprovisionedWorktrees'
> & {
  environments: PhoneEnvironmentState[];
  machine?: PhoneMachineUsageState | null;
  ownLeases?: string[];
};
export type PhoneMachineOwnerKind = State.MachineOwnerKind;
export type PhoneMachineOwner = OptionalFields<State.MachineOwner, 'memoryMb'>;
export type PhoneMachineUsageState = OptionalFields<Omit<State.MachineUsageState, 'owners'>, 'memorySource'> & {
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
export type PhoneReplayMarker = Wire.ReplayMarker;
export type PhoneReplayKeyframe = Wire.ReplayKeyframe;
export type PhoneReplayRange = Wire.ReplayRange;
export type PhoneReplayEndedEvent = Wire.ReplayEndedEvent;
export type PhoneControlBeginParams = Wire.ControlBeginParams;
export type PhoneControlBeginResult = Wire.ControlBeginResult;
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
export type PhoneActionResult = Wire.ActionResult;
export type PhoneMemoryPressure = Wire.MemoryPressure;
export type PhoneMachineVolume = Wire.MachineVolume;
export type PhoneMachineUsage = OptionalFields<Wire.MachineUsage, 'cpu'>;
export type PhoneUsageSample = Omit<Wire.UsageSample, 'memoryPressure'> & { memoryPressure: number | null };
export type PhoneMachineHistory = Wire.MachineHistory;
export type PhoneMachineDetails = OptionalFields<Wire.MachineDetails, 'buildMachines'>;
export type PhoneBuildClientSummary = Wire.BuildClientSummary;
export type PhoneBuildMachineReport = Wire.BuildMachineReport;
export type PhoneClientAuth = Wire.PairingAuth | Wire.DeviceAuth;
export type PhonePushEvent = Wire.PushEvent;
export type PhoneNotificationLevel = Wire.NotificationLevel;
export type PhonePushRegisterParams = Wire.PushRegisterParams;
export type PhoneNotificationSuppression = Wire.NotificationSuppression;
export type PhoneNotificationTarget = Wire.NotificationTarget;
export type PhoneWorkspaceFile = Wire.WorkspaceFile;
export type PhoneWorkspaceFiles = Wire.WorkspaceFiles;
export type PhoneWorkspacePatch = Wire.WorkspacePatch;
export type PhoneWorkspaceDiff = Wire.WorkspaceDiff;
export type PhoneNotificationEntry = Wire.NotificationEntry;
export type PhoneNotificationsListResult = Wire.NotificationsListResult;
export type PhoneProtocolError = Omit<Wire.ProtocolError, 'code'> & { code: string };
export type PhoneStatusEvent = Omit<Wire.StatusEvent, 'payload' | 'usage'> & {
  payload: PhoneStatusPayload;
  usage?: PhoneStatusUsage;
};
export type PhoneLogsEvent = Omit<Wire.LogsEvent, 'records'> & { records: PhoneLogRecord[] };
export type PhoneDeviceFrameArtwork = Wire.DeviceFrameArtwork;
export type PhoneDeviceFrameEvent = Wire.DeviceFrameEvent;
export type PhoneFrameEvent = Wire.FrameEvent;
export type PhoneFrameDelayedEvent = Wire.FrameDelayedEvent;
export type PhoneErrorEvent = OptionalFields<Omit<Wire.ErrorEvent, 'error'>, 'subscription'> & {
  error: PhoneProtocolError;
};
export type PhoneControlEndedEvent = Wire.ControlEndedEvent;
export type PhoneNotificationEvent = Wire.NotificationEvent;
export type PhoneServerEvent =
  | Exclude<Wire.ServerEvent, Wire.BuildProgressEvent | Wire.StatusEvent | Wire.LogsEvent | Wire.ErrorEvent>
  | PhoneStatusEvent
  | PhoneLogsEvent
  | PhoneErrorEvent;

/** Fields introduced after protocol v1's initial release remain optional on the receiving client. */
type OptionalFields<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type PhoneHelloResult = OptionalFields<
  Omit<Wire.HelloResult, 'server' | 'features' | 'capabilities' | 'actions'>,
  'device'
> & {
  actions?: string[];
  server: OptionalFields<Wire.HelloResult['server'], 'home'>;
  features?: string[];
  capabilities: string[];
};

export type PhoneMethods = Omit<
  Wire.Methods,
  | (typeof Wire.BUILD_METHODS)[number]
  | (typeof Wire.DEVICE_HOST_METHODS)[number]
  | 'route.setup'
  | 'hello'
  | 'logs.query'
  | 'machine.get'
  | 'machine.details'
> & {
  hello: { params: Omit<Wire.HelloParams, 'auth'> & { auth: PhoneClientAuth }; result: PhoneHelloResult };
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
  PhoneDeviceFrameArtwork as DeviceFrameArtwork,
  PhoneDeviceFrameEvent as DeviceFrameEvent,
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
