import type {
  AdminData,
  AuditLog,
  LoginAndResumeResult,
  PortalSettingsData,
  PortalSettingsValues,
  PortalUser,
} from './types';

type ApiResponse<T> = {
  success: boolean;
  data?: T;
  code?: string;
  message?: string;
};

async function request<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...options.headers,
    },
  });
  const payload = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || payload.code || response.statusText);
  }
  return payload.data as T;
}

async function publicRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...options.headers,
    },
  });
  const payload = (await response.json()) as ApiResponse<T>;
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || payload.code || response.statusText);
  }
  return payload.data as T;
}

export function loginAndResume(values: { username: string; password: string }): Promise<LoginAndResumeResult> {
  return publicRequest<LoginAndResumeResult>('/api/login-and-resume', {
    method: 'POST',
    body: JSON.stringify(values),
  });
}

export async function loadAdminData(token: string): Promise<AdminData> {
  const [users, auditLogs] = await Promise.all([
    request<PortalUser[]>('/api/admin/users', token),
    request<AuditLog[]>('/api/admin/audit-logs', token),
  ]);
  return { users, auditLogs };
}

export function loadPortalSettings(token: string): Promise<PortalSettingsData> {
  return request<PortalSettingsData>('/api/admin/settings', token);
}

export function updatePortalSettings(token: string, values: PortalSettingsValues): Promise<PortalSettingsData> {
  return request<PortalSettingsData>('/api/admin/settings', token, {
    method: 'PUT',
    body: JSON.stringify({ values }),
  });
}

export function createUser(
  token: string,
  values: { username: string; password: string; userId: string; displayName?: string }
): Promise<PortalUser> {
  return request<PortalUser>('/api/admin/users', token, {
    method: 'POST',
    body: JSON.stringify(values),
  });
}

export function startInstance(token: string, userId: string): Promise<unknown> {
  return request(`/api/admin/instances/${encodeURIComponent(userId)}/start`, token, {
    method: 'POST',
    body: JSON.stringify({ waitUntilReady: true }),
  });
}

export function stopInstance(token: string, userId: string): Promise<unknown> {
  return request(`/api/admin/instances/${encodeURIComponent(userId)}/stop`, token, {
    method: 'POST',
    body: JSON.stringify({ reason: 'admin_console', force: false }),
  });
}

export function resetInstancePassword(
  token: string,
  userId: string
): Promise<{ userId: string; temporaryPassword: string; expiresAt: string }> {
  return request(`/api/admin/instances/${encodeURIComponent(userId)}/reset-password`, token, {
    method: 'POST',
    body: JSON.stringify({ reason: 'admin_console_break_glass' }),
  });
}
