FROM node:22-slim

WORKDIR /app

# 先複製依賴定義檔
COPY package*.json ./

# 安裝相依套件 (Production only，Debian glibc 滿足 Google Cloud Run gVisor 核心要求)
RUN npm ci --omit=dev

# 複製專案程式碼 (透過 .dockerignore 排除 node_modules 與非必要檔案)
COPY . .

ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]
