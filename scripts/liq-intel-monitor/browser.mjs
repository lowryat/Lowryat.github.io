import { pathToFileURL } from "node:url";

/** One short visit; no screenshots, traces, cookies, error text, or private DOM is saved. */
export async function probeBrowser(environment, { modulePath = process.env.PLAYWRIGHT_MODULE_PATH, chromium } = {}) {
  let browser;
  let context;
  try {
    chromium ||= (await import(pathToFileURL(modulePath).href)).chromium;
    browser = await chromium.launch({ timeout: 10_000 });
    context = await browser.newContext({ serviceWorkers: "block" });
  } catch {
    if (browser) await browser.close().catch(() => {});
    return ["browser-unavailable"];
  }

  const failures = new Set();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    page.on("pageerror", () => failures.add("browser-runtime-error"));
    await page.route("**/*", async (route) => {
      try {
        const request = route.request();
        const sameOrigin = new URL(request.url()).origin === new URL(environment.url).origin;
        const headers = { ...request.headers() };
        // Never forward the private-app credential to third-party assets or redirects.
        if (sameOrigin && environment.token) {
          await route.continue({ headers: { ...headers, authorization: `Bearer ${environment.token}` } });
        } else {
          if (environment.token && headers.authorization === `Bearer ${environment.token}`) delete headers.authorization;
          await route.continue({ headers });
        }
      } catch {
        failures.add("page-unavailable");
        await route.abort().catch(() => {});
      }
    });
    const response = await page.goto(environment.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const status = response?.status();
    if (!status || status >= 400) {
      failures.add(status === 429 ? "rate-limited" : status === 401 || status === 403 ? "access-denied" : "page-http-error");
    } else {
      // Fixed short observation, not networkidle (polling must not prolong the visit).
      await page.waitForTimeout(4_000);
      const text = await page.locator("body").innerText();
      if (!/market posture/i.test(text)) failures.add("app-content-missing");
      if (await page.locator("vite-error-overlay").count() ||
          /\[plugin:runtime-error-plugin\]|\(unknown runtime error\)/i.test(text)) {
        failures.add("browser-runtime-error");
      }
    }
  } catch (error) {
    failures.add(error?.name === "TimeoutError" ? "page-timeout" : "page-unavailable");
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  return [...failures];
}
