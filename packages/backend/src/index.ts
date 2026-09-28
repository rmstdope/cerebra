export const packageName = '@cerebra/backend';

export { createDatabase, type Database } from './database.js';
export {
  createAuthService,
  type AuthService,
  type AuthStatus,
  type AuthenticationResult,
} from './auth.js';
export { createBoard, type Board } from './board.js';
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
export { createServer, startServer } from './server.js';
