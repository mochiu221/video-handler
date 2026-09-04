# Video Handler

Video Handler 是一個 Docker Compose 應用程式，可用來上傳影片與素材、組合片頭／主影片／片尾、套用圖片疊加效果，並匯出合併後的影片。

## 系統需求

- 若要使用 2 個 `video-handler-worker`，且使用 `cpuset: "2-3"`，請更新 `.wslconfig`，最少設定 `memory=6GB` 與 `processors=4`。

每個 `video-handler-worker` 容器都會自動安裝 FFmpeg。Docker 建置過程也會安裝 Node.js 與 npm，因此使用 Docker 設定時，主機不需要另外安裝它們。

## 啟動應用程式

```bash
docker compose up -d --build
```

合併影片時，可監控容器資源使用狀況，確認 Worker 是否有使用所有配置CPU的資源：

```bash
docker stats
```

伺服器健康檢查通過後，可開啟以下網址：

- 應用程式：http://localhost:4200
- API 健康檢查：http://localhost:3000/api/health
- RabbitMQ 管理介面：http://localhost:15672
- MinIO 主控台：http://localhost:9001
- Redis：localhost:6379
- RabbitMQ AMQP：localhost:5672

`docker-compose.yml` 中設定的開發環境帳號密碼如下：

- RabbitMQ：`video-handler` / `video-handler-dev`
- MinIO：`video-handler` / `video-handler-dev`

這些帳號密碼僅供本機開發使用。若要在非本機環境使用此服務組合，請先修改帳號密碼。

## 專案結構

- `video-handler-client/`：由 Nginx 提供服務的 Angular 前端
- `video-handler-server/`：Express API，以及上傳與工作管理功能
- `video-handler-worker/`：執行 FFmpeg 合併工作的 RabbitMQ Worker
- `docker-compose.yml`：本機應用程式與基礎設施服務組合設定
