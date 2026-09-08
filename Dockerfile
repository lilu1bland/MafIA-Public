FROM denoland/deno:alpine-2.1.4

WORKDIR /app

COPY deno.json ./
COPY main.ts ./
COPY src/ ./src/
COPY public/ ./public/

RUN deno cache --unstable-kv main.ts

ENV PORT=8000
ENV KV_PATH=/data/kv.sqlite3

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-env", "--allow-write", "--unstable-kv", "main.ts"]
