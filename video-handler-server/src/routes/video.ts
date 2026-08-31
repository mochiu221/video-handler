import { Router } from "express";
import { MergeVideosOptions } from "../models/MergeVideosOptions";
import FfmpegService from "../services/ffmpeg.service";
import { MergeVideosRequest } from "../models/request-response/MergeVideosRequest";

const router = Router();
const ffmpegService = new FfmpegService();

router.post("/merge", async (request, response) => {
	const { videoPaths, outputPath, options } = request.body as MergeVideosRequest;

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
		const mergedVideo = await ffmpegService.mergeVideos(
			videoPaths,
			outputPath,
			options as MergeVideosOptions,
		);
		response.status(201).json(mergedVideo);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unable to merge videos";
		response.status(400).json({ error: message });
	}
});

export default router;
