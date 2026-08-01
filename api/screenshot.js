import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import middleware from './_common/middleware.js';
import { createLogger } from './_common/logger.js';

const log = createLogger('screenshot');

// Hard cap on a single Chromium render, so a hung page can never hold an
// orphaned process (and its memory) forever. See PENUMBRA_PATCHES.md.
const CHROMIUM_RENDER_TIMEOUT_MS = parseInt(process.env.CHROMIUM_RENDER_TIMEOUT_MS || '30000', 10);

// Bounds how many screenshot renders run at once, so a burst of concurrent
// requests can't stack up unbounded Chromium/puppeteer processes and OOM
// the service. See PENUMBRA_PATCHES.md.
const SCREENSHOT_MAX_CONCURRENCY = parseInt(process.env.SCREENSHOT_MAX_CONCURRENCY || '3', 10);
const SCREENSHOT_QUEUE_TIMEOUT_MS = parseInt(process.env.SCREENSHOT_QUEUE_TIMEOUT_MS || '5000', 10);

// Minimal in-module semaphore: bounds concurrent renders, briefly queueing
// excess requests before giving up so the caller can retry (429).
let activeRenders = 0;
const renderQueue = [];
const acquireRenderSlot = () => {
  if (activeRenders < SCREENSHOT_MAX_CONCURRENCY) {
    activeRenders += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      grant: () => {
        clearTimeout(timer);
        activeRenders += 1;
        resolve();
      },
    };
    const timer = setTimeout(() => {
      const idx = renderQueue.indexOf(waiter);
      if (idx !== -1) renderQueue.splice(idx, 1);
      reject(new Error('Too many concurrent screenshot renders'));
    }, SCREENSHOT_QUEUE_TIMEOUT_MS);
    renderQueue.push(waiter);
  });
};
const releaseRenderSlot = () => {
  activeRenders -= 1;
  const next = renderQueue.shift();
  if (next) next.grant();
};

// Screenshot via the system Chromium binary
const directChromiumScreenshot = async (url, signal) => {
  const tmpDir = '/tmp';
  const screenshotPath = path.join(tmpDir, `screenshot-${randomUUID()}.png`);
  log.debug(`direct method, saving to ${screenshotPath}`);

  const cleanup = () =>
    fs.unlink(screenshotPath).catch((err) => {
      if (err.code !== 'ENOENT') log.warn(`temp cleanup failed: ${err.message}`);
    });

  return new Promise((resolve, reject) => {
    const chromePath = process.env.CHROME_PATH || '/usr/bin/chromium';
    const args = [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      `--screenshot=${screenshotPath}`,
      url,
    ];
    const child = execFile(
      chromePath,
      args,
      { timeout: CHROMIUM_RENDER_TIMEOUT_MS, killSignal: 'SIGKILL' },
      async (error) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (error) {
          await cleanup();
          return reject(error);
        }
        try {
          const buf = await fs.readFile(screenshotPath);
          await cleanup();
          resolve(buf.toString('base64'));
        } catch (readError) {
          reject(readError);
        }
      },
    );
    const onAbort = () => child.kill('SIGKILL');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
};

// Lazily-initialized, shared puppeteer browser instance used by the
// fallback path. Launching a browser per request was a major contributor
// to OOM-wedges under concurrent load; each request instead gets its own
// incognito context on top of one long-lived browser process. Relaunches
// automatically if the shared browser disconnects/crashes.
let sharedBrowserPromise = null;
const launchSharedBrowser = async () => {
  const browser = await puppeteer.launch({
    args: [...chromium.args, '--no-sandbox'],
    defaultViewport: { width: 800, height: 600 },
    executablePath: process.env.CHROME_PATH || (await chromium.executablePath()),
    headless: true,
    acceptInsecureCerts: true,
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  browser.once('disconnected', () => {
    sharedBrowserPromise = null;
  });
  return browser;
};
const getSharedBrowser = () => {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = launchSharedBrowser().catch((error) => {
      sharedBrowserPromise = null;
      throw error;
    });
  }
  return sharedBrowserPromise;
};

// Fallback to puppeteer when the direct Chromium binary call fails
const puppeteerScreenshot = async (targetUrl, signal) => {
  const browser = await getSharedBrowser();
  const context = await browser.createBrowserContext();
  const onAbort = () => context.close().catch(() => {});
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const page = await context.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    page.setDefaultNavigationTimeout(8000);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      if (!document.querySelector('body')) {
        throw new Error('No body element found on the page');
      }
    });
    const buffer = await page.screenshot();
    return buffer.toString('base64');
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    await context.close().catch(() => {});
  }
};

const screenshotHandler = async (targetUrl, _request, signal) => {
  if (!targetUrl) throw new Error('URL is missing from queryStringParameters');
  try {
    new URL(targetUrl);
  } catch {
    throw new Error('URL provided is invalid');
  }

  log.debug(`request received: ${targetUrl}`);

  try {
    await acquireRenderSlot();
  } catch {
    const busyError = new Error(
      `Too many concurrent screenshot renders (max ${SCREENSHOT_MAX_CONCURRENCY}); please retry shortly.`,
    );
    busyError.statusCode = 429;
    busyError.retryAfter = Math.ceil(SCREENSHOT_QUEUE_TIMEOUT_MS / 1000);
    throw busyError;
  }

  try {
    try {
      return { image: await directChromiumScreenshot(targetUrl, signal) };
    } catch (directError) {
      log.warn(`direct chromium failed, falling back to puppeteer: ${directError.message}`);
    }
    try {
      return { image: await puppeteerScreenshot(targetUrl, signal) };
    } catch (error) {
      if (/ENOENT|Browser was not found|Could not find Chromium/i.test(error.message)) {
        return { skipped: error.message };
      }
      log.error(`puppeteer screenshot failed: ${error.message}`);
      throw error;
    }
  } finally {
    releaseRenderSlot();
  }
};

export const handler = middleware(screenshotHandler);
export default handler;
