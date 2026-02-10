#!/bin/bash

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}🚀 Starting VPS Bot Installer...${NC}"

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
  echo -e "${RED}Please run as root (sudo bash install-js.sh)${NC}"
  exit
fi

# 1. Update System
echo -e "${GREEN}📦 Updating system packages...${NC}"
apt update && apt upgrade -y

# 2. Install Node.js 18.x
echo -e "${GREEN}📦 Installing Node.js 18.x...${NC}"
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs build-essential

# 3. Install PM2 & Git & Nginx & Speedtest & Certbot
echo -e "${GREEN}📦 Installing PM2, Git, Nginx, Speedtest, Certbot...${NC}"
npm install -g pm2
apt install -y git nginx python3-pip certbot python3-certbot-nginx
pip3 install speedtest-cli

# 4. Setup Directories
echo -e "${GREEN}📂 Setting up directories...${NC}"
mkdir -p /var/www
# Adjust permissions (assuming running as root, but maybe we want a specific user?)
# For now, let's keep it root or standard user if configured.
# chmod -R 755 /var/www

# 5. Install Project Dependencies
echo -e "${GREEN}📦 Installing project dependencies...${NC}"
if [ -f "package.json" ]; then
    npm install
else
    echo -e "${RED}package.json not found!${NC}"
fi

# 6. Setup Firewall
echo -e "${GREEN}🛡️ Configuring Firewall...${NC}"
ufw allow OpenSSH
ufw allow 'Nginx Full'
# ufw enable # Ask user manually to avoid locking out

# 7. Start Bot
echo -e "${GREEN}🤖 Starting Bot...${NC}"
pm2 start ecosystem.config.js
pm2 save
pm2 startup

echo -e "${GREEN}✅ Installation Complete!${NC}"
echo -e "IMPORTANT: Edit bot.js to set your BOT_TOKEN and VPS_IP"
echo -e "Then run: pm2 restart vps-bot"
