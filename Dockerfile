# Use Node.js 20 on Debian Bullseye Slim as base image
FROM node:22-bookworm-slim

# Set working directory
WORKDIR /app

# Install Python and OpenCV system dependencies
# libgl1-mesa-glx and libglib2.0-0 are required by opencv-python
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Set environment variable so the Node app can find the Python executable
ENV PYTHON_EXEC=python3

# Copy Node dependency definitions
COPY package.json package-lock.json* ./

# Install Node modules
# Using npm ci for deterministic builds if package-lock.json exists, falling back to npm install
RUN npm ci || npm install

# Copy Python dependency definitions
COPY requirements.txt ./

# Install Python modules
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv && python3 -m venv /opt/depthforge-venv && /opt/depthforge-venv/bin/pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . .

# Set PORT environment variable to 8080 (Google Cloud Run default)
ENV PORT=8080
EXPOSE 8080

# Command to run the application
CMD ["npm", "start"]
ENV PATH="/opt/depthforge-venv/bin:$PATH"
