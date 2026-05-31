import { Router, type IRouter } from "express";
import { execSync } from "child_process";

const router: IRouter = Router();

router.get("/health", async (_req, res) => {
  let curlAvailable = false;
  let chromiumPath: string | null = null;
  let playwrightVersion: string | null = null;
  let chromiumLaunchTest: string | null = null;

  try {
    execSync("which curl", { encoding: "utf8", timeout: 5000 });
    curlAvailable = true;
  } catch {
    curlAvailable = false;
  }

  // Check for Chromium in Playwright Docker image
  try {
    chromiumPath = execSync(
      "find /ms-playwright -name chrome -type f 2>/dev/null | head -1",
      { encoding: "utf8", timeout: 5000 }
    ).trim();
  } catch {
    chromiumPath = null;
  }

  // Check playwright version
  try {
    const pw = await import("playwright");
    playwrightVersion = pw?.chromium ? "available" : "unknown";
  } catch {
    playwrightVersion = "not available";
  }

  // Test chromium launch (quick test)
  if (chromiumPath) {
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      await browser.close();
      chromiumLaunchTest = "success";
    } catch (e) {
      chromiumLaunchTest = `failed: ${(e as Error).message.slice(0, 100)}`;
    }
  }

  // Check curl_cffi (Python)
  let curlCffiAvailable = false;
  try {
    execSync("python3 -c 'from curl_cffi import requests; print(\"ok\")'", { encoding: "utf8", timeout: 5000 });
    curlCffiAvailable = true;
  } catch {
    curlCffiAvailable = false;
  }

  const scraperPath = process.env["ANIWAVES_SCRAPER_PATH"] || "";

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    curl: curlAvailable,
    curlCffi: curlCffiAvailable,
    scraperPath: scraperPath || "(not set)",
    node: process.version,
    env: process.env.NODE_ENV || "development",
    chromium: chromiumPath || "not found",
    playwright: playwrightVersion,
    chromiumLaunchTest,
  });
});

export default router;
