export const packageName = '@cerebra/backend';

export { createDatabase, type Database } from './database.js';
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
  type BoardQuery,
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
  type NavigatorQueue,
  type NavigatorQueuePage,
  type QueueActionResult,
  type QueueDecision,
  type QueueEntry,
  type QueueEntryKind,
  type QueueRefusal,
  type QueueRefusalCode,
} from './navigator-queue.js';
export { migrateToLatest } from './migrations/index.js';
export {
  createPodmanEngine,
  type PodmanEngineSettings,
} from './podman-engine.js';
export { createProjectRegistrationService } from './project-registration.js';
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
export { createServer, startServer } from './server.js';
