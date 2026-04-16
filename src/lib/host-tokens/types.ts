export type HostTokenBootstrapRequest = {
  sessionId: string;
  bindToken: string;
};

export type HostTokenBootstrapResponse = {
  sessionId: string;
  idToken: string;
  accessToken: string;
  expiresAt: number;
  accountId?: string;
  planType?: string | null;
};

export type HostTokenRefreshRequest = {
  sessionId: string;
  previousAccountId?: string | null;
  reason?: 'unauthorized';
};

export type HostTokenRefreshResponse = {
  sessionId: string;
  idToken: string;
  accessToken: string;
  expiresAt: number;
  accountId?: string;
  planType?: string | null;
};

export type HostTokenSessionMetadata = {
  sessionId: string;
  expiresAt: number;
  accountId?: string;
  revoked?: boolean;
  bindToken?: string;
};
