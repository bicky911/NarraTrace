import { test as base, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const FAKE_ENGINE_PATH = path.join(HERE, 'fixtures', 'fake-tts-engine');

async function findExtensionWorker(context, expectedName) {
  const deadline = Date.now() + 20000;

  while (Date.now() < deadline) {
    for (const worker of context.serviceWorkers()) {
      try {
        const name = await worker.evaluate(() => chrome.runtime.getManifest().name);
        if (name === expectedName) return worker;
      } catch {
        // A service worker may be restarting while the test fixture attaches.
      }
    }

    await Promise.race([
      context.waitForEvent('serviceworker', { timeout: 1000 }).catch(() => null),
      new Promise(resolve => setTimeout(resolve, 100))
    ]);
  }

  throw new Error(`Timed out waiting for extension service worker: ${expectedName}`);
}

export const test = base.extend({
  extensionContext: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narratrace-e2e-'));
    const extensionPaths = [REPO_ROOT, FAKE_ENGINE_PATH];
    const joinedPaths = extensionPaths.join(',');

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1365, height: 900 },
      args: [
        `--disable-extensions-except=${joinedPaths}`,
        `--load-extension=${joinedPaths}`,
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    try {
      await use(context);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  },

  extensionWorkers: async ({ extensionContext }, use) => {
    const [narratrace, fakeTtsEngine] = await Promise.all([
      findExtensionWorker(extensionContext, 'NarraTrace — Narrates & Traces Every Word'),
      findExtensionWorker(extensionContext, 'NarraTrace Browser Test TTS Engine')
    ]);

    await use({
      narratrace,
      fakeTtsEngine,
      narratraceId: new URL(narratrace.url()).hostname,
      fakeTtsEngineId: new URL(fakeTtsEngine.url()).hostname
    });
  },

  articlePage: async ({ extensionContext }, use) => {
    const page = extensionContext.pages()[0] || await extensionContext.newPage();
    await page.goto('http://127.0.0.1:4173/article');
    await page.locator('#read-aloud-player-host').waitFor({ state: 'attached', timeout: 15000 });
    await use(page);
  }
});

export { findExtensionWorker };
