import { Router, type IRouter } from "express";
import { execSync } from "child_process";

const router: IRouter = Router();

router.get("/health", (_req, res) => {
  let curlAvailable = false;
  let chromiumPath: string | null = null;
  let playwrightAvailable = false;

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

  // Check if playwright package is available
  try {
    require.resolve("playwright");
    playwrightAvailable = true;
  } catch {
    playwrightAvailable = false;
  }

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    curl: curlAvailable,
    node: process.version,
    env: process.env.NODE_ENV || "development",
    chromium: chromiumPath || "not found",
    playwright: playwrightAvailable,
    playwrightChromiumEnv: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "not set",
  });
});

export default router;
