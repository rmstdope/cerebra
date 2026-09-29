export const packageName = '@cerebra/backend';

export { createDatabase, type Database } from './database.js';
export {
  createAuthService,
  type AuthService,
  type AuthStatus,
  type AuthenticationResult,
} from './auth.js';
export {
  createBoard,
  type Board,
  type BoardComment,
  type BoardHistoryEntry,
  type BoardWorkItem,
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
