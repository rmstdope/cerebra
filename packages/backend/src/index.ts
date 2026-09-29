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
