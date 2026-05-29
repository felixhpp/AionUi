import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Form,
  Grid,
  Input,
  InputNumber,
  Layout,
  Menu,
  Message,
  Modal,
  Radio,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from '@arco-design/web-react';
import {
  AddOne,
  DashboardOne,
  ListView,
  People,
  Play,
  Power,
  Refresh,
  Server,
  SettingConfig,
  Shop,
} from '@icon-park/react';

import {
  createUser,
  loadAdminData,
  loadPortalSettings,
  loginAndResume,
  resetInstancePassword,
  startInstance,
  stopInstance,
  updatePortalSettings,
} from './api';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  isSupportedLanguage,
  setCurrentLanguage,
  t,
  type Language,
  type MessageKey,
} from './i18n';
import type {
  AdminData,
  AuditLog,
  PortalInstance,
  PortalSettingsData,
  PortalSettingsValues,
  PortalUser,
} from './types';

const { Content, Sider } = Layout;
const { Row, Col } = Grid;

type ViewKey = 'dashboard' | 'users' | 'instances' | 'settings' | 'nodes' | 'marketplace' | 'auditLogs';
type SettingSectionKey = 'imageSettings' | 'runtimeSettings' | 'resourceSettings';
type SettingField = {
  key: keyof PortalSettingsValues;
  label: MessageKey;
  section: SettingSectionKey;
  valueType: 'string' | 'integer';
};

const TOKEN_STORAGE_KEY = 'aionui.portal.adminToken';
const SETTING_FIELDS: SettingField[] = [
  { key: 'dockerImage', label: 'dockerImage', section: 'imageSettings', valueType: 'string' },
  { key: 'imageVersion', label: 'imageVersionSetting', section: 'imageSettings', valueType: 'string' },
  { key: 'usersDataRoot', label: 'usersDataRoot', section: 'imageSettings', valueType: 'string' },
  { key: 'baseDomain', label: 'baseDomain', section: 'imageSettings', valueType: 'string' },
  { key: 'publicScheme', label: 'publicScheme', section: 'imageSettings', valueType: 'string' },
  { key: 'idleTimeoutMs', label: 'idleTimeoutMs', section: 'runtimeSettings', valueType: 'integer' },
  { key: 'stopGracePeriodMs', label: 'stopGracePeriodMs', section: 'runtimeSettings', valueType: 'integer' },
  { key: 'resetPasswordTtlMs', label: 'resetPasswordTtlMs', section: 'runtimeSettings', valueType: 'integer' },
  {
    key: 'containerStopTimeoutSeconds',
    label: 'containerStopTimeoutSeconds',
    section: 'runtimeSettings',
    valueType: 'integer',
  },
  { key: 'containerMemoryBytes', label: 'containerMemoryBytes', section: 'resourceSettings', valueType: 'integer' },
  { key: 'containerNanoCpus', label: 'containerNanoCpus', section: 'resourceSettings', valueType: 'integer' },
  { key: 'containerPidsLimit', label: 'containerPidsLimit', section: 'resourceSettings', valueType: 'integer' },
  { key: 'containerUser', label: 'containerUser', section: 'resourceSettings', valueType: 'string' },
  { key: 'containerDataMountPath', label: 'containerDataMountPath', section: 'resourceSettings', valueType: 'string' },
];
const SETTING_SECTIONS: SettingSectionKey[] = ['imageSettings', 'runtimeSettings', 'resourceSettings'];

function initialLanguage(): Language {
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return stored && isSupportedLanguage(stored) ? stored : DEFAULT_LANGUAGE;
}

function formatTime(value: number | null | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function normalizeSettingsFormValues(
  values: Partial<Record<keyof PortalSettingsValues, string | number>>
): PortalSettingsValues {
  function stringValue(key: keyof PortalSettingsValues): string {
    return String(values[key] || '').trim();
  }

  function integerValue(key: keyof PortalSettingsValues): number {
    const parsed = Number.parseInt(String(values[key]), 10);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(t('settingIntegerRequired'));
    }
    return parsed;
  }

  return {
    dockerImage: stringValue('dockerImage'),
    imageVersion: stringValue('imageVersion'),
    usersDataRoot: stringValue('usersDataRoot'),
    baseDomain: stringValue('baseDomain'),
    publicScheme: stringValue('publicScheme'),
    idleTimeoutMs: integerValue('idleTimeoutMs'),
    stopGracePeriodMs: integerValue('stopGracePeriodMs'),
    resetPasswordTtlMs: integerValue('resetPasswordTtlMs'),
    containerStopTimeoutSeconds: integerValue('containerStopTimeoutSeconds'),
    containerMemoryBytes: integerValue('containerMemoryBytes'),
    containerNanoCpus: integerValue('containerNanoCpus'),
    containerPidsLimit: integerValue('containerPidsLimit'),
    containerUser: stringValue('containerUser'),
    containerDataMountPath: stringValue('containerDataMountPath'),
  };
}

function instanceStatusKey(
  status: string | undefined
): 'running' | 'stopped' | 'failed' | 'startingTimeout' | 'degraded' | 'unknown' {
  if (status === 'running') return 'running';
  if (status === 'stopped') return 'stopped';
  if (status === 'failed') return 'failed';
  if (status === 'starting_timeout') return 'startingTimeout';
  if (status === 'degraded') return 'degraded';
  return 'unknown';
}

function statusTag(status: string | undefined) {
  const key = instanceStatusKey(status);
  const color = {
    running: 'green',
    stopped: 'gray',
    failed: 'red',
    startingTimeout: 'orange',
    degraded: 'gold',
    unknown: 'arcoblue',
  }[key];

  return <Tag color={color}>{t(key)}</Tag>;
}

function readinessTag(instance: PortalInstance | null) {
  if (!instance) return <Tag>{t('notReady')}</Tag>;
  const ready =
    instance.readiness.backendHealthy && instance.readiness.containerStarted && instance.readiness.webListening;
  return <Tag color={ready ? 'green' : 'orange'}>{ready ? t('ready') : t('notReady')}</Tag>;
}

function LanguageSwitch({ value, onChange }: { value: Language; onChange: (language: Language) => void }) {
  return (
    <Radio.Group
      type='button'
      size='small'
      value={value}
      onChange={(nextValue) => onChange(nextValue as Language)}
      aria-label={t('language')}
    >
      <Radio value='zh-CN'>{t('chinese')}</Radio>
      <Radio value='en-US'>{t('english')}</Radio>
    </Radio.Group>
  );
}

function LoginGate({
  language,
  onLanguageChange,
  onToken,
}: {
  language: Language;
  onLanguageChange: (language: Language) => void;
  onToken: (token: string) => void;
}) {
  const [token, setToken] = useState('');

  function submit() {
    const trimmed = token.trim();
    if (!trimmed) {
      Message.warning(t('tokenRequired'));
      return;
    }
    sessionStorage.setItem(TOKEN_STORAGE_KEY, trimmed);
    onToken(trimmed);
  }

  return (
    <div className='login-shell'>
      <section className='login-panel'>
        <div className='portal-topline'>
          <div className='brand-mark'>AU</div>
          <LanguageSwitch value={language} onChange={onLanguageChange} />
        </div>
        <Typography.Title heading={3}>{t('tokenTitle')}</Typography.Title>
        <Typography.Paragraph className='muted'>{t('tokenDescription')}</Typography.Paragraph>
        <Space direction='vertical' size={14} className='login-form'>
          <Input.Password value={token} onChange={setToken} placeholder={t('tokenPlaceholder')} onPressEnter={submit} />
          <Button type='primary' long onClick={submit}>
            {t('tokenAction')}
          </Button>
        </Space>
      </section>
    </div>
  );
}

function UserPortal({
  language,
  onLanguageChange,
}: {
  language: Language;
  onLanguageChange: (language: Language) => void;
}) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState('');

  async function submit() {
    const values = await form.validate();
    setLoading(true);
    setStatusText(t('startingWorkspace'));
    try {
      const result = await loginAndResume({
        username: values.username,
        password: values.password,
      });
      setStatusText(t('redirectingWorkspace'));
      window.location.assign(result.loginUrl);
    } catch {
      setStatusText('');
      Message.error(t('loginFailed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className='login-shell user-portal-shell'>
      <section className='login-panel user-portal-panel'>
        <div className='portal-topline'>
          <div className='brand-mark'>AU</div>
          <Space>
            <LanguageSwitch value={language} onChange={onLanguageChange} />
            <Button type='text' onClick={() => window.location.assign('/admin')}>
              {t('adminConsole')}
            </Button>
          </Space>
        </div>
        <Typography.Title heading={2}>{t('userPortalTitle')}</Typography.Title>
        <Typography.Paragraph className='muted'>{t('userPortalSubtitle')}</Typography.Paragraph>
        <Form form={form} layout='vertical' className='portal-user-form'>
          <Form.Item
            field='username'
            label={t('username')}
            rules={[{ required: true, message: t('usernameRequired') }]}
          >
            <Input autoComplete='username' />
          </Form.Item>
          <Form.Item
            field='password'
            label={t('password')}
            rules={[{ required: true, message: t('passwordRequired') }]}
          >
            <Input.Password autoComplete='current-password' onPressEnter={submit} />
          </Form.Item>
        </Form>
        <Button type='primary' long loading={loading} onClick={submit}>
          {t('resumeWorkspace')}
        </Button>
        {statusText && <Typography.Paragraph className='muted portal-status'>{statusText}</Typography.Paragraph>}
      </section>
    </div>
  );
}

function Dashboard({ data }: { data: AdminData }) {
  const running = data.users.filter((user) => user.instance?.status === 'running').length;
  const stopped = data.users.filter((user) => !user.instance || user.instance.status === 'stopped').length;
  const failures = data.users.filter((user) =>
    ['failed', 'starting_timeout', 'degraded'].includes(user.instance?.status || '')
  ).length;

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} sm={12} lg={6}>
        <Card className='metric-card'>
          <Statistic title={t('totalUsers')} value={data.users.length} />
        </Card>
      </Col>
      <Col xs={24} sm={12} lg={6}>
        <Card className='metric-card'>
          <Statistic title={t('activeInstances')} value={running} />
        </Card>
      </Col>
      <Col xs={24} sm={12} lg={6}>
        <Card className='metric-card'>
          <Statistic title={t('stoppedInstances')} value={stopped} />
        </Card>
      </Col>
      <Col xs={24} sm={12} lg={6}>
        <Card className='metric-card'>
          <Statistic title={t('failureCount')} value={failures} />
        </Card>
      </Col>
    </Row>
  );
}

function UsersView({
  data,
  onCreate,
}: {
  data: AdminData;
  onCreate: (values: Record<string, string>) => Promise<void>;
}) {
  const [visible, setVisible] = useState(false);
  const [form] = Form.useForm();

  async function submit() {
    const values = await form.validate();
    await onCreate(values);
    form.resetFields();
    setVisible(false);
  }

  return (
    <Card
      className='workspace-card'
      title={t('users')}
      extra={
        <Button type='primary' icon={<AddOne />} onClick={() => setVisible(true)}>
          {t('addUser')}
        </Button>
      }
    >
      <Table
        rowKey='userId'
        data={data.users}
        pagination={false}
        columns={[
          { title: t('username'), dataIndex: 'username' },
          { title: t('displayName'), dataIndex: 'displayName' },
          { title: t('userId'), dataIndex: 'userId' },
          {
            title: t('status'),
            render: (_value, user: PortalUser) => statusTag(user.instance?.status),
          },
          {
            title: t('createdAt'),
            render: (_value, user: PortalUser) => formatTime(user.createdAt),
          },
        ]}
      />
      <Modal
        title={t('addUser')}
        visible={visible}
        onCancel={() => setVisible(false)}
        onOk={submit}
        okText={t('create')}
        cancelText={t('cancel')}
      >
        <Form form={form} layout='vertical'>
          <Form.Item field='username' label={t('username')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item field='userId' label={t('userId')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item field='displayName' label={t('displayName')}>
            <Input />
          </Form.Item>
          <Form.Item field='password' label={t('password')} rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

function InstancesView({
  data,
  onStart,
  onStop,
  onResetPassword,
}: {
  data: AdminData;
  onStart: (userId: string) => Promise<void>;
  onStop: (userId: string) => Promise<void>;
  onResetPassword: (userId: string) => Promise<void>;
}) {
  return (
    <Card className='workspace-card' title={t('instances')}>
      <Table
        rowKey='userId'
        data={data.users}
        pagination={false}
        columns={[
          { title: t('userId'), dataIndex: 'userId' },
          {
            title: t('status'),
            render: (_value, user: PortalUser) => statusTag(user.instance?.status),
          },
          {
            title: t('readiness'),
            render: (_value, user: PortalUser) => readinessTag(user.instance),
          },
          {
            title: t('instanceId'),
            render: (_value, user: PortalUser) => user.instance?.instanceId || '-',
          },
          {
            title: t('subdomain'),
            render: (_value, user: PortalUser) => user.instance?.subdomain || '-',
          },
          {
            title: t('container'),
            render: (_value, user: PortalUser) => user.instance?.containerName || '-',
          },
          {
            title: t('imageVersion'),
            render: (_value, user: PortalUser) => user.instance?.imageVersion || '-',
          },
          {
            title: t('resource'),
            render: (_value, user: PortalUser) => {
              const limits = user.instance?.resourceLimits;
              return limits ? `${limits.cpu} CPU / ${limits.memoryMiB} MiB` : '-';
            },
          },
          {
            title: t('lastActive'),
            render: (_value, user: PortalUser) => formatTime(user.instance?.lastActiveAt),
          },
          {
            title: t('actions'),
            render: (_value, user: PortalUser) => (
              <Space>
                <Button size='small' icon={<Play />} onClick={() => onStart(user.userId)}>
                  {t('start')}
                </Button>
                <Button size='small' status='danger' icon={<Power />} onClick={() => onStop(user.userId)}>
                  {t('stop')}
                </Button>
                <Button size='small' onClick={() => onResetPassword(user.userId)}>
                  {t('resetPassword')}
                </Button>
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}

function SettingsView({ token }: { token: string }) {
  const [form] = Form.useForm();
  const [settings, setSettings] = useState<PortalSettingsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  async function reloadSettings() {
    setLoading(true);
    try {
      const nextSettings = await loadPortalSettings(token);
      setSettings(nextSettings);
      form.setFieldsValue(nextSettings.values);
    } catch {
      Message.error(t('settingsLoadFailed'));
    } finally {
      setLoading(false);
    }
  }

  async function submit() {
    const values = await form.validate();
    let nextValues: PortalSettingsValues;
    try {
      nextValues = normalizeSettingsFormValues(values);
    } catch {
      Message.error(t('settingIntegerRequired'));
      return;
    }

    setSaving(true);
    try {
      const nextSettings = await updatePortalSettings(token, nextValues);
      setSettings(nextSettings);
      form.setFieldsValue(nextSettings.values);
      Message.success(t('settingsSaved'));
    } catch {
      Message.error(t('settingsSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    reloadSettings();
  }, [token]);

  return (
    <Card
      className='workspace-card'
      title={t('settings')}
      loading={loading && !settings}
      extra={
        <Space>
          <Button icon={<Refresh />} loading={loading} onClick={reloadSettings}>
            {t('refresh')}
          </Button>
          <Button type='primary' loading={saving} onClick={submit}>
            {t('save')}
          </Button>
        </Space>
      }
    >
      <Form form={form} layout='vertical' initialValues={settings?.values} className='settings-form'>
        {SETTING_SECTIONS.map((section) => (
          <section className='settings-section' key={section}>
            <Typography.Title heading={5}>{t(section)}</Typography.Title>
            <Row gutter={[16, 0]}>
              {SETTING_FIELDS.filter((field) => field.section === section).map((field) => (
                <Col xs={24} md={12} key={field.key}>
                  <Form.Item
                    field={field.key}
                    label={t(field.label)}
                    rules={[{ required: true, message: t('settingRequired') }]}
                  >
                    {field.valueType === 'integer' ? <InputNumber className='settings-input' min={0} /> : <Input />}
                  </Form.Item>
                </Col>
              ))}
            </Row>
          </section>
        ))}
      </Form>
    </Card>
  );
}

function AuditLogsView({ logs }: { logs: AuditLog[] }) {
  return (
    <Card className='workspace-card' title={t('auditLogs')}>
      <Table
        rowKey={(record) => `${record.action}-${record.targetUserId}-${record.createdAt}`}
        data={logs}
        pagination={{ pageSize: 12 }}
        columns={[
          { title: t('action'), dataIndex: 'action' },
          { title: t('result'), dataIndex: 'result' },
          {
            title: t('target'),
            render: (_value, log: AuditLog) => log.targetUserId || log.targetInstanceId || '-',
          },
          {
            title: t('reason'),
            render: (_value, log: AuditLog) => log.reason || log.errorCode || '-',
          },
          {
            title: t('sourceIp'),
            render: (_value, log: AuditLog) => log.sourceIp || '-',
          },
          {
            title: t('createdAt'),
            render: (_value, log: AuditLog) => formatTime(log.createdAt),
          },
        ]}
      />
    </Card>
  );
}

function ReservedView({ title, body }: { title: string; body: string }) {
  return (
    <Card className='workspace-card reserved-panel'>
      <Typography.Title heading={4}>{title}</Typography.Title>
      <Typography.Paragraph>{body}</Typography.Paragraph>
    </Card>
  );
}

export function App() {
  const isAdminPath = window.location.pathname.startsWith('/admin');
  const [language, setLanguage] = useState<Language>(() => {
    const resolved = initialLanguage();
    setCurrentLanguage(resolved);
    return resolved;
  });
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_STORAGE_KEY) || '');
  const [activeView, setActiveView] = useState<ViewKey>('dashboard');
  const [data, setData] = useState<AdminData>({ users: [], auditLogs: [] });
  const [loading, setLoading] = useState(false);
  const [temporaryPassword, setTemporaryPassword] = useState<{ value: string; expiresAt: string } | null>(null);

  const menuItems = useMemo(
    () => [
      { key: 'dashboard', icon: <DashboardOne />, label: t('dashboard') },
      { key: 'users', icon: <People />, label: t('users') },
      { key: 'instances', icon: <Server />, label: t('instances') },
      { key: 'settings', icon: <SettingConfig />, label: t('settings') },
      { key: 'nodes', icon: <ListView />, label: t('nodes') },
      { key: 'marketplace', icon: <Shop />, label: t('marketplace') },
      { key: 'auditLogs', icon: <ListView />, label: t('auditLogs') },
    ],
    [language]
  );

  function changeLanguage(nextLanguage: Language) {
    setCurrentLanguage(nextLanguage);
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
    setLanguage(nextLanguage);
  }

  async function reload(currentToken = token) {
    if (!currentToken) return;
    setLoading(true);
    try {
      setData(await loadAdminData(currentToken));
    } catch {
      Message.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(values: Record<string, string>) {
    try {
      await createUser(token, {
        username: values.username,
        password: values.password,
        userId: values.userId,
        displayName: values.displayName,
      });
      Message.success(t('userCreated'));
      await reload();
    } catch {
      Message.error(t('createFailed'));
    }
  }

  async function runInstanceAction(action: 'start' | 'stop', userId: string) {
    try {
      if (action === 'start') {
        await startInstance(token, userId);
      } else {
        await stopInstance(token, userId);
      }
      Message.success(t('operationStarted'));
      await reload();
    } catch {
      Message.error(t('actionFailed'));
    }
  }

  async function handleResetPassword(userId: string) {
    try {
      const result = await resetInstancePassword(token, userId);
      setTemporaryPassword({ value: result.temporaryPassword, expiresAt: result.expiresAt });
      await reload();
    } catch {
      Message.error(t('resetFailed'));
    }
  }

  useEffect(() => {
    reload();
  }, [token]);

  if (!isAdminPath) return <UserPortal language={language} onLanguageChange={changeLanguage} />;
  if (!token) return <LoginGate language={language} onLanguageChange={changeLanguage} onToken={setToken} />;

  return (
    <Layout className='admin-shell'>
      <Sider className='admin-sider' width={248}>
        <div className='sider-brand'>
          <div className='brand-mark'>AU</div>
          <div>
            <div className='brand-title'>{t('appTitle')}</div>
            <div className='brand-subtitle'>{t('appSubtitle')}</div>
          </div>
        </div>
        <Menu selectedKeys={[activeView]} onClickMenuItem={(key) => setActiveView(key as ViewKey)}>
          {menuItems.map((item) => (
            <Menu.Item key={item.key}>
              <span className='menu-icon'>{item.icon}</span>
              {item.label}
            </Menu.Item>
          ))}
        </Menu>
      </Sider>
      <Layout>
        <Content className='admin-content'>
          <header className='content-header'>
            <div>
              <Typography.Title heading={3}>
                {menuItems.find((item) => item.key === activeView)?.label}
              </Typography.Title>
              <Typography.Paragraph className='muted'>{t('appSubtitle')}</Typography.Paragraph>
            </div>
            <Space>
              <LanguageSwitch value={language} onChange={changeLanguage} />
              <Button icon={<Refresh />} loading={loading} onClick={() => reload()}>
                {t('refresh')}
              </Button>
            </Space>
          </header>

          {activeView === 'dashboard' && <Dashboard data={data} />}
          {activeView === 'users' && <UsersView data={data} onCreate={handleCreate} />}
          {activeView === 'instances' && (
            <InstancesView
              data={data}
              onStart={(userId) => runInstanceAction('start', userId)}
              onStop={(userId) => runInstanceAction('stop', userId)}
              onResetPassword={handleResetPassword}
            />
          )}
          {activeView === 'settings' && <SettingsView token={token} />}
          {activeView === 'nodes' && <ReservedView title={t('nodeReservedTitle')} body={t('nodeReservedBody')} />}
          {activeView === 'marketplace' && (
            <ReservedView title={t('marketReservedTitle')} body={t('marketReservedBody')} />
          )}
          {activeView === 'auditLogs' && <AuditLogsView logs={data.auditLogs} />}
          <Modal
            title={t('breakGlassTitle')}
            visible={Boolean(temporaryPassword)}
            footer={null}
            onCancel={() => setTemporaryPassword(null)}
          >
            <Typography.Paragraph>{t('breakGlassBody')}</Typography.Paragraph>
            <Input readOnly value={temporaryPassword?.value || ''} />
            <Typography.Paragraph className='muted password-expiry'>
              {t('expiresAt')}: {temporaryPassword?.expiresAt || '-'}
            </Typography.Paragraph>
          </Modal>
        </Content>
      </Layout>
    </Layout>
  );
}
