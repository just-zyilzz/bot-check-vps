module.exports = {
  apps : [{
    name   : "vps-bot",
    script : "./bot.js",
    watch  : true,
    ignore_watch : ["node_modules", "logs"],
    max_memory_restart: '500M',
    env: {
      NODE_ENV: "production",
    }
  }]
}
