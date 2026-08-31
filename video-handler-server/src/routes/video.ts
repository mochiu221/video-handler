import { Router } from "express";
import path from "node:path";
import { CONFIG } from "../config";
import FfmpegService from "../services/ffmpeg.service";
import { MergeVideosRequest } from "../models/request-response/MergeVideosRequest";
import { MergeVideoCompositionRequest } from "../models/request-response/MergeVideoCompositionRequest";
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

router.post("/merge-composition", async (request, response) => {
	const { opening, main, ending, outputs } = request.body as MergeVideoCompositionRequest;
	const openingSection = parseAssetSection(opening);
	const mainSection = parseMainSection(main);
	const endingSection = parseAssetSection(ending);
	const requestedOutputs = parseCompositionOutputs(outputs, mainSection?.videoFileName);
	const streamProgress = request.query.progress === "true";

	if (!openingSection || !mainSection || !endingSection || !requestedOutputs) {
		response.status(400).json({ error: "main requires videoFileName; opening and ending require videoFileNames when provided; outputs require a unique suffix and options" });
		return;
	}

	try {
		if (streamProgress) {
			response.status(200).type("application/x-ndjson").set("Cache-Control", "no-cache").set("X-Accel-Buffering", "no");
			response.flushHeaders();
			response.write(`${JSON.stringify({ type: "started", progress: 0 })}\n`);
		}

		const result = await ffmpegService.mergeVideoComposition(
			openingSection.videoPaths,
			openingSection.images,
			mainSection.videoPath,
			mainSection.images,
			endingSection.videoPaths,
			endingSection.images,
			requestedOutputs,
			streamProgress ? (progress) => response.write(`${JSON.stringify({ type: "progress", progress })}\n`) : undefined,
		);

		if (streamProgress) {
			response.end(`${JSON.stringify({ type: "complete", ...result })}\n`);
			return;
		}
		response.status(201).json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unable to merge video composition";
		if (streamProgress) {
			response.end(`${JSON.stringify({ type: "error", error: message })}\n`);
			return;
		}
		response.status(400).json({ error: message });
	}
});

type AssetSection = { videoPaths: string[]; images: string[] };
type MainImage = { imagePath: string; startTime: number; duration?: number };
type MainSection = { videoFileName: string; videoPath: string; images: MainImage[] };

function parseAssetSection(section: unknown): AssetSection | undefined {
	if (section === undefined) return { videoPaths: [], images: [] };
	if (typeof section !== "object" || section === null || Array.isArray(section)) return undefined;
	const { videoFileNames, images } = section as { videoFileNames?: unknown; images?: unknown };
	const parsedImages = parseSectionImageFileNames(images);
	if (!Array.isArray(videoFileNames) || videoFileNames.length === 0 || !parsedImages) {
		return undefined;
	}
	const videoPaths = videoFileNames.map((fileName) => compositionFilePath(CONFIG.upload.assetsFolder, fileName));
	if (videoPaths.some((videoPath) => videoPath === undefined)) return undefined;
	return { videoPaths: videoPaths as string[], images: parsedImages };
}

function parseMainSection(section: unknown): MainSection | undefined {
	if (typeof section !== "object" || section === null || Array.isArray(section)) return undefined;
	const { videoFileName, images } = section as { videoFileName?: unknown; images?: unknown };
	const parsedImages = parseMainCompositionImages(images);
	const videoPath = compositionFilePath(CONFIG.upload.uploadVideosFolder, videoFileName);
	if (!videoPath || typeof videoFileName !== "string" || !parsedImages) return undefined;
	return { videoFileName, videoPath, images: parsedImages };
}

function parseCompositionOutputs(outputs: unknown, mainVideoFileName: string | undefined): MergeVideoOutput[] | undefined {
	if (!Array.isArray(outputs) || outputs.length === 0 || !mainVideoFileName) return undefined;
	const baseName = path.parse(mainVideoFileName).name;
	const parsedOutputs = outputs.map((output) => {
		if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
		const { suffix, options } = output as { suffix?: unknown; options?: unknown };
		if (typeof suffix !== "string" || !suffix || path.basename(suffix) !== suffix
			|| !/^[A-Za-z0-9_-]+$/.test(suffix) || typeof options !== "object" || options === null || Array.isArray(options)) {
			return undefined;
		}
		return {
			outputPath: path.posix.join(CONFIG.upload.mergedVideosFolder, `${baseName}${suffix}.mp4`),
			options: options as MergeVideoOutput["options"],
		};
	});
	if (parsedOutputs.some((output) => output === undefined)) return undefined;
	const resolvedOutputs = parsedOutputs as MergeVideoOutput[];
	return new Set(resolvedOutputs.map((output) => output.outputPath)).size === resolvedOutputs.length
		? resolvedOutputs
		: undefined;
}

function parseSectionImageFileNames(images: unknown): string[] | undefined {
	if (images === undefined) return [];
	if (!Array.isArray(images)) return undefined;
	const parsedImages = images.map((image) => typeof image === "object" && image !== null && !Array.isArray(image)
		? compositionFilePath(CONFIG.upload.assetsFolder, (image as { imageFileName?: unknown }).imageFileName)
		: undefined);
	return parsedImages.some((image) => image === undefined) ? undefined : parsedImages as string[];
}

function parseMainCompositionImages(images: unknown): MainImage[] | undefined {
	if (images === undefined) return [];
	if (!Array.isArray(images)) return undefined;
	const parsedImages = images.map((image) => {
		if (typeof image !== "object" || image === null || Array.isArray(image)) return undefined;
		const { imageFileName, startTime, duration } = image as { imageFileName?: unknown; startTime?: unknown; duration?: unknown };
		const imagePath = compositionFilePath(CONFIG.upload.assetsFolder, imageFileName);
		return imagePath && typeof startTime === "number" && (duration === undefined || typeof duration === "number")
			? { imagePath, startTime, ...(duration === undefined ? {} : { duration }) }
			: undefined;
	});
	return parsedImages.some((image) => image === undefined) ? undefined : parsedImages as MainImage[];
}

function compositionFilePath(folder: string, fileName: unknown): string | undefined {
	if (typeof fileName !== "string" || !fileName || path.basename(fileName) !== fileName) return undefined;
	return path.posix.join(folder, fileName);
}

export default router;
