FROM node:22-slim AS world-dependencies
WORKDIR /dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev
COPY app ./app
COPY web ./web
COPY scripts ./scripts
COPY --from=world-dependencies /dependencies/node_modules ./node_modules
ENV PATH="/app/.venv/bin:$PATH" IN_DIR=/data/in OUT_DIR=/data/out WORLD_DIR=/data/worlds
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
