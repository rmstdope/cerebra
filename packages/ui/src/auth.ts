export type AuthStatus =
  | { readonly state: 'authenticated' | 'setup' }
  | {
      readonly reason: 'expired' | 'signed-out';
      readonly state: 'unauthenticated';
    };

export class AuthRequestError extends Error {
  public constructor(
    message: string,
    public readonly reason:
      'invalid-password' | 'rejected-password' | 'service',
  ) {
    super(message);
  }
}

export interface AuthClient {
  setup(password: string): Promise<void>;
  signIn(password: string): Promise<void>;
  signOut(): Promise<void>;
  status(): Promise<AuthStatus>;
}

async function authenticate(
  path: '/api/auth/setup' | '/api/auth/sign-in',
  password: string,
): Promise<void> {
  try {
    const response = await fetch(path, {
      body: JSON.stringify({ password }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    if (response.ok) {
      return;
    }
    const body = (await response.json()) as { error?: string };
    throw new AuthRequestError(
      body.error ??
        'Cerebra couldn’t sign you in. Check that it is running, then try again.',
      response.status === 400 ? 'invalid-password' : 'rejected-password',
    );
  } catch (error) {
    if (error instanceof AuthRequestError) {
      throw error;
    }
    throw new AuthRequestError(
      'Cerebra couldn’t sign you in. Check that it is running, then try again.',
      'service',
    );
  }
}

export const browserAuthClient: AuthClient = {
  setup: (password) => authenticate('/api/auth/setup', password),
  signIn: (password) => authenticate('/api/auth/sign-in', password),
  async signOut() {
    const response = await fetch('/api/auth/sign-out', { method: 'POST' });
    if (!response.ok) {
      throw new Error('Cerebra couldn’t sign you out. Try again.');
    }
  },
  async status() {
    const response = await fetch('/api/auth/status');
    if (!response.ok) {
      throw new Error('Cerebra is unavailable');
    }
    return (await response.json()) as AuthStatus;
  },
};
