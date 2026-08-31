import { Router } from "express";
import FfmpegService from "../services/ffmpeg.service";
import { MergeVideosRequest } from "../models/request-response/MergeVideosRequest";
import { MergeVideoOutput } from "../models/request-response/MergeVideoOutput";
import { VideoImageOverlay } from "../models/VideoImageOverlay";

const router = Router();
const ffmpegService = new FfmpegService();

router.post("/merge", async (request, response) => {
	const { videoPaths, images, outputs } = request.body as MergeVideosRequest;
	const streamProgress = request.query.progress === "true";

	if (!Array.isArray(videoPaths) || videoPaths.some((videoPath) => typeof videoPath !== "string")) {
		response.status(400).json({ error: "videoPaths must be an array of file paths" });
		return;
	}

	const requestedOutputs = parseOutputs(outputs);
	const requestedImages = parseImages(images);
	if (!requestedOutputs || !requestedImages) {
		response.status(400).json({ error: "outputs must be a non-empty array and images must be an array of overlay settings" });
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

		const onProgress = streamProgress
			? (progress: number) => response.write(`${JSON.stringify({ type: "progress", progress })}\n`)
			: undefined;
		const mergedVideos = await ffmpegService.mergeVideosToOutputs(videoPaths, requestedOutputs, requestedImages, onProgress);

		if (streamProgress) {
			response.end(`${JSON.stringify({ type: "complete", ...mergedVideos })}\n`);
			return;
		}

		response.status(201).json(mergedVideos);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unable to merge videos";

		if (streamProgress) {
			response.end(`${JSON.stringify({ type: "error", error: message })}\n`);
			return;
		}

		response.status(400).json({ error: message });
	}
});

function parseOutputs(outputs: unknown): MergeVideoOutput[] | undefined {
	if (!Array.isArray(outputs) || outputs.length === 0) {
		return undefined;
	}

	if (outputs.some((output) => typeof output !== "object" || output === null || Array.isArray(output)
		|| ("outputPath" in output && typeof output.outputPath !== "string")
		|| !("options" in output) || typeof output.options !== "object" || output.options === null || Array.isArray(output.options))) {
		return undefined;
	}

	return outputs as MergeVideoOutput[];
}

function parseImages(images: unknown): VideoImageOverlay[] | undefined {
	if (images === undefined) return [];
	if (!Array.isArray(images) || images.some((image) => typeof image !== "object" || image === null || Array.isArray(image)
		|| typeof image.imagePath !== "string" || typeof image.startTime !== "number" || typeof image.duration !== "number")) {
		return undefined;
	}
	return images as VideoImageOverlay[];
}

export default router;
