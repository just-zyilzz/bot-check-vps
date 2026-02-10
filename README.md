# VPS Monitor & Deploy Bot

Telegram bot for monitoring VPS and deploying web applications using Node.js.

## Features
- **Monitoring**: CPU, RAM, Disk, Network, System Info
- **Deployment**: Git, Node.js, Python, PM2, Nginx
- **Management**: Start, Stop, Restart, Delete apps

## Installation

1. **Upload to VPS**:
   Upload all files to `/opt/vps-bot` (or your preferred directory).

2. **Run Installer**:
   ```bash
   chmod +x install-js.sh
   sudo bash install-js.sh
   ```

3. **Configure**:
   Edit `bot.js` and set your `BOT_TOKEN`, `VPS_IP`, and `AUTHORIZED_USERS`.
   ```bash
   nano bot.js
   ```

4. **Restart**:
   ```bash
   pm2 restart vps-bot
   ```

## Usage

- `/start` - Main Menu
- `/deploy <name> <repo> <port>` - Deploy new app
- `/list` - List running apps
- `/help` - Show help message
