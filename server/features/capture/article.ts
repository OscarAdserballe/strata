import { fetchArticle, articleToMarkdown, captureFilename, fetchYouTubeTranscript, videoToMarkdown } from "./capture.ts";
import { deps } from "../../platform/config.ts";
import { cleanImportedMarkdown } from "../sources/markdown-clean.ts";
import { prepareSource, type PreparedSource } from "../sources/ingest.ts";

export interface PreparedCapture { prepared: PreparedSource; title: string; filename: string }

/** Fetches and cleans an article; the caller writes it with writeSource inside its commit. */
export async function prepareArticle(url: string): Promise<PreparedCapture> {
  const article = await fetchArticle(url);
  article.text = await cleanImportedMarkdown(
    article.text,
    deps.geminiAvailable ? deps.callGeminiJson : undefined,
    (e) => console.error("[markdown-clean]", e),
  );
  const filename = captureFilename(article.title);
  const prepared = await prepareSource({ filename, kind: "text", text: articleToMarkdown(article, url), originUrl: url });
  return { prepared, title: article.title, filename };
}

/** Fetches a YouTube video's transcript as the same transcript source pasted captions make; throws NoTranscript. */
export async function prepareVideo(url: string): Promise<PreparedCapture> {
  const video = await fetchYouTubeTranscript(url);
  const filename = captureFilename(video.title);
  const prepared = await prepareSource({ filename, kind: "transcript", text: videoToMarkdown(video, url), originUrl: url });
  return { prepared, title: video.title, filename };
}
