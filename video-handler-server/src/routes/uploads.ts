import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { promisify } from "node:util";
import { CONFIG } from "../config";
import FileStorageService from "../services/file-storage.service";

const router = Router();
const execFileAsync = promisify(execFile);
const storage = new FileStorageService();
const temporaryUploadDirectory = path.join(os.tmpdir(), "video-handler-uploads");
mkdirSync(temporaryUploadDirectory, { recursive: true });
const uploadStorage = multer.diskStorage({
	destination: temporaryUploadDirectory,
	filename: (_request, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname)}`),
});
const videoUpload = multer({ storage: uploadStorage });
const assetUpload = multer({ storage: uploadStorage });
const prefixes = {
	videos: CONFIG.upload.uploadVideosFolder,
	assets: CONFIG.upload.assetsFolder,
	merged: CONFIG.upload.mergedVideosFolder,
};
const videoExtensions = new Set([".avi", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm"]);

async function getVideoDuration(objectPath: string): Promise<number | undefined> {
	const temporaryDirectory = await mkdtemp(path.join(process.env.TMPDIR || "/tmp", "video-handler-"));
	try {
		const filePath = await storage.downloadToFile(objectPath, temporaryDirectory);
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
	} finally {
		await storage.cleanup(temporaryDirectory);
	}
}

router.get("/list-files/:type", async (request, response) => {
	const prefix = prefixes[request.params.type as keyof typeof prefixes];

	if (!prefix) {
		response.status(400).json({ error: "type must be videos, assets, or merged" });
		return;
	}

	const entries = await storage.list(prefix);
	const files = await Promise.all(entries.map(async (entry) => {
			// const duration = videoExtensions.has(path.extname(entry.name).toLowerCase())
			// 	? await getVideoDuration(entry.path)
			// 	: undefined;
			const duration = undefined;

			return {
				...entry,
				...(duration !== undefined ? { duration } : {}),
			};
	}));

	files.sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
	response.json(files);
});

router.delete("/file/:type/:fileName", async (request, response) => {
	const prefix = prefixes[request.params.type as keyof typeof prefixes];
	const { fileName } = request.params;

	if (!prefix) {
		response.status(400).json({ error: "type must be videos, assets, or merged" });
		return;
	}
	if (!fileName || path.basename(fileName) !== fileName) {
		response.status(400).json({ error: "fileName must be a file name" });
		return;
	}

	try {
		await storage.remove(path.posix.join(prefix, fileName));
		response.status(204).end();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		response.status(code === "ENOENT" ? 404 : 500).json({ error: code === "ENOENT" ? "File not found" : "Unable to delete file" });
	}
});

router.post("/upload-video", videoUpload.single("file"), async (request, response) => {
	if (!request.file) {
		response.status(400).json({ error: "A video file is required in the 'file' field" });
		return;
	}

	const fileName = `${randomUUID()}${path.extname(request.file.originalname)}`;
	try {
		await storage.uploadFile(path.posix.join(CONFIG.upload.uploadVideosFolder, fileName), request.file.path, request.file.mimetype);
		response.status(201).json({ ...request.file, filename: fileName });
	} finally {
		await rm(request.file.path, { force: true });
	}
});

router.post("/upload-asset", assetUpload.single("file"), async (request, response) => {
	if (!request.file) {
		response.status(400).json({ error: "An asset file is required in the 'file' field" });
		return;
	}

	const fileName = path.basename(request.file.originalname);
	try {
		await storage.uploadFile(path.posix.join(CONFIG.upload.assetsFolder, fileName), request.file.path, request.file.mimetype);
		response.status(201).json({ ...request.file, filename: fileName });
	} finally {
		await rm(request.file.path, { force: true });
	}
});

export default router;
