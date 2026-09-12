FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev
COPY app ./app
COPY web ./web
COPY scripts ./scripts
ENV PATH="/app/.venv/bin:$PATH" IN_DIR=/data/in OUT_DIR=/data/out
RUN python scripts/generate_audio.py
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
