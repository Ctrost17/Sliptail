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
    # Use '_' for any host/IP. Replace with your domain when DNS is ready.
    server_name www.sliptail.com;

    # Increase client max body size for file uploads
    client_max_body_size 3G;

    # API routes - proxy to backend (port 5000)
    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;

        proxy_request_buffering off;

        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
        proxy_connect_timeout 75s;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

    # Uploads and static files from backend
    location /uploads/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # All other routes - proxy to frontend (port 3000)
    location / {
        proxy_pass http://127.0.0.1:3000;
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
    echo "2. Replace 'sliptail.com' in /etc/nginx/sites-available/sliptail with your actual domain"
    echo "3. Set up SSL with: sudo certbot --nginx -d sliptail.com"
    echo ""
    echo "🌐 Your app will be available at: http://sliptail.com"
else
    echo "❌ Nginx configuration has errors. Please check and fix."
    exit 1
fi