import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  setCurrentLanguage,
  t,
} from '../../packages/aionui-portal/web/src/i18n';

describe('aionui portal web i18n', () => {
  it('uses Chinese as the default language and can switch to English', () => {
    setCurrentLanguage(DEFAULT_LANGUAGE);

    expect(DEFAULT_LANGUAGE).toBe('zh-CN');
    expect(t('userPortalTitle')).toBe('AionUi 运行时门户');

    setCurrentLanguage('en-US');

    expect(t('userPortalTitle')).toBe('AionUi Runtime Portal');
  });

  it('rejects unsupported persisted language values', () => {
    expect(isSupportedLanguage('zh-CN')).toBe(true);
    expect(isSupportedLanguage('en-US')).toBe(true);
    expect(isSupportedLanguage('fr-FR')).toBe(false);
  });
});
