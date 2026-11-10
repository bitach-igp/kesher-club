// The Crowded docs renderer and downloader (tools/crowded-docs.mjs): no network, a small collection stands in.
import assert from 'node:assert/strict';
import test from 'node:test';
import { clean, COLLECTION_URL, download, render } from './crowded-docs.mjs';

const collection = {
  info: { name: 'Crowded API Docs', description: '<p>Welcome &amp; hello</p>' },
  item: [
    {
      name: 'Application',
      description: '<p>Hosted form <b>flow</b></p>',
      item: [
        {
          name: 'Submit Bank Application',
          request: { method: 'POST', url: { raw: 'https://sandbox/api/v1/chapters/:chapterId/applications' }, description: '<p>409 while a form is in progress</p>', body: { raw: '{"data":{}}' } },
          response: [{ code: 409, name: 'Form Already In Progress', body: '{"statusCode":409}' }],
        },
      ],
    },
  ],
};

test('clean drops tags and decodes the common entities', () => {
  assert.equal(clean('<p>a &amp; b</p><br/>c &lt;d&gt;'), 'a & b\n\nc <d>');
  assert.equal(clean(undefined), '');
});

test('render keeps folders, the method and URL, the description, the body and each response', () => {
  const md = render(collection);
  assert.match(md, /^# Crowded API Docs\nWelcome & hello/);
  assert.match(md, /\n## Application\nHosted form flow/);
  assert.match(md, /### Submit Bank Application — POST https:\/\/sandbox\/api\/v1\/chapters\/:chapterId\/applications\n409 while a form is in progress/);
  assert.match(md, /REQUEST BODY: \{"data":\{\}\}/);
  assert.match(md, /RESPONSE 409 Form Already In Progress: \{"statusCode":409\}/);
  assert.equal(render(collection), md, 'the rendering is deterministic, so a snapshot check only fails when Crowded changes the docs');
});

test('download contacts only the Postman documenter host over https', async () => {
  const seen = [];
  const options = [];
  const ok = async (u, o) => (seen.push(String(u)), options.push(o), new globalThis.Response(JSON.stringify(collection)));
  assert.deepEqual(await download(COLLECTION_URL, ok), collection);
  assert.deepEqual(seen, [COLLECTION_URL]);
  assert.equal(options[0].redirect, 'error', 'a redirect would leave the one host we contact');
  await assert.rejects(download('http://documenter.gw.postman.com/api/collections/1/2', ok), /Only https/);
  await assert.rejects(download('https://evil.example/api/collections/1/2', ok), /Only https/);
  await assert.rejects(download(COLLECTION_URL, async () => new globalThis.Response('no', { status: 503 })), /503/);
});
