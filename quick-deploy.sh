#!/bin/bash
# Quick deployment script for Sliptail - Single Instance Setup (with fixes)

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

# Stop and remove any existing containers first
echo "🛑 Stopping and cleaning up existing containers..."
sudo docker stop sliptail-backend sliptail-frontend 2>/dev/null || true
sudo docker rm sliptail-backend sliptail-frontend 2>/dev/null || true

# Clean up any failed images
sudo docker image prune -f 2>/dev/null || true

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
# Database Configuration - UPDATE THESE VALUES!
DB_HOST=your-lightsail-db-endpoint.region.rds.amazonaws.com
DB_USER=sliptail_admin
DB_PASSWORD=your-secure-database-password
DB_NAME=sliptail-db
DB_PORT=5432

# Application Configuration
NODE_ENV=production
PORT=5000
JWT_SECRET=your-very-secure-jwt-secret-key-here-make-it-long-and-random
EMAIL_LINK_SECRET=your-secure-email-link-secret-also-random

# Frontend URLs (Single Instance - Internal Communication)
FRONTEND_URL=http://localhost:3000
APP_ORIGIN=https://yourdomain.com

# Stripe Configuration - REQUIRED FOR PAYMENTS
STRIPE_SECRET_KEY=sk_live_your_stripe_secret_key
STRIPE_PUBLISHABLE_KEY=pk_live_your_stripe_publishable_key

# AWS SES Configuration - REQUIRED FOR EMAILS
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
    echo ""
    echo "🚨 IMPORTANT: Environment file created with template values!"
    echo "📍 File location: $(pwd)/sliptail-backend/.env.production"
    echo ""
    echo "You have 3 options:"
    echo "  1. Continue with test values (app will have limited functionality)"
    echo "  2. Exit now and update the file with real values"
    echo "  3. Use quick test setup (minimal working config for testing)"
    echo ""
    read -p "Enter your choice (1/2/3): " choice
    
    case $choice in
        1)
            echo "⚠️  Continuing with template values - expect some features to not work!"
            ;;
        2)
            echo "✋ Deployment paused. Please update sliptail-backend/.env.production and run this script again."
            echo "📋 Required updates:"
            echo "   - Database connection (DB_HOST, DB_PASSWORD, etc.)"
            echo "   - JWT secrets (use random strings)"
            echo "   - Stripe keys (from your Stripe dashboard)"
            echo "   - AWS credentials (for email sending)"
            echo "   - Your domain name"
            exit 0
            ;;
        3)
            echo "🧪 Setting up minimal test configuration..."
            cat > sliptail-backend/.env.production << EOF
# Minimal test configuration - FOR TESTING ONLY
NODE_ENV=production
PORT=5000

# Test database (will fail but won't crash immediately)
DB_HOST=localhost
DB_USER=test_user
DB_PASSWORD=test_password
DB_NAME=test_db
DB_PORT=5432

# Test secrets (CHANGE IN PRODUCTION!)
JWT_SECRET=test-jwt-secret-for-development-only-change-in-production
EMAIL_LINK_SECRET=test-email-secret-for-development-only

# URLs
FRONTEND_URL=http://localhost:3000
APP_ORIGIN=http://localhost:3000

# Test Stripe (CHANGE IN PRODUCTION!)
STRIPE_SECRET_KEY=sk_test_placeholder_change_this
STRIPE_PUBLISHABLE_KEY=pk_test_placeholder_change_this

# Test AWS (CHANGE IN PRODUCTION!)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test_access_key
AWS_SECRET_ACCESS_KEY=test_secret_key
SLIPTAIL_MAIL_FROM=test@example.com

# Disable cron for testing
ENABLE_CRON=0
CRON_ENABLED=false
EOF
            echo "✅ Test configuration created!"
            echo "⚠️  This is for testing deployment only - update with real values for production!"
            ;;
        *)
            echo "❌ Invalid choice. Exiting."
            exit 1
            ;;
    esac
else
    echo "✅ Backend environment file found."
    # Check if it still has template values
    if grep -q "your-lightsail-db-endpoint" sliptail-backend/.env.production; then
        echo "⚠️  WARNING: Environment file contains template values!"
        echo "⚠️  Some features may not work properly."
    fi
fi

# Frontend environment
if [ ! -f "sliptail-frontend/.env.production" ]; then
    echo "📝 Creating frontend environment file..."
    cat > sliptail-frontend/.env.production << EOF
# Single Instance Setup - Backend runs on same server
NEXT_PUBLIC_API_URL=http://localhost:5000
EOF
    echo "✅ Frontend environment configured for single instance setup."
else
    echo "✅ Frontend environment file found."
fi

# Stop any existing containers
echo "🛑 Ensuring no conflicting containers are running..."
sudo docker stop sliptail-backend sliptail-frontend 2>/dev/null || true
sudo docker rm sliptail-backend sliptail-frontend 2>/dev/null || true

# Create uploads directory
echo "📁 Setting up uploads directory..."
sudo mkdir -p /var/uploads
sudo chown 1000:1000 /var/uploads

# Deploy backend
echo "🔧 Building and deploying backend..."
cd sliptail-backend

echo "🏗️  Building backend Docker image..."
if ! sudo docker build -t sliptail-backend .; then
    echo "❌ Backend Docker build failed!"
    echo "📋 Check the build output above for errors."
    exit 1
fi

echo "🚀 Starting backend container..."
if ! sudo docker run -d \
  --name sliptail-backend \
  --env-file .env.production \
  -p 5000:5000 \
  -v /var/uploads:/app/public/uploads \
  --restart unless-stopped \
  sliptail-backend; then
    echo "❌ Backend container failed to start!"
    echo "📋 Checking backend logs..."
    sudo docker logs sliptail-backend --tail 20
    exit 1
fi

echo "✅ Backend deployed!"

# Wait a moment for backend to stabilize
echo "⏳ Waiting for backend to stabilize..."
sleep 5

# Check backend status
if ! sudo docker ps | grep -q sliptail-backend; then
    BACKEND_STATUS=$(sudo docker inspect sliptail-backend --format='{{.State.Status}}' 2>/dev/null || echo "not found")
    echo "❌ Backend container is not running! Status: $BACKEND_STATUS"
    echo "📋 Backend logs:"
    sudo docker logs sliptail-backend --tail 30
    echo ""
    echo "💡 Common issues:"
    echo "   - Database connection failed (check DB_HOST, credentials)"
    echo "   - Missing environment variables"
    echo "   - Port 5000 already in use"
    exit 1
else
    echo "✅ Backend is running successfully!"
fi

# Deploy frontend
echo "🎨 Building and deploying frontend..."
cd ../sliptail-frontend

echo "🏗️  Building frontend Docker image..."
if ! sudo docker build -t sliptail-frontend .; then
    echo "❌ Frontend Docker build failed!"
    echo "📋 This is likely due to TypeScript/ESLint errors in your code."
    echo "📋 The build has been configured to ignore these errors."
    echo "📋 Check the build output above for specific errors."
    echo ""
    echo "💡 If build continues to fail, try:"
    echo "   1. Check for syntax errors in your code"
    echo "   2. Ensure all required dependencies are in package.json"
    echo "   3. Check if there are any missing files"
    exit 1
fi

echo "🚀 Starting frontend container..."
if ! sudo docker run -d \
  --name sliptail-frontend \
  --env-file .env.production \
  -p 3000:3000 \
  --restart unless-stopped \
  sliptail-frontend; then
    echo "❌ Frontend container failed to start!"
    echo "📋 Checking frontend logs..."
    sudo docker logs sliptail-frontend --tail 20
    exit 1
fi

echo "✅ Frontend deployed!"

# Wait for frontend to stabilize
echo "⏳ Waiting for frontend to stabilize..."
sleep 5

# Check frontend status
if ! sudo docker ps | grep -q sliptail-frontend; then
    FRONTEND_STATUS=$(sudo docker inspect sliptail-frontend --format='{{.State.Status}}' 2>/dev/null || echo "not found")
    echo "❌ Frontend container is not running! Status: $FRONTEND_STATUS"
    echo "📋 Frontend logs:"
    sudo docker logs sliptail-frontend --tail 30
    echo ""
    echo "💡 Common issues:"
    echo "   - Build errors (TypeScript/ESLint)"
    echo "   - Missing dependencies"
    echo "   - Port 3000 already in use"
    exit 1
else
    echo "✅ Frontend is running successfully!"
fi

# Final check
echo "🔍 Final deployment verification..."
sleep 5

BACKEND_STATUS=$(sudo docker inspect sliptail-backend --format='{{.State.Status}}' 2>/dev/null || echo "not found")
FRONTEND_STATUS=$(sudo docker inspect sliptail-frontend --format='{{.State.Status}}' 2>/dev/null || echo "not found")

echo ""
echo "📊 Single Instance Deployment Status:"
echo "   🔧 Backend:  $BACKEND_STATUS (Port 5000)"
echo "   🎨 Frontend: $FRONTEND_STATUS (Port 3000)"

# Test if services are responding
echo ""
echo "🔍 Testing service connectivity..."

# Test backend
if curl -s http://localhost:5000 >/dev/null 2>&1; then
    echo "✅ Backend responding on port 5000"
else
    echo "⚠️  Backend not responding on port 5000 (may be normal if no health endpoint)"
fi

# Test frontend
if curl -s http://localhost:3000 >/dev/null 2>&1; then
    echo "✅ Frontend responding on port 3000"
else
    echo "⚠️  Frontend not responding on port 3000 (may be normal during startup)"
fi

if [ "$BACKEND_STATUS" = "running" ] && [ "$FRONTEND_STATUS" = "running" ]; then
    PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "your-server-ip")
    echo ""
    echo "🎉 Deployment successful!"
    echo "🌐 Application URLs:"
    echo "   Frontend: http://$PUBLIC_IP:3000"
    echo "   Backend:  http://$PUBLIC_IP:5000"
    echo ""
    echo "⚠️  Important Next Steps:"
    echo "   1. Update environment variables with real values (database, Stripe, AWS)"
    echo "   2. Set up Nginx reverse proxy for production:"
    echo "      wget https://raw.githubusercontent.com/Ctrost17/Sliptail/main/setup-nginx.sh"
    echo "      chmod +x setup-nginx.sh && ./setup-nginx.sh"
    echo "   3. Configure SSL with Let's Encrypt"
    echo "   4. Point your domain to this server"
    echo ""
    echo "📋 Useful commands:"
    echo "   sudo docker logs sliptail-backend    # Backend logs"
    echo "   sudo docker logs sliptail-frontend   # Frontend logs"
    echo "   sudo docker ps                       # Container status"
    echo "   sudo docker restart sliptail-backend # Restart backend"
    echo "   sudo docker restart sliptail-frontend # Restart frontend"
else
    echo ""
    echo "❌ Deployment issues detected!"
    
    if [ "$BACKEND_STATUS" != "running" ]; then
        echo ""
        echo "🔍 Backend Issues:"
        echo "📋 Recent backend logs:"
        sudo docker logs sliptail-backend --tail 20
        echo ""
    fi
    
    if [ "$FRONTEND_STATUS" != "running" ]; then
        echo ""
        echo "🔍 Frontend Issues:"
        echo "📋 Recent frontend logs:"
        sudo docker logs sliptail-frontend --tail 20
        echo ""
    fi
    
    echo "💡 Troubleshooting tips:"
    echo "   1. Check logs above for specific errors"
    echo "   2. Verify environment file has correct values"
    echo "   3. Ensure database is accessible"
    echo "   4. Check if ports 3000 and 5000 are available"
    echo "   5. Try restarting containers: sudo docker restart sliptail-backend sliptail-frontend"
fi