import assert from 'node:assert/strict';
import {
  checkWebLink, fillWebLink, isHttpUrl, newWebLinkId, parseWebLinks,
  WEB_LINK_NAME_MAX, WEB_LINK_URL_MAX, WEB_LINKS_MAX, webLinkHost, webLinkLabel,
  type WebLinkDraft, type WebLinkIssue,
} from '../src/webLinks.ts';

const directory = '/home/user/project & 中文';
assert.equal(
  fillWebLink('https://example.com/?raw={path}&encoded={pathUrlEncode}&again={path}', directory),
  `https://example.com/?raw=${directory}&encoded=${encodeURIComponent(directory)}&again=${directory}`,
);
assert.equal(fillWebLink('https://example.com/', directory), 'https://example.com/');

for (const value of ['https://example.com/', 'http://localhost:3000/']) {
  assert.equal(isHttpUrl(value), true, value);
}
for (const value of ['', 'not a URL', '/relative', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com']) {
  assert.equal(isHttpUrl(value), false, value);
}

assert.deepEqual(checkWebLink({ name: ' Docs ', url: ' https://example.com/{pathUrlEncode} ' }), {
  ok: true, name: 'Docs', url: 'https://example.com/{pathUrlEncode}',
});
assert.equal(checkWebLink({ name: '', url: 'https://example.com/{path}' }).ok, true);
const invalid: [WebLinkDraft, WebLinkIssue][] = [
  [{ name: '', url: '  ' }, 'empty-url'],
  [{ name: '', url: 'example.com' }, 'invalid-url'],
  [{ name: '', url: 'javascript:alert(1)' }, 'invalid-url'],
  [{ name: '', url: 'https://example.com/{unknown}' }, 'unknown-placeholder'],
  [{ name: 'x'.repeat(WEB_LINK_NAME_MAX + 1), url: 'https://example.com' }, 'too-long'],
  [{ name: '', url: `https://example.com/${'x'.repeat(WEB_LINK_URL_MAX)}` }, 'too-long'],
];
for (const [draft, issue] of invalid) {
  assert.deepEqual(checkWebLink(draft), { ok: false, issue });
}
assert.equal(checkWebLink({
  name: 'x'.repeat(WEB_LINK_NAME_MAX),
  url: `https://example.com/${'x'.repeat(WEB_LINK_URL_MAX - 'https://example.com/'.length)}`,
}).ok, true);

const link = { id: 'docs', name: ' Docs ', url: 'https://www.example.com/?path={pathUrlEncode}' };
assert.equal(webLinkHost(link.url), 'example.com');
assert.equal(webLinkLabel(link), 'Docs');
assert.equal(webLinkLabel({ ...link, name: '' }), 'example.com');
assert.equal(webLinkLabel({ ...link, name: '', url: 'invalid' }), 'invalid');
assert.equal(webLinkHost('invalid'), '');

for (const value of [undefined, null, {}, 'invalid']) assert.deepEqual(parseWebLinks(value), []);
assert.deepEqual(parseWebLinks([
  null, {}, { ...link, id: '' }, { ...link, id: 'x'.repeat(65) },
  { ...link, name: 123 }, { ...link, url: 'file:///etc/passwd' },
  { ...link, id: ' docs ' }, link,
]), [{ ...link, name: 'Docs' }]);
assert.equal(parseWebLinks(Array.from({ length: WEB_LINKS_MAX + 2 }, (_, i) => ({
  ...link, id: `link-${i}`,
}))).length, WEB_LINKS_MAX);
assert.match(newWebLinkId(), /^wl-[a-z0-9]+-[a-z0-9]+$/);
console.log('web links: templates, validation, labels and stored data passed');
