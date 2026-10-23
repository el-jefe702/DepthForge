FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHON_EXEC=python3

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Pre-cache Depth Anything V2 Small ONNX model (~27MB)
RUN mkdir -p /app/data/models && \
    python3 -c "import urllib.request; urllib.request.urlretrieve('https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx', '/app/data/models/depth_anything_v2_vits_quantized.onnx')" || true

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
