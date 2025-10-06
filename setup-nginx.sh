#!/bin/bash
# Nginx setup script for single instance Sliptail deployment

echo "🔧 Setting up Nginx for single instance deployment..."

# Install Nginx
sudo apt update
sudo apt install nginx -y

# Remove default configuration
sudo rm -f /etc/nginx/sites-enabled/default

# Create Sliptail Nginx configuration
sudo tee /etc/nginx/sites-available/sliptail << 'EOF'
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    # Increase client max body size for file uploads
    client_max_body_size 100M;

    # API routes - proxy to backend (port 5000)
    location /api/ {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }

    # Uploads and static files from backend
    location /uploads/ {
        proxy_pass http://localhost:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # All other routes - proxy to frontend (port 3000)
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

# Enable the site
sudo ln -s /etc/nginx/sites-available/sliptail /etc/nginx/sites-enabled/

# Test Nginx configuration
sudo nginx -t

if [ $? -eq 0 ]; then
    echo "✅ Nginx configuration is valid"
    
    # Restart Nginx
    sudo systemctl restart nginx
    sudo systemctl enable nginx
    
    echo "✅ Nginx configured and started successfully!"
    echo ""
    echo "📝 Next steps:"
    echo "1. Update your domain DNS to point to this server"
    echo "2. Replace 'yourdomain.com' in /etc/nginx/sites-available/sliptail with your actual domain"
    echo "3. Set up SSL with: sudo certbot --nginx -d yourdomain.com"
    echo ""
    echo "🌐 Your app will be available at: http://yourdomain.com"
else
    echo "❌ Nginx configuration has errors. Please check and fix."
    exit 1
fi