import { AgentLogoIcon } from '@/renderer/components/agent/AgentBadge';
import type { PresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import FlexFullContainer from '@/renderer/components/layout/FlexFullContainer';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { useNavigationHistory } from '@/renderer/hooks/context/NavigationHistoryContext';
import { useResizableSplit } from '@/renderer/hooks/ui/useResizableSplit';
import ChatTitleEditor from '@/renderer/pages/conversation/components/ChatTitleEditor';
import MobileWorkspaceOverlay from './MobileWorkspaceOverlay';
import WorkspacePanelHeader, { DesktopWorkspaceToggle } from './WorkspacePanelHeader';
import { useContainerWidth } from '@/renderer/pages/conversation/hooks/useContainerWidth';
import { useLayoutConstraints } from '@/renderer/pages/conversation/hooks/useLayoutConstraints';
import { usePreviewAutoCollapse } from '@/renderer/pages/conversation/hooks/usePreviewAutoCollapse';
import { useTitleRename } from '@/renderer/pages/conversation/hooks/useTitleRename';
import { useWorkspaceCollapse } from '@/renderer/pages/conversation/hooks/useWorkspaceCollapse';
import { PreviewPanel, usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { dispatchWorkspaceToggleEvent } from '@/renderer/utils/workspace/workspaceEvents';
import { useConversationAgents } from '@/renderer/pages/conversation/hooks/useConversationAgents';
import { isElectronDesktop } from '@/renderer/utils/platform';
import classNames from 'classnames';
import { isMacEnvironment, isWindowsEnvironment } from '@/renderer/pages/conversation/utils/detectPlatform';
import {
  DEFAULT_WORKSPACE_PANEL_PX,
  MAX_WORKSPACE_PANEL_PX,
  MIN_WORKSPACE_PANEL_PX,
  WORKSPACE_HEADER_HEIGHT,
  calcLayoutMetrics,
} from '@/renderer/pages/conversation/utils/layoutCalc';
import { Layout as ArcoLayout } from '@arco-design/web-react';
import { ArrowLeft, ArrowRight, ExpandLeft, ExpandRight } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import './chat-layout.css';

const SidebarIcon: React.FC<{ size?: number; strokeWidth?: number }> = ({ size = 18, strokeWidth = 4 }) => (
  <svg
    width={size}
    height={size}
    viewBox='0 0 48 48'
    fill='none'
    stroke='currentColor'
    strokeWidth={strokeWidth}
    strokeLinecap='round'
    strokeLinejoin='round'
    aria-hidden='true'
    focusable='false'
  >
    <rect x='6' y='10' width='36' height='28' rx='5' />
    <line x1='18' y1='10' x2='18' y2='38' />
  </svg>
);

// headerExtra allows injecting custom actions (e.g., model picker) into the header's right area
const ChatLayout: React.FC<{
  children: React.ReactNode;
  title?: React.ReactNode;
  sider: React.ReactNode;
  siderTitle?: React.ReactNode;
  backend?: string;
  /** Preset assistant info — when provided, badge shows assistant identity instead of backend */
  presetAssistant?: PresetAssistantInfo & { id?: string };
  /** Fallback agent name (used when no presetAssistant, e.g. from conversation.extra.agent_name) */
  agent_name?: string;
  headerExtra?: React.ReactNode;
  workspaceEnabled?: boolean;
  /** Conversation ID for mode switching */
  conversation_id?: string;
  /** Custom tabs slot; when provided, replaces the default ConversationTabs */
  tabsSlot?: React.ReactNode;
  /** Workspace path for opening in external tools */
  workspacePath?: string;
  /** Authoritative temp-workspace flag from `conversation.extra.is_temporary_workspace`. */
  isTemporaryWorkspace?: boolean;
  /**
   * Stable key for persisting the workspace collapse preference. Defaults to
   * `conversation_id` for single chats; team mode passes `team_id` so the
   * preference survives agent-tab switches.
   */
  workspacePreferenceKey?: string;
  /** Custom rename handler; when provided, replaces the default conversation.update rename flow */
  onRenameTitle?: (new_name: string) => Promise<boolean>;
  /** Optional override for the leading icon shown before the title (e.g. team Peoples icon) */
  headerLeading?: React.ReactNode;
}> = (props) => {
  const { conversation_id, workspacePath, isTemporaryWorkspace } = props;
  const { backend, presetAssistant, agent_name, workspaceEnabled = true, workspacePreferenceKey } = props;
  const layout = useLayoutContext();
  const isMacRuntime = isMacEnvironment();
  const isWindowsRuntime = isWindowsEnvironment();
  const isDesktop = !layout?.isMobile;
  const isMobile = Boolean(layout?.isMobile);
  const isWebui = !isElectronDesktop();
  const navigationHistory = useNavigationHistory();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  // Preview panel state
  const { isOpen: isPreviewOpen } = usePreviewContext();

  // --- Hook A: workspace collapse ---
  const { rightSiderCollapsed, setRightSiderCollapsed } = useWorkspaceCollapse({
    workspaceEnabled,
    isMobile,
    conversation_id,
    preferenceKey: workspacePreferenceKey ?? conversation_id,
    isTemporaryWorkspace,
  });

  // --- Hook B: container width ---
  const { containerRef, containerWidth } = useContainerWidth();

  // --- Hook C: title rename ---
  const { editingTitle, setEditingTitle, titleDraft, setTitleDraft, renameLoading, canRenameTitle, submitTitleRename } =
    useTitleRename({
      title: props.title,
      conversation_id,
      onRename: props.onRenameTitle,
    });

  // Resolve backend display name from detected agents catalog (backend-authoritative).
  // Custom ACP agents live in the same catalog with `agent_source === 'custom'`,
  // so we no longer need a separate `acp.customAgents` ConfigStorage fallback.
  const { cliAgents } = useConversationAgents();
  const backendAgentName = backend
    ? cliAgents.find((a) => a.backend === backend || a.agent_type === backend)?.name
    : undefined;
  const capitalizedBackend = backend ? backend.charAt(0).toUpperCase() + backend.slice(1) : backend;

  // Compute display name with fallback chain
  const display_name = presetAssistant?.name || agent_name || backendAgentName || capitalizedBackend;

  const {
    splitRatio: workspaceWidthPxPref,
    setSplitRatio: setWorkspaceWidthPxPref,
    createDragHandle: createWorkspaceDragHandle,
  } = useResizableSplit({
    unit: 'px',
    defaultWidth: DEFAULT_WORKSPACE_PANEL_PX,
    minWidth: MIN_WORKSPACE_PANEL_PX,
    maxWidth: MAX_WORKSPACE_PANEL_PX,
    storageKey: 'chat-workspace-width-px',
  });

  // Pre-hook metrics: compute dynamic min/max for the chat-preview split hook
  const { dynamicChatMinRatio, dynamicChatMaxRatio } = calcLayoutMetrics({
    containerWidth,
    workspaceWidthPx: workspaceWidthPxPref,
    chatSplitRatio: 60, // placeholder; only dynamicChatMinRatio/dynamicChatMaxRatio are used here
    workspaceEnabled,
    isDesktop,
    isPreviewOpen,
    rightSiderCollapsed,
    isMobile,
  });

  const {
    splitRatio: chatSplitRatio,
    setSplitRatio: setChatSplitRatio,
    createDragHandle: createPreviewDragHandle,
  } = useResizableSplit({
    defaultWidth: 60,
    minWidth: dynamicChatMinRatio,
    maxWidth: dynamicChatMaxRatio,
    storageKey: 'chat-preview-split-ratio',
  });

  // Full metrics with real chatSplitRatio
  const { chatFlex, workspaceWidthPx, titleAreaMaxWidth, mobileWorkspaceHandleRight } = calcLayoutMetrics({
    containerWidth,
    workspaceWidthPx: workspaceWidthPxPref,
    chatSplitRatio,
    workspaceEnabled,
    isDesktop,
    isPreviewOpen,
    rightSiderCollapsed,
    isMobile,
  });

  // --- Hook D: preview auto-collapse ---
  usePreviewAutoCollapse({
    isPreviewOpen,
    isDesktop,
    workspaceEnabled,
    rightSiderCollapsed,
    setRightSiderCollapsed,
    siderCollapsed: layout?.siderCollapsed,
    setSiderCollapsed: layout?.setSiderCollapsed,
  });

  // --- Hook E: layout constraints ---
  useLayoutConstraints({
    containerWidth,
    workspaceEnabled,
    isDesktop,
    isPreviewOpen,
    rightSiderCollapsed,
    setRightSiderCollapsed,
    workspaceWidthPx: workspaceWidthPxPref,
    setWorkspaceWidthPx: setWorkspaceWidthPxPref,
    chatSplitRatio,
    setChatSplitRatio,
    dynamicChatMinRatio,
    dynamicChatMaxRatio,
  });

  const [mobileActionsSlot, setMobileActionsSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!layout?.isMobile) {
      setMobileActionsSlot(null);
      return;
    }
    const findSlot = () => document.getElementById('app-titlebar-actions-slot');
    setMobileActionsSlot(findSlot());
    const observer = new MutationObserver(() => {
      const next = findSlot();
      setMobileActionsSlot((prev) => (prev === next ? prev : next));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [layout?.isMobile]);

  const desktopHeader = (
    <ArcoLayout.Header
      className={classNames(
        'min-h-44px flex items-center justify-between px-16px pt-8px pb-10px gap-16px !bg-1 chat-layout-header chat-layout-header--glass overflow-hidden'
      )}
    >
      {isWebui && navigationHistory && (
        <div className='flex items-center gap-2px shrink-0'>
          <button
            type='button'
            className='chat-header__nav-btn'
            onClick={() => navigationHistory.back()}
            disabled={!navigationHistory.canBack}
            aria-label={t('common.historyBack', { defaultValue: 'Back' })}
            title={t('common.historyBack', { defaultValue: 'Back' })}
          >
            <ArrowLeft theme='outline' size={16} fill='currentColor' strokeWidth={2.5} />
          </button>
          <button
            type='button'
            className='chat-header__nav-btn'
            onClick={() => navigationHistory.forward()}
            disabled={!navigationHistory.canForward}
            aria-label={t('common.forward', { defaultValue: 'Forward' })}
            title={t('common.forward', { defaultValue: 'Forward' })}
          >
            <ArrowRight theme='outline' size={16} fill='currentColor' strokeWidth={2.5} />
          </button>
        </div>
      )}
      <FlexFullContainer className='h-full min-w-0' containerClassName='flex items-center'>
        <ChatTitleEditor
          editingTitle={editingTitle}
          titleDraft={titleDraft}
          setTitleDraft={setTitleDraft}
          setEditingTitle={setEditingTitle}
          renameLoading={renameLoading}
          canRenameTitle={canRenameTitle}
          submitTitleRename={submitTitleRename}
          titleAreaMaxWidth={titleAreaMaxWidth}
          title={props.title}
          conversation_id={conversation_id}
          leading={
            props.headerLeading ??
            ((backend || presetAssistant) && (
              <AgentLogoIcon
                backend={backend}
                agent_name={display_name}
                agentLogo={presetAssistant?.logo}
                agentLogoIsEmoji={presetAssistant?.isEmoji}
              />
            ))
          }
        />
      </FlexFullContainer>
      <div className='flex items-center gap-12px shrink-0'>
        {props.headerExtra}
        {(isWindowsRuntime || isWebui) && workspaceEnabled && (
          <button
            type='button'
            className='workspace-header__toggle'
            aria-label='Toggle workspace'
            onClick={() => dispatchWorkspaceToggleEvent()}
          >
            {rightSiderCollapsed ? <ExpandRight size={16} /> : <ExpandLeft size={16} />}
          </button>
        )}
      </div>
    </ArcoLayout.Header>
  );

  const isSettingsRoute = typeof location !== 'undefined' && location.pathname.startsWith('/settings');
  const siderTooltip = layout?.siderCollapsed
    ? t('common.expandMore', { defaultValue: 'Expand sidebar' })
    : t('common.collapse', { defaultValue: 'Collapse sidebar' });

  const webuiMobileHeader = (
    <ArcoLayout.Header className='chat-layout-header--mobile-unified min-h-44px flex items-center justify-between px-8px pt-4px pb-6px gap-8px !bg-1'>
      <button
        type='button'
        className='workspace-header__toggle shrink-0'
        onClick={() => {
          if (isSettingsRoute) {
            void navigate(-1);
          } else if (layout?.setSiderCollapsed) {
            layout.setSiderCollapsed(!layout.siderCollapsed);
          }
        }}
        aria-label={isSettingsRoute ? t('common.back', { defaultValue: 'Back' }) : siderTooltip}
      >
        {isSettingsRoute ? (
          <ArrowLeft theme='outline' size={16} fill='currentColor' />
        ) : (
          <SidebarIcon size={16} strokeWidth={2.5} />
        )}
      </button>
      <span className='flex-1 min-w-0 truncate text-14px font-semibold text-t-primary px-4px'>
        {props.title || 'AionUi'}
      </span>
      <div className='flex items-center gap-4px shrink-0'>
        {props.headerExtra}
        {workspaceEnabled && (
          <button
            type='button'
            className='workspace-header__toggle'
            aria-label='Toggle workspace'
            onClick={() => dispatchWorkspaceToggleEvent()}
          >
            {rightSiderCollapsed ? <ExpandRight size={16} /> : <ExpandLeft size={16} />}
          </button>
        )}
      </div>
    </ArcoLayout.Header>
  );

  const headerBlock = (
    <>
      {layout?.isMobile
        ? isWebui
          ? webuiMobileHeader
          : mobileActionsSlot && props.headerExtra && createPortal(props.headerExtra, mobileActionsSlot)
        : desktopHeader}
      {props.tabsSlot}
    </>
  );

  return (
    <ArcoLayout
      className='size-full color-black '
      style={{
        // fontFamily: `cursive,"anthropicSans","anthropicSans Fallback",system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif`,
      }}
    >
      <div ref={containerRef} className='flex flex-1 relative w-full overflow-hidden'>
        {/* Unified layout: single DOM structure prevents children unmount/remount on preview toggle */}
        <div
          className='flex flex-col min-w-0'
          style={{
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: 0,
          }}
        >
          <div className='shrink-0 !bg-1'>{headerBlock}</div>
          <div className='flex flex-1 min-h-0 relative'>
            {/* Chat area - always mounted, never unmounted on preview toggle */}
            <div
              className='flex flex-col relative'
              style={{
                flexGrow: isPreviewOpen && isDesktop ? 0 : 1,
                flexShrink: 0,
                flexBasis: isPreviewOpen && isDesktop ? `${chatFlex}%` : 0,
                display: isPreviewOpen && isMobile ? 'none' : 'flex',
                minWidth: '240px',
              }}
              onClick={() => {
                if (window.innerWidth < 768 && !rightSiderCollapsed) setRightSiderCollapsed(true);
              }}
            >
              <ArcoLayout.Content className='flex flex-col flex-1 bg-1 overflow-hidden'>
                {props.children}
              </ArcoLayout.Content>
            </div>
            {/* Preview panel - conditionally rendered */}
            {isPreviewOpen && (
              <div
                className={classNames(
                  'preview-panel flex flex-col relative overflow-visible rounded-[15px]',
                  isDesktop ? 'mb-[12px] mr-[12px] ml-[8px]' : 'm-[8px]'
                )}
                style={{
                  flexGrow: 1,
                  flexShrink: 1,
                  flexBasis: 0,
                  border: '1px solid var(--bg-3)',
                  minWidth: isDesktop ? '260px' : 0,
                  maxWidth: isMobile ? 'calc(100% - 16px)' : undefined,
                  width: isMobile ? 'calc(100% - 16px)' : undefined,
                  boxSizing: 'border-box',
                }}
              >
                {isDesktop &&
                  createPreviewDragHandle({
                    className: 'absolute top-0 bottom-0 z-30',
                    style: { width: '20px', left: '-20px' },
                    linePlacement: 'end',
                    lineClassName: 'opacity-30 group-hover:opacity-100 group-active:opacity-100',
                    lineStyle: { width: '2px' },
                  })}
                <div className='h-full w-full overflow-hidden rounded-[15px]'>
                  <PreviewPanel />
                </div>
              </div>
            )}
          </div>
        </div>
        {workspaceEnabled && !layout?.isMobile && (
          <div
            className={classNames('!bg-1 relative chat-layout-right-sider layout-sider')}
            style={{
              flexGrow: 0,
              flexShrink: 0,
              flexBasis: rightSiderCollapsed ? '0px' : `${Math.round(workspaceWidthPx)}px`,
              width: rightSiderCollapsed ? '0px' : `${Math.round(workspaceWidthPx)}px`,
              minWidth: rightSiderCollapsed ? '0px' : `${MIN_WORKSPACE_PANEL_PX}px`,
              overflow: 'hidden',
              borderLeft: rightSiderCollapsed ? 'none' : '1px solid var(--bg-3)',
            }}
          >
            {isDesktop &&
              !rightSiderCollapsed &&
              createWorkspaceDragHandle({ className: 'absolute left-0 top-0 bottom-0', style: {}, reverse: true })}
            <WorkspacePanelHeader
              showToggle={!isMacRuntime && !isWindowsRuntime}
              collapsed={rightSiderCollapsed}
              onToggle={() => dispatchWorkspaceToggleEvent()}
              togglePlacement={layout?.isMobile ? 'left' : 'right'}
              workspacePath={workspacePath}
              isTemporaryWorkspace={isTemporaryWorkspace}
            >
              {props.siderTitle}
            </WorkspacePanelHeader>
            <ArcoLayout.Content style={{ height: `calc(100% - ${WORKSPACE_HEADER_HEIGHT}px)` }}>
              {props.sider}
            </ArcoLayout.Content>
          </div>
        )}

        {/* Mobile workspace overlay: backdrop + fixed panel + floating collapse handle */}
        {workspaceEnabled && layout?.isMobile && (
          <MobileWorkspaceOverlay
            rightSiderCollapsed={rightSiderCollapsed}
            setRightSiderCollapsed={setRightSiderCollapsed}
            workspaceWidthPx={workspaceWidthPx}
            mobileWorkspaceHandleRight={mobileWorkspaceHandleRight}
            siderTitle={props.siderTitle}
            sider={props.sider}
            workspacePath={workspacePath}
            isTemporaryWorkspace={isTemporaryWorkspace}
          />
        )}

        {/* Desktop expand button when workspace is collapsed */}
        {!isMacRuntime && !isWindowsRuntime && workspaceEnabled && rightSiderCollapsed && !layout?.isMobile && (
          <DesktopWorkspaceToggle />
        )}
      </div>
    </ArcoLayout>
  );
};

export default ChatLayout;
