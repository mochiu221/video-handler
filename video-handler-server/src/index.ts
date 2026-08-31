import express from "express";
import path from "node:path";
import uploadsRouter from "./routes/uploads";
import videoRouter from "./routes/video";

const app = express();
const port = Number(process.env.PORT) || 3000;
const uploadDirectory = path.resolve(process.env.UPLOAD_DIR || "uploads");

app.use(express.json());

app.use("/api/uploads/file", express.static(uploadDirectory));
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