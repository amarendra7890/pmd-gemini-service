# Use a base image that has both Node.js and Java
FROM eclipse-temurin:17-jdk

# Install Node.js 20 (required for Code Analyzer v5)
RUN apt-get update && apt-get install -y \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Verify installations
RUN node --version && npm --version && java -version

# Install Salesforce CLI and both scanners
RUN npm install -g @salesforce/cli && \
    sf plugins install @salesforce/sfdx-scanner && \
    sf plugins install code-analyzer

# Verify both installations
RUN sf scanner --help && sf code-analyzer --help

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