import { logger } from "../../logger.js";
import { extractVidplay, isVidplayHost } from "./vidplay.js";
import { extractMegacloud, isMegacloudHost } from "./megacloud.js";
import { extractEchovideo, isEchovideoHost } from "./echovideo.js";
import { extractWeneverbeenfree, isWeneverbeenfreeHost } from "./weneverbeenfree.js";
import { extractDghg, isPlaymogoHost } from "./dghg.js";
import type { StreamSource } from "../types.js";

export async function extractStream(
  embedUrl: string,
  serverName: string,
  skipData?: { intro?: [number, number]; outro?: [number, number] }
): Promise<StreamSource | null> {
  const lowerName = serverName.toLowerCase();

  logger.info(
    { embedUrl: embedUrl.slice(0, 80), serverName },
    "dispatching to provider extractor"
  );

  // DGHG / myvidplay.com / playmogo.com — pass_md5 HTTP method
  if (
    isPlaymogoHost(embedUrl) ||
    lowerName.includes("dghg") ||
    lowerName.includes("myvidplay")
  ) {
    logger.info({ serverName }, "routing to DGHG/PlayMogo extractor");
    return extractDghg(embedUrl, skipData);
  }

  // weneverbeenfree.com (BYFMS server on Aniwaves)
  if (
    isWeneverbeenfreeHost(embedUrl) ||
    lowerName.includes("byfms") ||
    lowerName.includes("weneverbeenfree")
  ) {
    logger.info({ serverName }, "routing to WeneverBeenFree extractor");
    return extractWeneverbeenfree(embedUrl, skipData);
  }

  // Echovideo (Aniwaves primary provider — Vidplay server also routes here)
  if (
    isEchovideoHost(embedUrl) ||
    lowerName.includes("echo")
  ) {
    logger.info({ serverName }, "routing to Echovideo extractor");
    return extractEchovideo(embedUrl, skipData);
  }

  // MegaCloud / RapidCloud / RabbitStream
  if (
    isMegacloudHost(embedUrl) ||
    lowerName.includes("megacloud") ||
    lowerName.includes("rapidcloud") ||
    lowerName.includes("rabbitstream") ||
    lowerName.includes("mycloud")
  ) {
    logger.info({ serverName }, "routing to MegaCloud extractor");
    return extractMegacloud(embedUrl);
  }

  // Vidplay and its mirrors (VidCloud)
  if (
    isVidplayHost(embedUrl) ||
    lowerName.includes("vidplay") ||
    lowerName.includes("vidcloud")
  ) {
    logger.info({ serverName }, "routing to Vidplay extractor");
    return extractVidplay(embedUrl);
  }

  // Unknown provider — try all extractors in order
  logger.warn(
    { serverName, embedUrl: embedUrl.slice(0, 80) },
    "unknown provider, trying all extractors in order"
  );

  if (/\/embed-\d+\//.test(embedUrl)) {
    const echoResult = await extractEchovideo(embedUrl, skipData);
    if (echoResult?.m3u8) return echoResult;
  }

  const vidplayResult = await extractVidplay(embedUrl);
  if (vidplayResult?.m3u8) return vidplayResult;

  const megacloudResult = await extractMegacloud(embedUrl);
  if (megacloudResult?.m3u8) return megacloudResult;

  const wnbfResult = await extractWeneverbeenfree(embedUrl, skipData);
  if (wnbfResult?.m3u8) return wnbfResult;

  // Try DGHG as last resort
  const dghgResult = await extractDghg(embedUrl, skipData);
  if (dghgResult?.m3u8) return dghgResult;

  logger.error({ serverName, embedUrl: embedUrl.slice(0, 80) }, "all extractors failed");
  return null;
}
