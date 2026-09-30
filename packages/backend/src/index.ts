export const packageName = '@cerebra/backend';

export {
  createDatabase,
  liveRunStates,
  type Database,
  type LiveRunState,
  type RunState,
} from './database.js';
export {
  agentRoles,
  agentTypesDirectory,
  InvalidAgentTypeError,
  modelOptions,
  parseAgentTypeDefinition,
  readAgentTypeDefinitions,
  type AgentModel,
  type AgentRole,
  type AgentTrigger,
  type AgentTypeDefinition,
} from './agent-types.js';
export {
  AgentHoldsWorkError,
  AgentNotFoundError,
  AgentTypeNotFoundError,
  createDefaultFleet,
  createFleet,
  DuplicateAgentNameError,
  InvalidAgentChangeError,
  InvalidAgentNameError,
  InvalidRoleSettingsError,
  NoAgentTypesError,
  type AgentActivity,
  type Fleet,
  type FleetItem,
  type FleetPerson,
  type FleetRole,
  type FleetView,
  type RoleSettings,
  type RunControl,
  type StartMode,
} from './fleet.js';
export {
  createAuthService,
  type AuthService,
  type AuthStatus,
  type AuthenticationResult,
} from './auth.js';
export {
  boardRoutes,
  boardSorts,
  createBoard,
  ProjectNotFoundError,
  WorkItemNotFoundError,
  type Board,
  type BoardComment,
  type BoardFilters,
  type BoardHistoryEntry,
  type BoardPage,
  type BoardProvenance,
  type BoardQuery,
  type BoardRecord,
  type DeliveryActivity,
  type DeliveryCurrent,
  type DeliveryEvent,
  type BoardRoute,
  type BoardSort,
  type BoardWorkItem,
  type TriageResult,
} from './board.js';
export {
  agentContainerLabels,
  agentContainerName,
  agentContainerPaths,
  agentContainerRequest,
  ContainerNotFoundError,
  containerStatuses,
  defaultAgentUser,
  defaultStopTimeoutSeconds,
  EngineError,
  InvalidContainerSpecError,
  stopTimeoutSeconds,
  type AgentContainerRequest,
  type AgentContainerResources,
  type AgentContainerSpec,
  type ContainerEngine,
  type ContainerInfo,
  type ContainerStatus,
  type EngineOperation,
  type EngineSettings,
  type StopOptions,
} from './engine.js';
export { createFakeEngine, type FakeEngine } from './fake-engine.js';
export {
  createEnvelopeCipher,
  type EnvelopeCipher,
  type SealedValue,
} from './credential-cipher.js';
export {
  agentGitHubCredentialName,
  builtInAgentTypes,
  builtInDeliveries,
  createCredentialService,
  CredentialInputError,
  CredentialNotFoundError,
  DuplicateDestinationError,
  modelCredentialName,
  type AgentCredentialDelivery,
  type AgentCredentialEntry,
  type AgentCredentialSettings,
  type CredentialAttention,
  type CredentialDeliveryMethod,
  type CredentialOverview,
  type CredentialProblem,
  type CredentialRow,
  type CredentialScope,
  type CredentialService,
  type RunCredentials,
  type SaveCredential,
} from './credentials.js';
export {
  createInstanceService,
  type InstanceService,
  type InstanceStatus,
} from './instance.js';
export {
  createWorkItem,
  transition,
  transitionTable,
  workItemStates,
  type LifecycleContext,
  type LifecycleEffect,
  type LifecycleRole,
  type Priority,
  type TransitionRequest,
  type TransitionResult,
  type WaitingKind,
  type WorkItem,
  type WorkItemState,
} from './lifecycle.js';
export {
  compareQueueEntries,
  createNavigatorQueue,
  type InstanceNotice,
  type NavigatorQueue,
  type NavigatorQueuePage,
  type QueueActionResult,
  type QueueDecision,
  type QueueEntry,
  type QueueEntryKind,
  type QueueRefusal,
  type QueueRefusalCode,
} from './navigator-queue.js';
export {
  createCostReader,
  type CostReader,
  type ItemCost,
  type ProjectCost,
  type ProjectRunCost,
  type RunCost,
} from './costs.js';
export {
  createAttention,
  troubleTitle,
  type Attention,
  type AttentionEntry,
  type AttentionKind,
} from './attention.js';
export {
  createNotificationSettings,
  type NotificationSettings,
  type ProjectNotificationSetting,
} from './notification-settings.js';
export {
  createNotifier,
  createPushBatcher,
  pushWindowMs,
  type NotificationTab,
  type Notifier,
  type PushBatcher,
  type PushMessage,
} from './notifier.js';
export {
  BackupConfigError,
  createBackups,
  createPgDump,
  parseBackupConfig,
  type BackupConfig,
  type BackupRecord,
  type BackupStatus,
  type Backups,
  type StartResult,
} from './backups.js';
export { migrateToLatest } from './migrations/index.js';
export {
  createPodmanEngine,
  type PodmanEngineSettings,
} from './podman-engine.js';
export {
  createProjectRegistrationService,
  createProjectStore,
} from './project-registration.js';
export {
  createProjectTokenCipher,
  type EncryptedProjectToken,
  type ProjectTokenCipher,
} from './project-token.js';
export {
  GitHubAccessError,
  InvalidProjectPrefixError,
  InvalidProjectUrlError,
  ProjectRegistrationService,
  ProjectMirrorError,
  type GitHubProject,
  type GitHubRepository,
  type MirrorRepository,
  type Project,
  type ProjectDiscovery,
  type ProjectRegistration,
  type ProjectStore,
} from './projects.js';
export {
  createRunToken,
  createRunnerGateway,
  hashRunToken,
  type RunnerClosed,
  type RunnerConnection,
  type RunnerGateway,
  type RunnerGatewayOptions,
  type RunnerListener,
} from './runner-gateway.js';
export {
  createBoardTools,
  resolveCaller,
  type BoardTools,
  type ToolCaller,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRefusalCode,
} from './board-tools.js';
export {
  createMcpEndpoint,
  mcpPath,
  type McpEndpoint,
  type McpEndpointOptions,
  type McpTools,
} from './mcp.js';
export {
  createRunStore,
  type Conversation,
  type RunEventRecord,
  type RunRecord,
  type RunStore,
} from './runs.js';
export {
  AgentUnavailableError,
  createSupervisor,
  directoryPreparer,
  RunEndedError,
  RunNotFoundError,
  RunStartError,
  type RunUpdate,
  type Supervisor,
  type SupervisorOptions,
} from './supervisor.js';
export {
  createPlanApprovals,
  PlanAnswerError,
  type PlanAnswer,
  type PlanApprovals,
} from './plan-approvals.js';
export {
  createDrawingQuestions,
  DrawingsAnswerError,
  type DrawingQuestions,
  type DrawingsAnswer,
  type DrawingsRound,
} from './drawings.js';
export {
  createMockupServer,
  createMockupStore,
  MockupError,
  mockupContentSecurityPolicy,
  mockupContentTypes,
  mockupDocument,
  mockupEscapeMessage,
  mockupOrigin,
  type Mockup,
  type MockupContentType,
  type MockupStore,
} from './mockups.js';
export {
  createInvolvementSettings,
  InvolvementInputError,
  involvements,
  type Involvement,
  type InvolvementSetting,
  type InvolvementSettings,
} from './involvement.js';
export {
  createStartSettings,
  LimitInputError,
  type Limits,
  type StartSettings,
} from './start-settings.js';
export {
  createDispatcher,
  type AutomaticStartStatus,
  type DispatchedRun,
  type Dispatcher,
  type DispatcherOptions,
} from './dispatcher.js';
export type { WaitingReason } from './dispatch-plan.js';
export {
  createServer,
  startServer,
  type ConversationControl,
} from './server.js';
