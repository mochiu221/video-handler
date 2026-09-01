import express from "express";
import path from "node:path";
import uploadsRouter from "./routes/uploads";
import videoRouter from "./routes/video";
import FileStorageService from "./services/file-storage.service";

const app = express();
const port = Number(process.env.PORT) || 3000;
const storage = new FileStorageService();

app.use(express.json());

app.get(/^\/api\/uploads\/file\/(.+)$/, async (request, response) => {
  try {
    const objectPath = decodeURIComponent(request.params[0]);
    const stream = await storage.getObject(objectPath);
    response.type(path.extname(objectPath));
    stream.pipe(response);
  } catch {
    response.status(404).json({ error: "File not found" });
  }
});
app.use("/api/uploads", uploadsRouter);
app.use("/api/video", videoRouter);

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.use((_request, response) => {
  response.status(404).json({ error: "Not found" });
});

app.listen(port, () => {
  console.log(`Video handler API listening on port ${port}`);
});