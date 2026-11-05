import assert from 'node:assert/strict';
import { createTranslator, resolveLocale, type Locale, type MessageKey } from '../src/i18n.ts';

const locales: [string | null | undefined, Locale][] = [
  [undefined, 'en'], [null, 'en'], ['', 'en'], ['de-DE', 'en'],
  ['en', 'en'], ['en-US', 'en'], ['EN_gb', 'en'],
  ['zh', 'zh-cn'], ['zh-CN', 'zh-cn'], ['zh_SG', 'zh-cn'], ['zh-Hans', 'zh-cn'],
  ['zh-TW', 'zh-tw'], ['zh_HK', 'zh-tw'], ['zh-MO', 'zh-tw'], ['zh-Hant', 'zh-tw'],
];
for (const [tag, expected] of locales) {
  assert.equal(resolveLocale(tag), expected, `locale ${String(tag)}`);
}

for (const [locale, title, count, opened] of [
  ['en', 'Open With', '3 available', 'Opened with Zed'],
  ['zh-CN', '打开方式', '3 个可用', '已用 Zed 打开'],
  ['zh-TW', '開啟方式', '3 個可用', '已用 Zed 開啟'],
]) {
  const t = createTranslator(locale);
  assert.equal(t('title'), title);
  assert.equal(t('count.available', { n: 3 }), count);
  assert.equal(t('toast.opened', { app: 'Zed' }), opened);
  assert.ok(t('open.ariaLabel').includes('{app}'), 'missing parameters remain visible');
  assert.equal(t('title', { unused: 'value' }), title);
  assert.equal(t('unknown.key' as MessageKey), 'unknown.key');
}
assert.equal(createTranslator('unsupported')('title'), 'Open With');
assert.equal(createTranslator('en')('count.available', { n: 0 }), '0 available');
console.log('i18n: locale selection, translations and interpolation passed');
