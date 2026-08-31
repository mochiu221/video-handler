import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { promisify } from "node:util";
import { CONFIG } from "../config";

const router = Router();
const execFileAsync = promisify(execFile);
const uploadDirectory = path.resolve(process.env.UPLOAD_DIR || "uploads");
const videosDirectory = path.join(uploadDirectory, CONFIG.upload.uploadVideosFolder);
const assetsDirectory = path.join(uploadDirectory, CONFIG.upload.assetsFolder);
const mergedVideosDirectory = path.join(uploadDirectory, CONFIG.upload.mergedVideosFolder);

mkdirSync(videosDirectory, { recursive: true });
mkdirSync(assetsDirectory, { recursive: true });
mkdirSync(mergedVideosDirectory, { recursive: true });

function createUpload(destination: string) {
  return multer({
	storage: multer.diskStorage({
		destination,
		filename: (_request, file, callback) => {
			callback(null, `${randomUUID()}${path.extname(file.originalname)}`);
		},
	}),
  });
}

const videoUpload = createUpload(videosDirectory);
const assetUpload = createUpload(assetsDirectory);

const directories = {
	videos: videosDirectory,
	assets: assetsDirectory,
	merged: mergedVideosDirectory,
};
const videoExtensions = new Set([".avi", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm"]);

async function getVideoDuration(filePath: string): Promise<number | undefined> {
	try {
		const { stdout } = await execFileAsync(process.env.FFPROBE_PATH || "ffprobe", [
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"default=noprint_wrappers=1:nokey=1",
			filePath,
		]);
		const duration = Number.parseFloat(stdout);

		return Number.isFinite(duration) ? Number(duration.toFixed(3)) : undefined;
	} catch {
		return undefined;
	}
}

router.get("/list-files/:type", async (request, response) => {
	const directory = directories[request.params.type as keyof typeof directories];

	if (!directory) {
		response.status(400).json({ error: "type must be videos, assets, or merged" });
		return;
	}

	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(entries
		.filter((entry) => entry.isFile())
		.map(async (entry) => {
			const filePath = path.join(directory, entry.name);
			const stats = await stat(filePath);
			const duration = videoExtensions.has(path.extname(entry.name).toLowerCase())
				? await getVideoDuration(filePath)
				: undefined;

			return {
				name: entry.name,
				path: path.relative(uploadDirectory, filePath),
				size: stats.size,
				updatedAt: stats.mtime.toISOString(),
				...(duration !== undefined ? { duration } : {}),
			};
		}));

	response.json(files);
});

router.post("/upload-video", videoUpload.single("file"), (request, response) => {
	if (!request.file) {
		response.status(400).json({ error: "A video file is required in the 'file' field" });
		return;
	}

	response.status(201).json(request.file);
});

router.post("/upload-asset", assetUpload.single("file"), (request, response) => {
	if (!request.file) {
		response.status(400).json({ error: "An asset file is required in the 'file' field" });
		return;
	}

	response.status(201).json(request.file);
});

export default router;
