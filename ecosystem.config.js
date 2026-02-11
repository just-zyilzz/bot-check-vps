module.exports = {
  apps : [{
    name   : "vps-bot",
    script : "./bot.js",
    watch  : true,
    ignore_watch : ["node_modules", "logs", ".git", ".git/*", "*.log", "*.png", "temp"],
    watch_delay: 1000,
    max_memory_restart: '500M',
    kill_timeout: 3000,
    env: {
      NODE_ENV: "production",
    }
  }]
}
