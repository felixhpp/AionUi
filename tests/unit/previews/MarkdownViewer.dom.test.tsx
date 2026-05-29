/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const echartsMock = vi.hoisted(() => {
  const instances: Array<{
    setOption: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    getDom: ReturnType<typeof vi.fn>;
  }> = [];

  return {
    instances,
    init: vi.fn((dom: HTMLDivElement) => {
      const instance = {
        setOption: vi.fn(),
        resize: vi.fn(),
        dispose: vi.fn(),
        getDom: vi.fn(() => dom),
      };
      instances.push(instance);
      return instance;
    }),
    use: vi.fn(),
  };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: {
      fetchRemoteImage: { invoke: vi.fn() },
      getImageBase64: { invoke: vi.fn() },
    },
  },
}));

vi.mock('@/common/chat/chatLib', () => ({
  joinPath: (base: string, rel: string) => `${base}/${rel}`,
}));

vi.mock('@/renderer/hooks/chat/useAutoScroll', () => ({
  useAutoScroll: () => {},
}));

vi.mock('@/renderer/hooks/ui/useTextSelection', () => ({
  useTextSelection: () => ({ selectedText: '', selectionPosition: null, clearSelection: vi.fn() }),
}));

vi.mock('@/renderer/hooks/chat/useTypingAnimation', () => ({
  useTypingAnimation: ({ content }: { content: string }) => ({
    displayedContent: content,
    isAnimating: false,
  }),
}));

vi.mock('@/renderer/utils/platform', () => ({
  openExternalUrl: vi.fn(),
}));

vi.mock('@/renderer/utils/chat/latexDelimiters', () => ({
  convertLatexDelimiters: (text: string) => text,
}));

vi.mock('@/renderer/pages/conversation/Preview/components/editors/MarkdownEditor', () => ({
  default: () => <div data-testid='markdown-editor' />,
}));

vi.mock('@/renderer/pages/conversation/Preview/components/renderers/SelectionToolbar', () => ({
  default: () => <div data-testid='selection-toolbar' />,
}));

vi.mock('@/renderer/pages/conversation/Preview/hooks/useScrollSyncHelpers', () => ({
  useContainerScroll: vi.fn(),
  useContainerScrollTarget: vi.fn(),
}));

vi.mock('@/renderer/components/Markdown/MermaidBlock', () => ({
  default: () => <div data-testid='mermaid-block' />,
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({
    openPreview: vi.fn(),
  }),
}));

vi.mock('echarts/core', () => echartsMock);

vi.mock('echarts/charts', () => ({
  BarChart: {},
  LineChart: {},
  PieChart: {},
  RadarChart: {},
  ScatterChart: {},
}));

vi.mock('echarts/components', () => ({
  DataZoomComponent: {},
  GridComponent: {},
  LegendComponent: {},
  TitleComponent: {},
  ToolboxComponent: {},
  TooltipComponent: {},
}));

vi.mock('echarts/renderers', () => ({
  CanvasRenderer: {},
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import MarkdownViewer from '@/renderer/pages/conversation/Preview/components/viewers/MarkdownViewer';
import EChartsBlock from '@/renderer/components/Markdown/EChartsBlock';
import ChartViewer from '@/renderer/pages/conversation/Preview/components/viewers/ChartViewer';

const validChartOption = JSON.stringify({
  xAxis: { type: 'category', data: ['Mon'] },
  yAxis: { type: 'value' },
  series: [{ type: 'bar', data: [1] }],
});

class ResizeObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();
}

describe('MarkdownViewer', () => {
  beforeEach(() => {
    echartsMock.instances.length = 0;
    echartsMock.init.mockClear();
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders markdown content in preview mode', () => {
    render(<MarkdownViewer content='# Hello World' />);
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('renders MarkdownEditor in source mode', () => {
    render(<MarkdownViewer content='# Test' viewMode='source' />);
    expect(screen.getByTestId('markdown-editor')).toBeInTheDocument();
  });

  it('hides toolbar when hideToolbar is true', () => {
    render(<MarkdownViewer content='# Test' hideToolbar />);
    expect(screen.queryByText('preview.preview')).not.toBeInTheDocument();
  });

  it('rebinds ECharts instance when switching from source back to preview', async () => {
    render(<EChartsBlock code={validChartOption} />);

    await waitFor(() => {
      expect(echartsMock.init).toHaveBeenCalledTimes(1);
    });

    fireEvent.mouseDown(screen.getByText('preview.source'), { button: 0 });
    fireEvent.mouseDown(screen.getByText('preview.preview'), { button: 0 });

    await waitFor(() => {
      expect(echartsMock.init).toHaveBeenCalledTimes(2);
    });
  });

  it('renders inline chart frame as a border-box full-width block', async () => {
    render(<EChartsBlock code={validChartOption} />);

    const frame = await screen.findByTestId('echarts-chart');

    expect(frame).toHaveStyle({ width: '100%', boxSizing: 'border-box' });
  });

  it('recovers ChartViewer after invalid content is replaced with valid chart JSON', async () => {
    const { rerender } = render(<ChartViewer content='not json' />);

    await screen.findByText(/preview\.chartParseError/);

    rerender(<ChartViewer content={validChartOption} />);

    await waitFor(() => {
      expect(screen.getByTestId('echarts-chart')).toBeInTheDocument();
      expect(echartsMock.init).toHaveBeenCalled();
    });
  });
});
