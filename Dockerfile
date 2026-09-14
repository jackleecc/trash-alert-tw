FROM node:20-alpine
WORKDIR /app
COPY proxy/standalone/package*.json ./
COPY proxy/standalone/server.js ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
