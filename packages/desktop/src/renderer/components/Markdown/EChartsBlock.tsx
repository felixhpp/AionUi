/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ECBasicOption as EChartsCoreOption } from 'echarts/types/dist/shared.js';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, ScatterChart, RadarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  ToolboxComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import SyntaxHighlighter from 'react-syntax-highlighter';
import { vs, vs2015 } from 'react-syntax-highlighter/dist/esm/styles/hljs';

import { copyText } from '@/renderer/utils/ui/clipboard';
import { Message } from '@arco-design/web-react';
import { Copy, PreviewOpen } from '@icon-park/react';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  RadarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  ToolboxComponent,
  CanvasRenderer,
]);

const CHART_LANGUAGES = new Set(['echarts', 'chart']);

type EChartsBlockProps = {
  code: string;
  style?: React.CSSProperties;
  showOpenInPanelButton?: boolean;
};

const DEFAULT_HEIGHT = 400;

function EChartsBlock({ code, style, showOpenInPanelButton = true }: EChartsBlockProps) {
  const { t } = useTranslation();
  const { openPreview } = usePreviewContext();
  const chartFrameRef = useRef<HTMLDivElement>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<echarts.ECharts | null>(null);
  const preferredViewModeRef = useRef<'preview' | 'source' | null>(null);
  const [chartOption, setChartOption] = useState<EChartsCoreOption | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('source');
  const [debouncedCode, setDebouncedCode] = useState(code);
  const [currentTheme, setCurrentTheme] = useState<'light' | 'dark'>(() => {
    return (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light';
  });

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedCode(code), 300);
    return () => clearTimeout(timer);
  }, [code]);

  useEffect(() => {
    const updateTheme = () => {
      const theme = (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light';
      setCurrentTheme(theme);
    };

    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const source = debouncedCode.trim();

    if (!source) {
      setChartOption(null);
      setParseError(null);
      setViewMode('source');
      return () => {
        cancelled = true;
      };
    }

    try {
      const option = JSON.parse(source) as EChartsCoreOption;
      if (!cancelled) {
        setChartOption(option);
        setParseError(null);
        setViewMode(preferredViewModeRef.current === 'source' ? 'source' : 'preview');
      }
    } catch (e) {
      if (!cancelled) {
        setChartOption(null);
        setParseError(e instanceof Error ? e.message : String(e));
        setViewMode('source');
      }
    }

    return () => {
      cancelled = true;
    };
  }, [debouncedCode]);

  useEffect(() => {
    if (!chartContainerRef.current || !chartOption || viewMode !== 'preview') {
      if (viewMode !== 'preview' || !chartOption) {
        chartInstanceRef.current?.dispose();
        chartInstanceRef.current = null;
      }
      return;
    }

    if (chartInstanceRef.current && chartInstanceRef.current.getDom() !== chartContainerRef.current) {
      chartInstanceRef.current.dispose();
      chartInstanceRef.current = null;
    }

    if (!chartInstanceRef.current) {
      chartInstanceRef.current = echarts.init(chartContainerRef.current, undefined, {
        renderer: 'canvas',
        width: chartContainerRef.current.offsetWidth || undefined,
        height: DEFAULT_HEIGHT,
      });
    }

    const isDark = currentTheme === 'dark';
    const themedOption: EChartsCoreOption = {
      backgroundColor: 'transparent',
      ...chartOption,
    };

    const optionRecord = chartOption as Record<string, unknown>;
    if (!optionRecord.color && !optionRecord.series) {
      (themedOption as Record<string, unknown>).color = isDark
        ? ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4']
        : ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4'];
    }

    try {
      chartInstanceRef.current.setOption(themedOption, true);
      setParseError(null);
    } catch (e) {
      chartInstanceRef.current.dispose();
      chartInstanceRef.current = null;
      setParseError(e instanceof Error ? e.message : String(e));
      setViewMode('source');
      return;
    }

    requestAnimationFrame(() => {
      chartInstanceRef.current?.resize();
    });

    return () => {
      // keep instance alive across option updates
    };
  }, [chartOption, viewMode, currentTheme]);

  useEffect(() => {
    const chartEl = chartContainerRef.current;
    const frameEl = chartFrameRef.current;
    if (!chartEl && !frameEl) return;

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        chartInstanceRef.current?.resize();
      });
    });

    if (chartEl) resizeObserver.observe(chartEl);
    if (frameEl) resizeObserver.observe(frameEl);

    return () => {
      resizeObserver.disconnect();
    };
  }, [viewMode]);

  useEffect(() => {
    return () => {
      chartInstanceRef.current?.dispose();
      chartInstanceRef.current = null;
    };
  }, []);

  const codeTheme = currentTheme === 'dark' ? vs2015 : vs;
  const summary = code
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const previewTitle =
    summary && summary.length > 0
      ? `${t('preview.chartTitle')}: ${summary.slice(0, 48)}${summary.length > 48 ? '...' : ''}`
      : t('preview.chartTitle');

  const handleCopy = () => {
    void copyText(code)
      .then(() => {
        Message.success(t('common.copySuccess'));
      })
      .catch(() => {
        Message.error(t('common.copyFailed'));
      });
  };

  const renderChart = () => {
    if (parseError) {
      return (
        <div
          data-testid='echarts-error'
          style={{
            backgroundColor: 'var(--bg-1)',
            padding: '12px',
            color: 'var(--color-danger-6)',
            fontSize: '13px',
            lineHeight: '20px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {t('preview.chartParseError')}: {parseError}
        </div>
      );
    }

    return (
      <div
        ref={chartFrameRef}
        data-testid='echarts-chart'
        style={{
          backgroundColor: 'var(--bg-1)',
          boxSizing: 'border-box',
          maxWidth: '100%',
          minWidth: 0,
          overflow: 'hidden',
          padding: '12px',
          width: '100%',
        }}
      >
        <div
          ref={chartContainerRef}
          style={{
            boxSizing: 'border-box',
            display: 'block',
            height: `${DEFAULT_HEIGHT}px`,
            maxWidth: '100%',
            minWidth: 0,
            width: '100%',
          }}
        />
      </div>
    );
  };

  return (
    <div style={{ width: '100%', minWidth: 0, maxWidth: '100%', ...style }}>
      <div
        style={{
          border: '1px solid var(--bg-3)',
          borderRadius: '0.3rem',
          overflow: 'hidden',
          overflowX: 'auto',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
            backgroundColor: 'var(--bg-2)',
            borderTopLeftRadius: '0.3rem',
            borderTopRightRadius: '0.3rem',
            padding: '6px 10px',
            borderBottom: '1px solid var(--bg-3)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              style={{
                textDecoration: 'none',
                color: 'var(--text-secondary)',
                fontSize: '12px',
                lineHeight: '20px',
              }}
            >
              {'<chart>'}
            </span>
            {chartOption && !parseError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <div
                  style={{
                    cursor: 'pointer',
                    color: viewMode === 'preview' ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontSize: '12px',
                    lineHeight: '20px',
                  }}
                  onMouseDown={(event: React.MouseEvent) => {
                    if (event.button === 0) {
                      event.preventDefault();
                      preferredViewModeRef.current = 'preview';
                      setViewMode('preview');
                    }
                  }}
                >
                  {t('preview.preview')}
                </div>
                <span style={{ color: 'var(--text-secondary)', fontSize: '12px', lineHeight: '20px' }}>/</span>
                <div
                  style={{
                    cursor: 'pointer',
                    color: viewMode === 'source' ? 'var(--text-primary)' : 'var(--text-secondary)',
                    fontSize: '12px',
                    lineHeight: '20px',
                  }}
                  onMouseDown={(event: React.MouseEvent) => {
                    if (event.button === 0) {
                      event.preventDefault();
                      preferredViewModeRef.current = 'source';
                      setViewMode('source');
                    }
                  }}
                >
                  {t('preview.source')}
                </div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            {showOpenInPanelButton && chartOption && !parseError && (
              <PreviewOpen
                data-testid='echarts-open-in-panel'
                theme='outline'
                size='18'
                style={{ cursor: 'pointer', flexShrink: 0 }}
                fill='var(--text-secondary)'
                title={t('preview.openInPanelTooltip')}
                onClick={() => {
                  openPreview(`\`\`\`chart\n${code}\n\`\`\``, 'markdown', {
                    title: previewTitle,
                    editable: false,
                  });
                }}
              />
            )}
            <Copy
              data-testid='echarts-copy'
              theme='outline'
              size='18'
              style={{ cursor: 'pointer', flexShrink: 0 }}
              fill='var(--text-secondary)'
              onClick={handleCopy}
            />
          </div>
        </div>

        {parseError || (chartOption && viewMode === 'preview') ? (
          renderChart()
        ) : (
          <SyntaxHighlighter
            children={code}
            language='json'
            style={codeTheme}
            PreTag='div'
            customStyle={{
              margin: 0,
              borderRadius: 0,
              border: 'none',
              background: 'transparent',
              color: 'var(--text-primary)',
              overflowX: 'auto',
              maxWidth: '100%',
            }}
            codeTagProps={{ style: { color: 'var(--text-primary)' } }}
          />
        )}
      </div>
    </div>
  );
}

export default React.memo(EChartsBlock);

export { CHART_LANGUAGES };
