import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PendingOAuthState = {
  authRequestId: string;
  state: string;
  verifier: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
};

export type BrowserAuthAttempt = {
  authRequestId: string;
  state: string;
  authorizeUrl: string;
  redirectUri: string;
  status: 'pending' | 'completed' | 'failed' | 'expired';
  authSessionId?: string;
  accountId?: string;
  planType?: string | null;
  error?: string;
  errorDescription?: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
};

export type HostAuthSession = {
  authSessionId: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  bindToken?: string;
  bindTokenExpiresAt?: number;
  expiresAt: number;
  accountId?: string;
  planType?: string | null;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
};

export type AiSessionBinding = {
  aiSessionId: string;
  authSessionId: string;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
};

type StoreShape = {
  pendingStates: Record<string, PendingOAuthState>;
  browserAuthAttempts: Record<string, BrowserAuthAttempt>;
  authSessions: Record<string, HostAuthSession>;
  aiSessionBindings: Record<string, AiSessionBinding>;
};

export interface HostTokenStore {
  init(): Promise<void>;
  savePendingState(state: PendingOAuthState): Promise<void>;
  consumePendingState(state: string): Promise<PendingOAuthState | undefined>;
  saveBrowserAuthAttempt(attempt: BrowserAuthAttempt): Promise<void>;
  getBrowserAuthAttempt(authRequestId: string): Promise<BrowserAuthAttempt | undefined>;
  getBrowserAuthAttemptByState(state: string): Promise<BrowserAuthAttempt | undefined>;
  saveAuthSession(session: HostAuthSession): Promise<void>;
  getAuthSession(authSessionId: string): Promise<HostAuthSession | undefined>;
  getLatestActiveAuthSession(): Promise<HostAuthSession | undefined>;
  saveBinding(binding: AiSessionBinding): Promise<void>;
  getBinding(aiSessionId: string): Promise<AiSessionBinding | undefined>;
}

const EMPTY_STORE: StoreShape = {
  pendingStates: {},
  browserAuthAttempts: {},
  authSessions: {},
  aiSessionBindings: {},
};

export class FileHostTokenStore implements HostTokenStore {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly storageDir: string) {
    this.filePath = join(storageDir, 'host-token-store.json');
  }

  async init(): Promise<void> {
    await this.runExclusive(async () => {
      await mkdir(this.storageDir, { recursive: true });
      const store = await this.readStore();
      await this.writeStore(store);
    });
  }

  async savePendingState(state: PendingOAuthState): Promise<void> {
    await this.runExclusive(async () => {
      const store = await this.readStore();
      store.pendingStates[state.state] = state;
      await this.writeStore(store);
    });
  }

  async consumePendingState(state: string): Promise<PendingOAuthState | undefined> {
    return this.runExclusive(async () => {
      const store = await this.readStore();
      const pending = store.pendingStates[state];
      if (!pending) {
        return undefined;
      }
      delete store.pendingStates[state];
      await this.writeStore(store);
      return pending;
    });
  }

  async saveBrowserAuthAttempt(attempt: BrowserAuthAttempt): Promise<void> {
    await this.runExclusive(async () => {
      const store = await this.readStore();
      store.browserAuthAttempts[attempt.authRequestId] = attempt;
      await this.writeStore(store);
    });
  }

  async getBrowserAuthAttempt(authRequestId: string): Promise<BrowserAuthAttempt | undefined> {
    return this.runExclusive(async () => {
      const store = await this.readStore();
      return store.browserAuthAttempts[authRequestId];
    });
  }

  async getBrowserAuthAttemptByState(state: string): Promise<BrowserAuthAttempt | undefined> {
    return this.runExclusive(async () => {
      const store = await this.readStore();
      return Object.values(store.browserAuthAttempts).find(attempt => attempt.state === state);
    });
  }

  async saveAuthSession(session: HostAuthSession): Promise<void> {
    await this.runExclusive(async () => {
      const store = await this.readStore();
      store.authSessions[session.authSessionId] = session;
      await this.writeStore(store);
    });
  }

  async getAuthSession(authSessionId: string): Promise<HostAuthSession | undefined> {
    return this.runExclusive(async () => {
      const store = await this.readStore();
      return store.authSessions[authSessionId];
    });
  }

  async getLatestActiveAuthSession(): Promise<HostAuthSession | undefined> {
    return this.runExclusive(async () => {
      const store = await this.readStore();
      return Object.values(store.authSessions)
        .filter(session => !session.revokedAt)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    });
  }

  async saveBinding(binding: AiSessionBinding): Promise<void> {
    await this.runExclusive(async () => {
      const store = await this.readStore();
      store.aiSessionBindings[binding.aiSessionId] = binding;
      await this.writeStore(store);
    });
  }

  async getBinding(aiSessionId: string): Promise<AiSessionBinding | undefined> {
    return this.runExclusive(async () => {
      const store = await this.readStore();
      return store.aiSessionBindings[aiSessionId];
    });
  }

  private async readStore(): Promise<StoreShape> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      return {
        pendingStates: parsed.pendingStates ?? {},
        browserAuthAttempts: parsed.browserAuthAttempts ?? {},
        authSessions: parsed.authSessions ?? {},
        aiSessionBindings: parsed.aiSessionBindings ?? {},
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return structuredClone(EMPTY_STORE);
      }
      throw error;
    }
  }

  private async writeStore(store: StoreShape): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release: () => void = () => undefined;
    this.writeChain = new Promise<void>(resolve => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
