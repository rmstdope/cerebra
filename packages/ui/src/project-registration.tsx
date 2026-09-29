import { useState, type FormEvent, type ReactNode } from 'react';
import {
  browserProjectClient,
  type ProjectClient,
  type ProjectDiscovery,
  type RegisteredProject,
} from './projects';

export function ProjectRegistration({
  onProjectAdded,
  onProjectRegistered,
  projectClient = browserProjectClient,
}: {
  readonly onProjectAdded?: (project: RegisteredProject) => void;
  readonly onProjectRegistered?: (project: RegisteredProject) => void;
  readonly projectClient?: ProjectClient;
}): ReactNode {
  const [credential, setCredential] = useState('');
  const [remote, setRemote] = useState('');
  const [discovery, setDiscovery] = useState<ProjectDiscovery | null>(null);
  const [prefix, setPrefix] = useState('');
  const [project, setProject] = useState<RegisteredProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [creationFailed, setCreationFailed] = useState(false);

  async function discover(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      const found = await projectClient.discover({ credential, remote });
      setDiscovery(found);
      setPrefix(found.prefix);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'GitHub couldn’t open this repository',
      );
      setCredential('');
    }
  }

  async function register(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAdding(true);
    setError(null);
    try {
      const registered = await projectClient.register({
        credential,
        prefix,
        remote,
      });
      setProject(registered);
      onProjectRegistered?.(registered);
      setCredential('');
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Project registration failed. Check Cerebra’s logs for details, then try again.',
      );
      setCreationFailed(true);
    } finally {
      setAdding(false);
      setCredential('');
    }
  }

  if (project !== null) {
    return (
      <section className="card">
        <h1>Project added</h1>
        <p className="mt-3 text-[var(--muted)]">
          <strong>
            {project.owner}/{project.name}
          </strong>{' '}
          is ready. Its default branch is <code>{project.defaultBranch}</code>{' '}
          and new work will use <code>{project.prefix}</code>.
        </p>
        <h2 className="mt-8">Your project is ready</h2>
        <p className="mt-2 text-[var(--muted)]">
          There’s no work here yet. File the first piece of work when you’re
          ready.
        </p>
        <button
          className="primary-button mt-5"
          onClick={() => onProjectAdded?.(project)}
          type="button"
        >
          Open project
        </button>
      </section>
    );
  }

  if (creationFailed) {
    return (
      <section className="card">
        <h1>Cerebra couldn’t add this project</h1>
        <p className="mt-2 text-[var(--muted)]">
          Your project was not added. Resolve the problem below, then try again.
        </p>
        <p
          className="mt-4 whitespace-pre-wrap break-words text-[var(--danger)]"
          role="alert"
        >
          {error}
        </p>
        <div className="mt-6 flex gap-3">
          <button
            className="secondary-button"
            onClick={() => {
              setCreationFailed(false);
              setDiscovery(null);
            }}
            type="button"
          >
            Cancel
          </button>
          <button
            className="primary-button"
            onClick={() => {
              setCreationFailed(false);
              setDiscovery(null);
            }}
            type="button"
          >
            Try again
          </button>
        </div>
      </section>
    );
  }

  if (discovery !== null) {
    return (
      <form className="card" onSubmit={(event) => void register(event)}>
        <p className="text-sm font-bold text-[var(--accent)]">2. Settings</p>
        <h1 className="mt-2">Check the project settings</h1>
        <p className="mt-2 text-[var(--muted)]">
          Cerebra found the repository and suggested settings you can change
          now.
        </p>
        <label className="mt-5 block font-bold" htmlFor="project-prefix">
          Project prefix
        </label>
        <input
          className="mt-2 w-full rounded-lg border p-3"
          id="project-prefix"
          onChange={(event) => setPrefix(event.target.value)}
          value={prefix}
        />
        <p className="mt-2 text-sm text-[var(--muted)]">
          New work will be numbered {prefix || 'PROJECT'}-1,{' '}
          {prefix || 'PROJECT'}-2 and so on. You can change this until your
          first item is filed.
        </p>
        <label className="mt-5 block font-bold" htmlFor="default-branch">
          Default branch
        </label>
        <input
          className="mt-2 w-full rounded-lg border p-3"
          id="default-branch"
          readOnly
          value={discovery.defaultBranch}
        />
        <p className="mt-2 text-sm text-[var(--muted)]">Found from GitHub.</p>
        {error ? (
          <p className="mt-4 text-[var(--danger)]" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex gap-3">
          <button
            className="secondary-button"
            onClick={() => setDiscovery(null)}
            type="button"
          >
            Back
          </button>
          <button className="primary-button" disabled={adding} type="submit">
            {adding ? 'Adding project…' : 'Add project'}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form className="card" onSubmit={(event) => void discover(event)}>
      <p className="text-sm font-bold text-[var(--accent)]">1. Repository</p>
      <h1 className="mt-2">Add a GitHub project</h1>
      <p className="mt-2 text-[var(--muted)]">
        Paste the link to the repository you want Cerebra to look after.
      </p>
      <label className="mt-5 block font-bold" htmlFor="repository-link">
        GitHub repository link
      </label>
      <input
        className="mt-2 w-full rounded-lg border p-3"
        id="repository-link"
        aria-invalid={error !== null}
        onChange={(event) => setRemote(event.target.value)}
        placeholder="https://github.com/owner/repository"
        required
        type="url"
        value={remote}
      />
      <label className="mt-5 block font-bold" htmlFor="github-token">
        GitHub access token
      </label>
      <input
        autoComplete="off"
        className="mt-2 w-full rounded-lg border p-3"
        id="github-token"
        onChange={(event) => setCredential(event.target.value)}
        required
        type="password"
        value={credential}
      />
      <p className="mt-2 text-sm text-[var(--muted)]">
        Use a token that can read this repository. It is saved securely and is
        never shown again.
      </p>
      {error ? (
        <p className="mt-4 text-[var(--danger)]" role="alert">
          {error}
        </p>
      ) : null}
      <button className="primary-button mt-6" type="submit">
        Continue
      </button>
    </form>
  );
}
