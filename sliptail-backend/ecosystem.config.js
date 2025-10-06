module.exports = {
  apps: [{
    name: 'sliptail-backend',
    script: 'index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env_production: {
      NODE_ENV: 'production',
      PORT: 5000,
      // Database
      DB_HOST: 'your-lightsail-db-endpoint',
      DB_USER: 'sliptail_admin',
      DB_PASSWORD: 'your-db-password',
      DB_NAME: 'sliptail-db',
      DB_PORT: 5432,
      
      // Application
      JWT_SECRET: 'your-secure-jwt-secret',
      EMAIL_LINK_SECRET: 'your-email-secret',
      
      // Frontend URL
      FRONTEND_URL: 'https://your-frontend-domain.com',
      APP_ORIGIN: 'https://your-frontend-domain.com',
      
      // Stripe
      STRIPE_SECRET_KEY: 'sk_live_your_stripe_secret',
      STRIPE_PUBLISHABLE_KEY: 'pk_live_your_stripe_publishable',
      
      // AWS SES
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'your-aws-access-key',
      AWS_SECRET_ACCESS_KEY: 'your-aws-secret-key',
      SLIPTAIL_MAIL_FROM: 'noreply@yourdomain.com',
      
      // Cron Jobs
      ENABLE_CRON: '1',
      CRON_TZ: 'UTC'
    }
  }]
};