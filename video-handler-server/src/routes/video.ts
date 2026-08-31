import { Router } from "express";
import { MergeVideosOptions } from "../models/MergeVideosOptions";
import FfmpegService from "../services/ffmpeg.service";
import { MergeVideosRequest } from "../models/request-response/MergeVideosRequest";

const router = Router();
const ffmpegService = new FfmpegService();

router.post("/merge", async (request, response) => {
	const { videoPaths, outputPath, options } = request.body as MergeVideosRequest;
	const streamProgress = request.query.progress === "true";

	if (!Array.isArray(videoPaths) || videoPaths.some((videoPath) => typeof videoPath !== "string")) {
		response.status(400).json({ error: "videoPaths must be an array of file paths" });
		return;
	}

	if (outputPath !== undefined && typeof outputPath !== "string") {
		response.status(400).json({ error: "outputPath must be a file path" });
		return;
	}

	if (typeof options !== "object" || options === null || Array.isArray(options)) {
		response.status(400).json({ error: "options with width and height is required" });
		return;
	}

	try {
		if (streamProgress) {
			response.status(200)
				.type("application/x-ndjson")
				.set("Cache-Control", "no-cache")
				.set("X-Accel-Buffering", "no");
			response.flushHeaders();
			response.write(`${JSON.stringify({ type: "started", progress: 0 })}\n`);
		}

		const mergedVideo = await ffmpegService.mergeVideos(
			videoPaths,
			outputPath,
			options as MergeVideosOptions,
			streamProgress ? (progress) => response.write(`${JSON.stringify({ type: "progress", progress })}\n`) : undefined,
		);

		if (streamProgress) {
			response.end(`${JSON.stringify({ type: "complete", ...mergedVideo })}\n`);
			return;
		}

		response.status(201).json(mergedVideo);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unable to merge videos";

		if (streamProgress) {
			response.end(`${JSON.stringify({ type: "error", error: message })}\n`);
			return;
		}

		response.status(400).json({ error: message });
	}
});

export default router;
