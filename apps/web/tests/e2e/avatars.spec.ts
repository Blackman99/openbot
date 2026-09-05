import { expect, test } from '@playwright/test';
import { deflateSync } from 'node:zlib';
function largePng() {
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4),
      check = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(512);
  header.writeUInt32BE(512, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(512 * (1 + 512 * 3)), { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
test('uploads a multipart avatar above the adapter default, replaces/removes by CAS and hides bytes from discovery', async ({
  page,
  browser,
  request,
}) => {
  const api = 'http://127.0.0.1:4399',
    origin = 'http://127.0.0.1:4173';
  const workspaceId = 'ae661304-a1bc-4767-9a87-c47de763f749';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await request.post(`${api}/__scenario`, { data: { scenario: 'unclaimed' } });
  await page.request.post(`${api}/__bot/setup`);
  const response = await page.request.post(`${api}/api/v1/workspaces/${workspaceId}/bots`, {
    headers: { origin },
    data: {
      name: 'Avatar helper',
      roleDescription: 'Guide',
      description: '',
      instructions: 'Help',
      modelBinding: {
        scope: { kind: 'workspace', id: workspaceId },
        connectionId: 'ce661304-a1bc-4767-9a87-c47de763f749',
        modelId: 'basic-model',
      },
    },
  });
  expect(response.status()).toBe(201);
  const bot = (await response.json()).bot;
  const path = `/app/workspaces/${workspaceId}/bots/${bot.id}`;
  await page.goto(path);
  await expect(page.getByRole('img', { name: 'Default avatar for Avatar helper' })).toBeVisible();
  const file = { name: 'avatar.png', mimeType: 'image/png', buffer: largePng() };
  expect(file.buffer.length).toBeGreaterThan(512 * 1024);
  await page.getByLabel('Avatar image', { exact: true }).setInputFiles(file);
  await page.getByRole('button', { name: 'Upload avatar', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Avatar updated.');
  await expect(page.getByRole('heading', { name: 'Version 2', exact: true })).toBeVisible();
  const image = page.getByRole('img', { name: 'Avatar for Avatar helper', exact: true });
  await expect(image).toBeVisible();
  expect(await image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  const firstSource = await image.getAttribute('src');
  const stale = await page.context().newPage();
  await stale.goto(path);
  await page.getByLabel('Avatar image', { exact: true }).setInputFiles(file);
  await page.getByRole('button', { name: 'Upload avatar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Version 3', exact: true })).toBeVisible();
  await stale.getByRole('button', { name: 'Remove avatar', exact: true }).click();
  await expect(stale.getByRole('alert')).toContainText('changed while you were editing');
  await stale.close();
  const peer = await browser.newContext({ baseURL: origin });
  await peer.request.post(`${api}/__bot/viewer`);
  expect((await peer.request.get(`${origin}${firstSource}`)).status()).toBe(403);
  await request.post(`${api}/__bot/state`, { data: { discoverable: true } });
  const peerPage = await peer.newPage();
  await peerPage.goto(path);
  await expect(
    peerPage.getByRole('img', { name: 'Default avatar for Avatar helper' }),
  ).toBeVisible();
  await expect(peerPage.getByLabel('Avatar image', { exact: true })).toHaveCount(0);
  await peer.close();
  await page.getByRole('button', { name: 'Remove avatar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Version 4', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Default avatar for Avatar helper' })).toBeVisible();
  expect((await page.request.get(`${origin}${firstSource}`)).status()).toBe(200);
  expect(errors).toEqual([]);
});
