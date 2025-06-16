FROM node:18-slim

# Install system dependencies including Java
RUN apt-get update && apt-get install -y \
    curl \
    openjdk-11-jdk \
    && rm -rf /var/lib/apt/lists/*

# Set JAVA_HOME environment variable
ENV JAVA_HOME=/usr/lib/jvm/java-11-openjdk-amd64
ENV PATH=$PATH:$JAVA_HOME/bin

# Install Salesforce CLI and Code Analyzer v5
RUN npm install -g @salesforce/cli && \
    sf plugins install @salesforce/code-analyzer

# Verify installations
RUN java -version && \
    sf code-analyzer --help

# Set working directory
WORKDIR /app

# Copy package files first (for better Docker layer caching)
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy application code
COPY index.js .

# Create temp directory for PMD files
RUN mkdir -p /tmp

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Start the application
CMD ["node", "index.js"]