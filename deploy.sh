#!/bin/bash
# Automated deployment script for Sliptail from GitHub repository - Single Instance

set -e  # Exit on any error

REPO_URL="https://github.com/Ctrost17/Sliptail.git"
DEPLOY_DIR="/opt/sliptail"
BACKUP_DIR="/opt/sliptail-backup"

echo "🚀 Starting Sliptail deployment from GitHub (Single Instance)..."

# Create deployment directory if it doesn't exist
sudo mkdir -p $DEPLOY_DIR

# Backup existing deployment if it exists
if [ -d "$DEPLOY_DIR/.git" ]; then
    echo "📦 Creating backup of existing deployment..."
    sudo rm -rf $BACKUP_DIR
    sudo cp -r $DEPLOY_DIR $BACKUP_DIR
fi

# Clone or pull latest code
cd $DEPLOY_DIR
if [ ! -d ".git" ]; then
    echo "📥 Cloning repository..."
    sudo git clone $REPO_URL .
    sudo chown -R $USER:$USER .
else
    echo "🔄 Pulling latest changes..."
    git fetch origin
    git reset --hard origin/main
fi

echo "✅ Code updated successfully!"

# Stop existing containers
echo "🛑 Stopping existing containers..."
sudo docker stop sliptail-backend 2>/dev/null || true
sudo docker stop sliptail-frontend 2>/dev/null || true
sudo docker rm sliptail-backend 2>/dev/null || true
sudo docker rm sliptail-frontend 2>/dev/null || true

# Backend deployment
echo "🔧 Building and deploying backend..."
cd sliptail-backend

# Check if .env.production exists
if [ ! -f ".env.production" ]; then
    echo "⚠️  Creating .env.production from template..."
    cp .env.production.template .env.production
    echo "❗ Please update .env.production with your actual values before continuing!"
    echo "❗ Press Enter when you've updated the environment file..."
    read
fi

# Build backend image
sudo docker build -t sliptail-backend .

# Ensure uploads directory exists
sudo mkdir -p /var/uploads
sudo chown 1000:1000 /var/uploads

# Run backend container
sudo docker run -d \
  --name sliptail-backend \
  --env-file .env.production \
  -p 5000:5000 \
  -v /var/uploads:/app/public/uploads \
  --restart unless-stopped \
  sliptail-backend

echo "✅ Backend deployed successfully!"

# Frontend deployment
echo "🎨 Building and deploying frontend..."
cd ../sliptail-frontend

# Check if .env.production exists
if [ ! -f ".env.production" ]; then
    echo "⚠️  Creating .env.production from template..."
    echo "NEXT_PUBLIC_API_URL=http://localhost:5000" > .env.production
    echo "❗ Update this to your domain when you have SSL setup!"
fi

# Build frontend image
sudo docker build -t sliptail-frontend .

# Run frontend container
sudo docker run -d \
  --name sliptail-frontend \
  --env-file .env.production \
  -p 3000:3000 \
  --restart unless-stopped \
  sliptail-frontend

echo "✅ Frontend deployed successfully!"

# Health check
echo "🔍 Performing health checks..."
sleep 10

# Check if containers are running
BACKEND_STATUS="stopped"
FRONTEND_STATUS="stopped"

if sudo docker ps | grep -q sliptail-backend; then
    BACKEND_STATUS="running"
    echo "✅ Backend container is running"
else
    echo "❌ Backend container failed to start"
    echo "📋 Backend logs:"
    sudo docker logs sliptail-backend --tail 20
fi

if sudo docker ps | grep -q sliptail-frontend; then
    FRONTEND_STATUS="running"
    echo "✅ Frontend container is running"
else
    echo "❌ Frontend container failed to start"
    echo "📋 Frontend logs:"
    sudo docker logs sliptail-frontend --tail 20
fi

# Show final status
echo ""
echo "🎉 Single Instance Deployment completed!"
echo "📍 Deployment location: $DEPLOY_DIR"
echo "� Backend Status: $BACKEND_STATUS"
echo "� Frontend Status: $FRONTEND_STATUS"
echo ""
echo "🌐 Application URLs:"
echo "   Frontend: http://$(curl -s ifconfig.me):3000"
echo "   Backend API: http://$(curl -s ifconfig.me):5000"
echo ""
echo "📋 Useful commands:"
echo "   sudo docker logs sliptail-backend"
echo "   sudo docker logs sliptail-frontend"
echo "   sudo docker ps"
echo ""
echo "⚠️  Next steps:"
echo "   1. Set up Nginx reverse proxy (recommended)"
echo "   2. Configure SSL with Let's Encrypt"
echo "   3. Point your domain to this instance"