export type InstanceReadiness = {
  containerStarted: boolean;
  webListening: boolean;
  backendHealthy: boolean;
};

export type PortalInstance = {
  userId: string;
  instanceId: string;
  containerName: string;
  hostDataPath: string;
  dataPath?: string;
  subdomain: string;
  url: string;
  status: string;
  resourceLimits?: {
    cpu: number;
    memoryMiB: number;
  };
  imageVersion: string | null;
  lastStartedAt: number | null;
  lastStoppedAt: number | null;
  failureReason: string | null;
  lastActiveAt: number;
  readiness: InstanceReadiness;
};

export type PortalUser = {
  userId: string;
  username: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
  instance: PortalInstance | null;
};

export type AuditLog = {
  actorId: string;
  action: string;
  targetUserId: string | null;
  targetInstanceId: string | null;
  sourceIp: string | null;
  result: string;
  reason: string | null;
  errorCode: string | null;
  createdAt: number;
};

export type AdminData = {
  users: PortalUser[];
  auditLogs: AuditLog[];
};

export type PortalSettingsValues = {
  dockerImage: string;
  imageVersion: string;
  usersDataRoot: string;
  baseDomain: string;
  publicScheme: string;
  idleTimeoutMs: number;
  stopGracePeriodMs: number;
  resetPasswordTtlMs: number;
  containerStopTimeoutSeconds: number;
  containerMemoryBytes: number;
  containerNanoCpus: number;
  containerPidsLimit: number;
  containerUser: string;
  containerDataMountPath: string;
};

export type PortalSettingsData = {
  defaults: PortalSettingsValues;
  values: PortalSettingsValues;
};

export type LoginAndResumeResult = {
  userId: string;
  instanceId: string;
  status: string;
  url: string;
  loginUrl: string;
  readiness: InstanceReadiness;
};
