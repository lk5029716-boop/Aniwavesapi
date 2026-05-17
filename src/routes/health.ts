import { Router, type IRouter } from "express";
import { execSync } from "child_process";

const router: IRouter = Router();

router.get("/health", (_req, res) => {
  let curlAvailable = false;
  let nodeVersion = process.version;
  try {
    execSync("which curl", { encoding: "utf8", timeout: 5000 });
    curlAvailable = true;
  } catch {
    curlAvailable = false;
  }

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    curl: curlAvailable,
    node: nodeVersion,
    env: process.env.NODE_ENV || "development",
  });
});

export default router;
