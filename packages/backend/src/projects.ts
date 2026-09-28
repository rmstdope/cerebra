import { randomUUID } from 'node:crypto';

export interface GitHubProject {
  readonly defaultBranch: string;
  readonly name: string;
  readonly owner: string;
  readonly remote: string;
}

export interface Project {
  readonly defaultBranch: string;
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly prefix: string;
  readonly remote: string;
}

export interface ProjectDiscovery {
  readonly defaultBranch: string;
  readonly name: string;
  readonly owner: string;
  readonly prefix: string;
  readonly remote: string;
}

export interface GitHubRepository {
  discover(input: {
    readonly credential: string;
    readonly remote: string;
  }): Promise<GitHubProject>;
}

export interface MirrorRepository {
  create(input: {
    readonly credential: string;
    readonly project: Project;
  }): Promise<void>;
  remove(project: Project): Promise<void>;
}

export interface ProjectStore {
  create(input: {
    readonly credential: string;
    readonly project: Project;
  }): Promise<Project>;
}

export interface ProjectRegistration {
  discover(input: {
    readonly credential: string;
    readonly remote: string;
  }): Promise<ProjectDiscovery>;
  register(input: {
    readonly credential: string;
    readonly prefix: string;
    readonly remote: string;
  }): Promise<Project>;
}

export class InvalidProjectUrlError extends Error {
  public constructor() {
    super(
      'Enter a GitHub repository link, such as https://github.com/owner/repository.',
    );
  }
}

export class InvalidProjectPrefixError extends Error {
  public constructor() {
    super('Enter a project prefix using 2 to 10 uppercase letters or numbers.');
  }
}

export class GitHubAccessError extends Error {
  public constructor() {
    super(
      'GitHub rejected the access token or it cannot read this repository.',
    );
  }
}

export class ProjectMirrorError extends Error {
  public constructor() {
    super('Cerebra couldn’t create a private working copy of this repository.');
  }
}

function canonicalRemote(remote: string): string {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    throw new InvalidProjectUrlError();
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new InvalidProjectUrlError();
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    throw new InvalidProjectUrlError();
  }
  const [owner, repository] = parts;
  return `https://github.com/${owner}/${repository.replace(/\.git$/, '')}.git`;
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(normalized)) {
    throw new InvalidProjectPrefixError();
  }
  return normalized;
}

function suggestedPrefix(name: string): string {
  const prefix = name
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/g, '')
    .slice(0, 10);
  return prefix.length >= 2 ? prefix : 'PROJECT';
}

export class ProjectRegistrationService implements ProjectRegistration {
  public constructor(
    private readonly dependencies: {
      readonly mirror: MirrorRepository;
      readonly repository: GitHubRepository;
      readonly store: ProjectStore;
    },
  ) {}

  public async discover(input: {
    readonly credential: string;
    readonly remote: string;
  }): Promise<ProjectDiscovery> {
    const remote = canonicalRemote(input.remote);
    const project = await this.dependencies.repository.discover({
      credential: input.credential,
      remote,
    });
    return { ...project, prefix: suggestedPrefix(project.name) };
  }

  public async register(input: {
    readonly credential: string;
    readonly prefix: string;
    readonly remote: string;
  }): Promise<Project> {
    const discovery = await this.discover(input);
    const project: Project = {
      ...discovery,
      id: randomUUID(),
      prefix: normalizePrefix(input.prefix),
    };
    await this.dependencies.mirror.create({
      credential: input.credential,
      project,
    });
    try {
      return await this.dependencies.store.create({
        credential: input.credential,
        project,
      });
    } catch (error) {
      await this.dependencies.mirror.remove(project);
      throw error;
    }
  }
}
