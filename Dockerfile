FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip curl ffmpeg && \
    pip3 install --break-system-packages --upgrade yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
