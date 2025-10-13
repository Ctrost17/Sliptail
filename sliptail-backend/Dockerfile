# Use a current LTS. 18 works, but 20-alpine is fine too.
FROM node:20-alpine

# Install ffmpeg (your code needs it) + CA certs for HTTPS (RDS/S3/Stripe/Google)
RUN apk add --no-cache ffmpeg ca-certificates curl \
  && update-ca-certificates

# Workdir
WORKDIR /app

# Copy and install deps in production mode
COPY package*.json ./
ENV NODE_ENV=production
# Use ci for reproducible installs; omit dev deps
RUN npm ci --omit=dev || npm install --production

# Copy app code
COPY . .

# Create uploads folder (still used for any legacy/local writes)
RUN mkdir -p public/uploads

# Expose port
EXPOSE 5000

# (Optional) healthcheck if you have /health
# HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://127.0.0.1:5000/health || exit 1

# Start
CMD ["npm", "start"]
