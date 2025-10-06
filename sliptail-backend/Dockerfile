FROM node:18-alpine

# Install ffmpeg for video processing
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm install --production

# Copy application code
COPY . .

# Create uploads directory
RUN mkdir -p public/uploads

# Expose port
EXPOSE 5000

# Start the application
CMD ["npm", "start"]
