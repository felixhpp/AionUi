/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

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

interface ChartViewerProps {
  content: string;
  hideToolbar?: boolean;
}

type ChartParseError = { kind: 'empty' } | { kind: 'invalid'; message: string };

const ChartViewer: React.FC<ChartViewerProps> = ({ content }) => {
  const { t } = useTranslation();
  const chartFrameRef = useRef<HTMLDivElement>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<echarts.ECharts | null>(null);
  const [chartOption, setChartOption] = useState<Record<string, unknown> | null>(null);
  const [parseError, setParseError] = useState<ChartParseError | null>(null);
  const [currentTheme, setCurrentTheme] = useState<'light' | 'dark'>(() => {
    return (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light';
  });

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
    const source = content.trim();
    if (!source) {
      chartInstanceRef.current?.dispose();
      chartInstanceRef.current = null;
      setChartOption(null);
      setParseError({ kind: 'empty' });
      return;
    }

    try {
      setChartOption(JSON.parse(source) as Record<string, unknown>);
      setParseError(null);
    } catch (e) {
      chartInstanceRef.current?.dispose();
      chartInstanceRef.current = null;
      setChartOption(null);
      setParseError({ kind: 'invalid', message: e instanceof Error ? e.message : String(e) });
      return;
    }
  }, [content]);

  useEffect(() => {
    if (!chartContainerRef.current || !chartOption) return;

    if (chartInstanceRef.current && chartInstanceRef.current.getDom() !== chartContainerRef.current) {
      chartInstanceRef.current.dispose();
      chartInstanceRef.current = null;
    }

    if (!chartInstanceRef.current) {
      chartInstanceRef.current = echarts.init(chartContainerRef.current, undefined, {
        renderer: 'canvas',
        width: chartContainerRef.current.offsetWidth || undefined,
        height: chartContainerRef.current.offsetHeight || undefined,
      });
    }

    const isDark = currentTheme === 'dark';
    const themedOption: Record<string, unknown> = {
      backgroundColor: 'transparent',
      ...chartOption,
    };

    if (!chartOption.color && !chartOption.series) {
      themedOption.color = isDark
        ? ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4']
        : ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4'];
    }

    try {
      chartInstanceRef.current.setOption(themedOption as echarts.EChartsCoreOption, true);
      setParseError(null);
    } catch (e) {
      chartInstanceRef.current.dispose();
      chartInstanceRef.current = null;
      setParseError({ kind: 'invalid', message: e instanceof Error ? e.message : String(e) });
      return;
    }

    requestAnimationFrame(() => {
      chartInstanceRef.current?.resize();
    });
  }, [chartOption, currentTheme]);

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
  }, [chartOption, parseError]);

  useEffect(() => {
    return () => {
      chartInstanceRef.current?.dispose();
      chartInstanceRef.current = null;
    };
  }, []);

  if (parseError) {
    const errorMessage = parseError.kind === 'empty' ? t('preview.chartEmptyContent') : parseError.message;

    return (
      <div className='flex items-center justify-center h-full p-16px'>
        <div style={{ color: 'var(--color-danger-6)', fontSize: '13px', lineHeight: '20px' }}>
          {t('preview.chartParseError')}: {errorMessage}
        </div>
      </div>
    );
  }

  return (
    <div className='flex flex-col w-full h-full overflow-hidden'>
      <div ref={chartFrameRef} className='flex-1 p-16px flex items-stretch justify-center min-w-0'>
        <div
          data-testid='echarts-chart'
          ref={chartContainerRef}
          style={{
            boxSizing: 'border-box',
            height: '100%',
            maxWidth: '100%',
            minHeight: '400px',
            minWidth: 0,
            width: '100%',
          }}
        />
      </div>
    </div>
  );
};

export default ChartViewer;
