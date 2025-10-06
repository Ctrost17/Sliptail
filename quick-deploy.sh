#!/bin/bash
# Quick deployment script for Sliptail - Single Instance Setup

REPO_URL="https://github.com/Ctrost17/Sliptail.git"
BRANCH="main"

echo "🚀 Quick Deploy: Sliptail from GitHub (Single Instance)"
echo "📍 Repository: $REPO_URL"
echo "🌿 Branch: $BRANCH"

# Check if git is installed
if ! command -v git &> /dev/null; then
    echo "❌ Git is required but not installed. Please install git first."
    exit 1
fi

# Check if docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is required but not installed. Please install docker first."
    exit 1
fi

# Clone or update repository
if [ -d "sliptail-deploy" ]; then
    echo "🔄 Updating existing repository..."
    cd sliptail-deploy
    git fetch origin
    git reset --hard origin/$BRANCH
    git clean -fd
else
    echo "📥 Cloning repository..."
    git clone -b $BRANCH $REPO_URL sliptail-deploy
    cd sliptail-deploy
fi

echo "✅ Code ready!"

# Check for environment files
echo "🔧 Checking environment configuration..."

# Backend environment
if [ ! -f "sliptail-backend/.env.production" ]; then
    echo "⚠️  Backend environment file missing!"
    echo "📝 Creating template: sliptail-backend/.env.production"
    cp sliptail-backend/.env.production.template sliptail-backend/.env.production 2>/dev/null || {
        cat > sliptail-backend/.env.production << EOF
# Database Configuration
DB_HOST=your-lightsail-db-endpoint.region.rds.amazonaws.com
DB_USER=sliptail_admin
DB_PASSWORD=your-secure-database-password
DB_NAME=sliptail-db
DB_PORT=5432

# Application Configuration
NODE_ENV=production
PORT=5000
JWT_SECRET=your-very-secure-jwt-secret-key-here
EMAIL_LINK_SECRET=your-secure-email-link-secret

# Frontend URLs (Single Instance - Internal Communication)
FRONTEND_URL=http://localhost:3000
APP_ORIGIN=https://yourdomain.com

# Stripe Configuration
STRIPE_SECRET_KEY=sk_live_your_stripe_secret_key
STRIPE_PUBLISHABLE_KEY=pk_live_your_stripe_publishable_key

# AWS SES Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key
SLIPTAIL_MAIL_FROM=noreply@yourdomain.com

# Cron Jobs Configuration
ENABLE_CRON=1
CRON_ENABLED=true
CRON_TZ=UTC
EOF
    }
    echo "❗ Please edit sliptail-backend/.env.production with your actual values!"
    echo "❗ Press Enter when ready to continue..."
    read
fi

# Frontend environment
if [ ! -f "sliptail-frontend/.env.production" ]; then
    echo "📝 Creating frontend environment file..."
    cat > sliptail-frontend/.env.production << EOF
# Single Instance Setup - Backend runs on same server
NEXT_PUBLIC_API_URL=http://localhost:5000
EOF
    echo "❗ This will be updated to use Nginx proxy later!"
fi

# Stop any existing containers
echo "🛑 Stopping existing containers..."
sudo docker stop sliptail-backend sliptail-frontend 2>/dev/null || true
sudo docker rm sliptail-backend sliptail-frontend 2>/dev/null || true

# Create uploads directory
echo "📁 Setting up uploads directory..."
sudo mkdir -p /var/uploads
sudo chown 1000:1000 /var/uploads

# Deploy backend
echo "🔧 Building and deploying backend..."
cd sliptail-backend

sudo docker build -t sliptail-backend .
sudo docker run -d \
  --name sliptail-backend \
  --env-file .env.production \
  -p 5000:5000 \
  -v /var/uploads:/app/public/uploads \
  --restart unless-stopped \
  sliptail-backend

echo "✅ Backend deployed!"

# Deploy frontend
echo "🎨 Building and deploying frontend..."
cd ../sliptail-frontend

sudo docker build -t sliptail-frontend .
sudo docker run -d \
  --name sliptail-frontend \
  --env-file .env.production \
  -p 3000:3000 \
  --restart unless-stopped \
  sliptail-frontend

echo "✅ Frontend deployed!"

# Final check
echo "🔍 Checking deployment status..."
sleep 5

BACKEND_STATUS=$(sudo docker inspect sliptail-backend --format='{{.State.Status}}' 2>/dev/null || echo "not found")
FRONTEND_STATUS=$(sudo docker inspect sliptail-frontend --format='{{.State.Status}}' 2>/dev/null || echo "not found")

echo ""
echo "📊 Single Instance Deployment Status:"
echo "   🔧 Backend:  $BACKEND_STATUS (Port 5000)"
echo "   🎨 Frontend: $FRONTEND_STATUS (Port 3000)"

if [ "$BACKEND_STATUS" = "running" ] && [ "$FRONTEND_STATUS" = "running" ]; then
    PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "your-server-ip")
    echo ""
    echo "🎉 Deployment successful!"
    echo "🌐 Application URLs:"
    echo "   Frontend: http://$PUBLIC_IP:3000"
    echo "   Backend:  http://$PUBLIC_IP:5000"
    echo ""
    echo "⚠️  Important Next Steps:"
    echo "   1. Set up Nginx reverse proxy for production"
    echo "   2. Configure SSL with Let's Encrypt"
    echo "   3. Update frontend environment to use domain"
    echo ""
    echo "📋 Useful commands:"
    echo "   sudo docker logs sliptail-backend"
    echo "   sudo docker logs sliptail-frontend"
    echo "   sudo docker ps"
else
    echo ""
    echo "❌ Deployment issues detected!"
    echo "📋 Check logs:"
    echo "   sudo docker logs sliptail-backend"
    echo "   sudo docker logs sliptail-frontend"
fi

echo ""
echo "💡 Single Instance Benefits:"
echo "   ✅ Lower cost (~$10-20/month total)"
echo "   ✅ Simpler management"
echo "   ✅ Faster internal communication"
echo "   ✅ Shared resources"
