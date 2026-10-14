# Use Node.js 20 on Debian Bullseye Slim as base image
FROM node:20-bullseye-slim

# Set working directory
WORKDIR /app

# Install Python, virtual-environment support, and OpenCV system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Create an isolated Python environment and install its dependencies
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHON_EXEC=/opt/venv/bin/python

# Copy Node dependency definitions
COPY package.json package-lock.json* ./

# Install Node modules
RUN npm ci || npm install

# Copy Python dependency definitions
COPY requirements.txt ./

# Install Python modules into the virtual environment
RUN /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code
COPY . .

# Set PORT environment variable to 8080 (Google Cloud Run default)
ENV PORT=8080
EXPOSE 8080

# Command to run the application
CMD ["npm", "start"]
