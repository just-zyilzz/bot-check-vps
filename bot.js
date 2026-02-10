require('dotenv').config();
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const si = require('systeminformation');
const shell = require('shelljs');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

// Configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const VPS_IP = process.env.VPS_IP;
const AUTHORIZED_USERS = [parseInt(process.env.AUTHORIZED_USER)]; // Load from env

// App Directories
const APPS_DIR = '/var/www';
const NGINX_AVAILABLE = '/etc/nginx/sites-available';
const NGINX_ENABLED = '/etc/nginx/sites-enabled';

// Helper to find available port
const getAvailablePort = async (startPort = 3000) => {
    let port = startPort;
    while (true) {
        try {
            // Check if port is in use using 'lsof' or 'netstat' logic via shell
            // Simple check: try to listen or check netstats. 
            // Using systeminformation for cleaner approach
            const connections = await si.networkConnections();
            const usedPorts = connections.map(c => c.localPort);
            
            if (!usedPorts.includes(port)) {
                return port;
            }
            port++;
        } catch (e) {
            console.error('Error checking ports:', e);
            // Fallback simple increment if check fails
            return port + Math.floor(Math.random() * 100); 
        }
    }
};

// --- WIZARD SCENE FOR DEPLOYMENT ---
const deployWizard = new Scenes.WizardScene(
    'deploy_wizard',
    // Step 1: Ask for Repo URL
    (ctx) => {
        ctx.reply('🚀 *DEPLOYMENT WIZARD*\n\nSilakan kirimkan *Link Repository GitHub* Anda.\n(Contoh: https://github.com/user/my-app.git)', { parse_mode: 'Markdown' });
        ctx.wizard.state.data = {};
        return ctx.wizard.next();
    },
    // Step 2: Ask for App Name
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply('⚠️ Harap kirimkan link valid.');
        const repo = ctx.message.text.trim();
        
        // Basic validation
        if (!repo.startsWith('http')) return ctx.reply('⚠️ Link harus dimulai dengan http/https.');
        
        ctx.wizard.state.data.repo = repo;
        
        ctx.reply('📝 *Nama Aplikasi*\n\nBerikan nama untuk aplikasi ini (tanpa spasi).\n(Contoh: my-api)', { parse_mode: 'Markdown' });
        return ctx.wizard.next();
    },
    // Step 3: Auto Port & Execute
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply('⚠️ Harap kirimkan nama valid.');
        const name = ctx.message.text.trim().replace(/\s+/g, '-').toLowerCase();
        
        // Check if name exists
        if (fs.existsSync(path.join(APPS_DIR, name))) {
            ctx.reply(`⚠️ Aplikasi dengan nama *${name}* sudah ada! Silakan ulangi /deploy atau gunakan nama lain.`, { parse_mode: 'Markdown' });
            return ctx.scene.leave();
        }
        
        ctx.wizard.state.data.name = name;
        
        // AUTO PORT DETECTION
        const statusMsg = await ctx.reply('🔍 Mencari port yang tersedia...');
        
        // Helper to update status
        const updateStatus = async (text) => {
            try {
                await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, text, { parse_mode: 'Markdown' });
            } catch (e) { 
                // Ignore if message not modified
            }
        };

        const port = await getAvailablePort(3000);
        ctx.wizard.state.data.port = port;
        
        const { repo } = ctx.wizard.state.data;
        
        // Start Deployment Process
        await updateStatus(`⚙️ *Memulai Deployment...*\n\n📦 App: ${name}\n🔗 Repo: ${repo}\n🔌 Port: ${port} (Auto)`);
        
        const appPath = path.join(APPS_DIR, name);
        
        try {
            // 1. Clone
            await updateStatus(`⚙️ *Deployment: ${name}*\n\n📥 Cloning repository...`);
            const cloneRes = shell.exec(`git clone ${repo} ${appPath}`, { silent: true });
            if (cloneRes.code !== 0) {
                throw new Error(`Git Clone Failed:\n${cloneRes.stderr}`);
            }

            // 2. Install Dependencies
            await updateStatus(`⚙️ *Deployment: ${name}*\n\n📦 Installing dependencies...`);
            let installCmd = '';
            
            if (fs.existsSync(path.join(appPath, 'package.json'))) {
                installCmd = `cd ${appPath} && npm install`;
            } else if (fs.existsSync(path.join(appPath, 'requirements.txt'))) {
                installCmd = `cd ${appPath} && pip install -r requirements.txt`;
            }
            
            if (installCmd) {
                const installRes = shell.exec(installCmd, { silent: true });
                if (installRes.code !== 0) {
                    throw new Error(`Install Failed:\n${installRes.stderr.substring(0, 500)}...`); // Truncate long logs
                }
            }

            // 3. Start PM2
            await updateStatus(`⚙️ *Deployment: ${name}*\n\n🔥 Starting process...`);
            let script = 'index.js';
            const pkgPath = path.join(appPath, 'package.json');
            if (fs.existsSync(pkgPath)) {
                const pkg = require(pkgPath);
                script = pkg.main || 'index.js';
                if (pkg.scripts && pkg.scripts.start) script = 'npm -- start';
            }
            
            const startCmd = `cd ${appPath} && PORT=${port} pm2 start ${script} --name ${name}`;
            const startRes = shell.exec(startCmd, { silent: true });
            if (startRes.code !== 0) {
                throw new Error(`PM2 Start Failed:\n${startRes.stderr}`);
            }
            shell.exec('pm2 save');

            // 4. Setup Nginx
            await updateStatus(`⚙️ *Deployment: ${name}*\n\n🌐 Configuring Nginx...`);
            const nginxConfig = `
server {
    listen 80;
    server_name ${name}.${VPS_IP}.nip.io;

    location / {
        proxy_pass http://localhost:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
`;
            const configPath = path.join(NGINX_AVAILABLE, name);
            fs.writeFileSync(configPath, nginxConfig);
            shell.exec(`ln -s ${configPath} ${path.join(NGINX_ENABLED, name)}`);
            
            const nginxReload = shell.exec('sudo systemctl reload nginx');
            if (nginxReload.code !== 0) {
                 await updateStatus('⚠️ Nginx reload failed. Cek config manual.');
            }

            await updateStatus(`✅ *DEPLOYMENT SUCCESS!* 🎉\n\n🌍 URL: http://${name}.${VPS_IP}.nip.io\n🔌 Port: ${port}`);
            
        } catch (err) {
            console.error(err);
            // Cleanup: remove folder if failed
            if (fs.existsSync(appPath)) shell.rm('-rf', appPath);
            
            await updateStatus(`❌ *DEPLOYMENT GAGAL!* 😭\n\nError Detail:\n\`${err.message}\`\n\nFolder aplikasi telah dibersihkan. Silakan coba lagi.`);
        }

        return ctx.scene.leave();
    }
);

const stage = new Scenes.Stage([deployWizard]);
const bot = new Telegraf(BOT_TOKEN);

// Use Session & Stage
bot.use(session());
bot.use(stage.middleware());

// Middleware for Authorization
const authMiddleware = (ctx, next) => {
    const userId = ctx.from.id;
    if (AUTHORIZED_USERS.includes(userId)) {
        return next();
    }
    return ctx.reply('⛔ Unauthorized access. Please contact admin.');
};

bot.use(authMiddleware);

// Helper Functions
const formatBytes = (bytes, decimals = 2) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

const getProgressBar = (percent, length = 10) => {
    const filled = Math.round((percent / 100) * length);
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
};

// --- Commands ---

// --- Menu Handlers ---
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('📊 Status VPS', 'status_vps'), Markup.button.callback('🚀 Speedtest', 'speedtest_run')],
    [Markup.button.callback('📦 Deploy App', 'start_deploy'), Markup.button.callback('ℹ️ System Info', 'status_sys')],
    [Markup.button.callback('� Update Apps', 'list_updates'), Markup.button.callback('✨ Fitur Lainnya', 'show_more_menu')]
]);

const moreMenu = Markup.inlineKeyboard([
    [Markup.button.callback('💾 Disk Space', 'status_disk'), Markup.button.callback('🌐 Network', 'status_net')],
    [Markup.button.callback('📂 List Apps', 'list_apps'), Markup.button.callback('🔐 Login Monitor', 'login_monitor')],
    [Markup.button.callback('🛡️ Firewall', 'status_ufw'), Markup.button.callback('📜 SSL Manager', 'status_ssl')],
    [Markup.button.callback('🗄️ Database', 'status_db'), Markup.button.callback('🐳 Docker', 'status_docker')],
    [Markup.button.callback('⬅️ Kembali ke Menu Utama', 'back_to_main'), Markup.button.callback('❓ Help', 'help_msg')]
]);

bot.start((ctx) => {
    ctx.reply(
        `🤖 *VPS Monitor & Deploy Bot*
        
Halo ${ctx.from.first_name}! 👋
Panel kontrol VPS Anda siap digunakan.

*IP Address:* \`${VPS_IP}\`
*OS:* Linux (Detected)

Silakan pilih menu di bawah ini:`,
        {
            parse_mode: 'Markdown',
            ...mainMenu
        }
    );
});

// Navigation Actions
bot.action('show_more_menu', (ctx) => {
    ctx.editMessageText('✨ *FITUR LAINNYA*\n\nSilakan pilih tool tambahan di bawah ini:', {
        parse_mode: 'Markdown',
        ...moreMenu
    });
});

bot.action('back_to_main', (ctx) => {
    ctx.editMessageText(
        `🤖 *VPS Monitor & Deploy Bot*
        
Halo ${ctx.from.first_name}! 👋
Panel kontrol VPS Anda siap digunakan.

*IP Address:* \`${VPS_IP}\`
*OS:* Linux (Detected)

Silakan pilih menu di bawah ini:`,
        {
            parse_mode: 'Markdown',
            ...mainMenu
        }
    );
});

// Trigger Deployment Wizard
bot.action('start_deploy', (ctx) => {
    ctx.scene.enter('deploy_wizard');
});

bot.command('help', (ctx) => {
    ctx.reply(
        `📚 *Panduan Perintah*

*Deployment:*
\`/deploy <name> <repo_url> <port>\`
Contoh:
\`/deploy myapp https://github.com/user/repo.git 3000\`

*Management:*
\`/list\` - List semua aplikasi
\`/stop <name>\` - Stop aplikasi
\`/restart <name>\` - Restart aplikasi
\`/delete <name>\` - Hapus aplikasi
\`/logs <name> [lines]\` - Lihat log aplikasi

*Monitoring:*
Gunakan menu visual dengan /start`,
        { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        }
    );
});

bot.action('help_msg', (ctx) => {
    ctx.editMessageText(
        `📚 *Panduan Perintah*

*Deployment:*
\`/deploy <name> <repo_url> <port>\`
Contoh:
\`/deploy myapp https://github.com/user/repo.git 3000\`

*Management:*
\`/list\` - List semua aplikasi
\`/stop <name>\` - Stop aplikasi
\`/restart <name>\` - Restart aplikasi
\`/delete <name>\` - Hapus aplikasi
\`/logs <name> [lines]\` - Lihat log aplikasi

*Monitoring:*
Gunakan menu visual dengan /start`,
        { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        }
    );
});

// --- Monitoring Actions ---

bot.action('status_vps', async (ctx) => {
    try {
        const cpu = await si.currentLoad();
        const mem = await si.mem();
        const disk = await si.fsSize();
        
        const mainDisk = disk[0]; // Assuming first disk is main
        
        ctx.editMessageText(
            `📊 *VPS Status Overview*

*CPU Usage:* ${cpu.currentLoad.toFixed(1)}%
${getProgressBar(cpu.currentLoad)}

*Memory:* ${formatBytes(mem.active)} / ${formatBytes(mem.total)}
${getProgressBar((mem.active / mem.total) * 100)}

*Disk:* ${formatBytes(mainDisk.used)} / ${formatBytes(mainDisk.size)} (${mainDisk.use}%)
${getProgressBar(mainDisk.use)}`,
            { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'status_vps')],
                    [Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]
                ])
            }
        );
    } catch (e) {
        console.error(e);
        ctx.reply('❌ Gagal mengambil data status.');
    }
});

bot.action('status_resources', async (ctx) => {
    try {
        const cpu = await si.cpu();
        const mem = await si.mem();
        const load = await si.currentLoad();

        ctx.editMessageText(
            `💻 *Resource Detail*

*CPU:*
Model: ${cpu.manufacturer} ${cpu.brand}
Cores: ${cpu.cores}
Speed: ${cpu.speed} GHz
Load: ${load.currentLoad.toFixed(1)}%

*Memory:*
Total: ${formatBytes(mem.total)}
Free: ${formatBytes(mem.free)}
Used: ${formatBytes(mem.used)}
Active: ${formatBytes(mem.active)}
Available: ${formatBytes(mem.available)}`,
            { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                     [Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]
                ])
            }
        );
    } catch (e) {
        ctx.reply('❌ Gagal mengambil data resource.');
    }
});

bot.action('status_disk', async (ctx) => {
    try {
        const disks = await si.fsSize();
        let msg = `💾 *Disk Usage*\n\n`;
        
        disks.forEach(d => {
            msg += `*Mount:* \`${d.mount}\`\n`;
            msg += `Type: ${d.type}\n`;
            msg += `Size: ${formatBytes(d.size)}\n`;
            msg += `Used: ${formatBytes(d.used)} (${d.use}%)\n`;
            msg += `${getProgressBar(d.use)}\n\n`;
        });
        
        ctx.editMessageText(msg, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                 [Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]
            ])
        });
    } catch (e) {
        ctx.reply('❌ Gagal mengambil data disk.');
    }
});

bot.action('status_net', async (ctx) => {
    try {
        const netStats = await si.networkStats();
        const iface = netStats[0]; // Primary interface
        
        ctx.editMessageText(
            `🌐 *Network Statistics*

*Interface:* ${iface.iface}
*State:* ${iface.operstate}

*Traffic:*
⬇️ RX: ${formatBytes(iface.rx_bytes)}
⬆️ TX: ${formatBytes(iface.tx_bytes)}

*Speed:*
⬇️ Down: ${formatBytes(iface.rx_sec)}/s
⬆️ Up: ${formatBytes(iface.tx_sec)}/s`,
            { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'status_net')],
                    [Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]
                ])
            }
        );
    } catch (e) {
        ctx.reply('❌ Gagal mengambil data network.');
    }
});

// --- Speedtest Action ---
bot.action('speedtest_run', async (ctx) => {
    await ctx.editMessageText('⏳ *Running Speedtest...*\n\nMohon tunggu sekitar 30 detik. Bot sedang mengukur kecepatan jaringan VPS Anda...', { parse_mode: 'Markdown' });
    
    // Execute speedtest-cli --json
    shell.exec('speedtest-cli --json', { silent: true }, (code, stdout, stderr) => {
        if (code !== 0) {
            // Fallback if not found
            if (stderr.includes('not found')) {
                return ctx.editMessageText('❌ `speedtest-cli` belum terinstall.\nRun: `apt install speedtest-cli` atau `pip install speedtest-cli` di VPS.', { 
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
                });
            }
            return ctx.editMessageText(`❌ Speedtest gagal:\n${stderr}`, {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }

        try {
            const result = JSON.parse(stdout);
            
            // Convert bits to Mbps
            const dl = (result.download / 1000000).toFixed(2);
            const ul = (result.upload / 1000000).toFixed(2);
            const ping = result.ping.toFixed(1);
            const isp = result.client.isp;
            const country = result.client.country;
            const server = result.server.sponsor;
            const serverLoc = result.server.name;
            
            const msg = `🚀 *SPEEDTEST RESULT*

*Download:* ${dl} Mbps
*Upload:* ${ul} Mbps
*Ping:* ${ping} ms

*ISP:* ${isp} (${country})
*Server:* ${server} - ${serverLoc}
*IP:* ${result.client.ip}`;

            ctx.editMessageText(msg, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
            
        } catch (e) {
            console.error(e);
            ctx.editMessageText('❌ Gagal memproses hasil speedtest.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }
    });
});

bot.action('login_monitor', async (ctx) => {
    try {
        await ctx.editMessageText('🔐 *LOGIN MONITOR*\n\nSedang menganalisa login di VPS...', { parse_mode: 'Markdown' });

        // Get active users
        const activeUsers = shell.exec('who', { silent: true }).stdout.trim() || 'Tidak ada user aktif';
        
        // Get last logins
        const lastLogins = shell.exec('last -n 5', { silent: true }).stdout.trim() || 'Tidak ada history';
        
        // Get failed logins (last 24 hours)
        const failedLogins = shell.exec("grep 'Failed password' /var/log/auth.log | tail -10", { silent: true }).stdout.trim() || 'Tidak ada failed login';
        
        // Get successful logins (last 24 hours)
        const successLogins = shell.exec("grep 'Accepted password' /var/log/auth.log | tail -5", { silent: true }).stdout.trim() || 'Tidak ada login sukses';

        const sections = [
            { title: '👥 Active Users', content: activeUsers },
            { title: '📜 Last 5 Logins', content: lastLogins },
            { title: '❌ Failed Logins (Last 10)', content: failedLogins },
            { title: '✅ Successful Logins (Last 5)', content: successLogins }
        ];

        let fullMessage = `🔐 *LOGIN MONITOR REPORT*\n\n`;
        let isFirst = true;
        
        for (const section of sections) {
            const sectionText = `*${section.title}:*\n\`\`\`\n${section.content}\n\`\`\`\n\n`;
            if ((fullMessage + sectionText).length > 4000) {
                // Send current buffer
                if (isFirst) {
                    await ctx.editMessageText(fullMessage, { parse_mode: 'Markdown' });
                    isFirst = false;
                } else {
                    await ctx.reply(fullMessage, { parse_mode: 'Markdown' });
                }
                fullMessage = `*${section.title} (cont):*\n\`\`\`\n${section.content}\n\`\`\`\n\n`;
            } else {
                fullMessage += sectionText;
            }
        }

        if (fullMessage) {
            if (isFirst) {
                await ctx.editMessageText(fullMessage, { 
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
                });
            } else {
                await ctx.reply(fullMessage, { 
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
                });
            }
        }
    } catch (err) {
        console.error(err);
        ctx.editMessageText('❌ Gagal mengambil data login monitor.', {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    }
});

// --- Firewall (UFW) Action ---
bot.action('status_ufw', async (ctx) => {
    ctx.editMessageText('🛡️ *FIREWALL (UFW) STATUS*\n\nMenganalisa aturan firewall...', { parse_mode: 'Markdown' });
    
    shell.exec('sudo ufw status numbered', { silent: true }, (code, stdout, stderr) => {
        if (code !== 0) return ctx.editMessageText(`❌ Gagal mengambil status UFW:\n${stderr}`, {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
        
        const msg = `🛡️ *FIREWALL (UFW) REPORT*

\`\`\`
${stdout.trim() || 'UFW is inactive'}
\`\`\`

*Commands:*
- \`/allow <port>\` - Buka port
- \`/deny <port>\` - Tutup port`;
        
        ctx.editMessageText(msg, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    });
});

bot.command('allow', (ctx) => {
    const port = ctx.message.text.split(' ')[1];
    if (!port) return ctx.reply('⚠️ Masukkan port. Contoh: `/allow 8080`', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
    });
    
    ctx.reply(`🛡️ Mencoba membuka port *${port}*...`, { parse_mode: 'Markdown' });
    if (shell.exec(`sudo ufw allow ${port}`).code === 0) {
        ctx.reply(`✅ Port *${port}* berhasil dibuka!`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    } else {
        ctx.reply(`❌ Gagal membuka port *${port}*.`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    }
});

bot.command('deny', (ctx) => {
    const port = ctx.message.text.split(' ')[1];
    if (!port) return ctx.reply('⚠️ Masukkan port. Contoh: `/deny 8080`', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
    });
    
    ctx.reply(`🛡️ Mencoba menutup port *${port}*...`, { parse_mode: 'Markdown' });
    if (shell.exec(`sudo ufw deny ${port}`).code === 0) {
        ctx.reply(`✅ Port *${port}* berhasil ditutup!`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    } else {
        ctx.reply(`❌ Gagal menutup port *${port}*.`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    }
});

// --- SSL Manager (Certbot) Action ---
bot.action('status_ssl', async (ctx) => {
    ctx.editMessageText('📜 *SSL MANAGER*\n\nMengecek sertifikat SSL...', { parse_mode: 'Markdown' });
    
    shell.exec('sudo certbot certificates', { silent: true }, (code, stdout, stderr) => {
        if (code !== 0) {
            if (stderr.includes('not found')) {
                return ctx.editMessageText('❌ `certbot` belum terinstall di VPS.', {
                    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
                });
            }
            return ctx.editMessageText(`❌ Gagal mengambil info SSL:\n${stderr}`, {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }
        
        const msg = `📜 *SSL CERTIFICATES REPORT*

\`\`\`
${stdout.trim() || 'Tidak ada sertifikat ditemukan'}
\`\`\`

*Commands:*
- \`/ssl_renew\` - Perbarui semua sertifikat`;
        
        ctx.editMessageText(msg, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    });
});

bot.command('ssl_renew', (ctx) => {
    ctx.reply('⏳ Memulai proses pembaruan SSL...', { parse_mode: 'Markdown' });
    shell.exec('sudo certbot renew', { silent: true }, (code, stdout, stderr) => {
        if (code === 0) {
            ctx.reply(`✅ *SSL Renewed!*\n\n\`\`\`\n${stdout}\n\`\`\``, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        } else {
            ctx.reply(`❌ Gagal memperbarui SSL:\n${stderr}`, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }
    });
});

// --- Database Health Check Action ---
bot.action('status_db', async (ctx) => {
    await ctx.editMessageText('🗄️ *DATABASE HEALTH CHECK*\n\nMengecek status database...', { parse_mode: 'Markdown' });
    
    // List of common databases to check
    const dbs = ['mysql', 'mariadb', 'postgresql', 'mongod', 'redis-server'];
    let msg = '🗄️ *DATABASE STATUS*\n\n';
    let found = false;

    for (const db of dbs) {
        // Check if service exists first
        const checkService = shell.exec(`systemctl list-unit-files ${db}.service`, { silent: true });
        
        if (checkService.stdout.includes(db)) {
            found = true;
            const status = shell.exec(`systemctl is-active ${db}`, { silent: true }).stdout.trim();
            const icon = status === 'active' ? '🟢' : '🔴';
            
            // Get memory usage if active
            let mem = '';
            if (status === 'active') {
                // Try to get RAM usage via ps
                // Warning: This is a rough estimate based on process name
                const memCmd = `ps -C ${db.replace('.service','')} -o %mem,rss --no-headers | awk '{sum+=$2} END {print sum/1024 " MB"}'`;
                const memUsage = shell.exec(memCmd, { silent: true }).stdout.trim();
                if (memUsage) mem = `(RAM: ${memUsage})`;
            }

            msg += `${icon} *${db}*: ${status.toUpperCase()} ${mem}\n`;
        }
    }

    if (!found) {
        msg += '⚠️ Tidak ada database umum (MySQL, Mongo, Postgres, Redis) yang terdeteksi via systemd.\n';
    }

    msg += `\n*Commands:*
- \`/db_restart <name>\` - Restart database
(Contoh: \`/db_restart mysql\`)`;

    ctx.editMessageText(msg, { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
    });
});

bot.command('db_restart', (ctx) => {
    const db = ctx.message.text.split(' ')[1];
    if (!db) return ctx.reply('⚠️ Masukkan nama service. Contoh: `/db_restart mysql`', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
    });
    
    ctx.reply(`🔄 Merestart database *${db}*...`, { parse_mode: 'Markdown' });
    if (shell.exec(`sudo systemctl restart ${db}`).code === 0) {
        ctx.reply(`✅ Database *${db}* berhasil direstart!`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    } else {
        ctx.reply(`❌ Gagal restart *${db}*. Cek nama service atau logs.`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    }
});

// --- Docker Monitor Action ---
bot.action('status_docker', async (ctx) => {
    // Check if docker is installed
    if (!shell.which('docker')) {
        return ctx.editMessageText('❌ Docker tidak terinstall di VPS ini.', {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    }

    await ctx.editMessageText('🐳 *DOCKER MONITOR*\n\nMengambil data container...', { parse_mode: 'Markdown' });

    // Get Containers
    shell.exec('docker ps -a --format "table {{.Names}}\\t{{.Status}}\\t{{.ID}}"', { silent: true }, (code, stdout, stderr) => {
        if (code !== 0) return ctx.editMessageText(`❌ Error Docker:\n${stderr}`, {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });

        const containers = stdout.trim();
        
        // Get Stats (CPU/RAM) - non streaming
        shell.exec('docker stats --no-stream --format "table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}"', { silent: true }, (c, out, err) => {
            
            let statsMsg = '';
            if (c === 0) {
                statsMsg = `\n*Resource Usage:*\n\`\`\`\n${out.trim()}\n\`\`\``;
            }

            const msg = `🐳 *CONTAINER LIST*

\`\`\`
${containers}
\`\`\`
${statsMsg}

*Commands:*
- \`/docker_start <name>\`
- \`/docker_stop <name>\`
- \`/docker_restart <name>\``;

            // Handle long messages
            if (msg.length > 4000) {
                ctx.editMessageText(msg.substring(0, 4000) + '\n...', { 
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
                });
            } else {
                ctx.editMessageText(msg, { 
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
                });
            }
        });
    });
});

bot.command('docker_start', (ctx) => {
    const name = ctx.message.text.split(' ')[1];
    if (!name) return ctx.reply('⚠️ Masukkan nama container.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
    });
    shell.exec(`docker start ${name}`, (code) => {
        ctx.reply(code === 0 ? `✅ Container *${name}* started.` : `❌ Gagal start *${name}*.`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    });
});

bot.command('docker_stop', (ctx) => {
    const name = ctx.message.text.split(' ')[1];
    if (!name) return ctx.reply('⚠️ Masukkan nama container.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
    });
    shell.exec(`docker stop ${name}`, (code) => {
        ctx.reply(code === 0 ? `✅ Container *${name}* stopped.` : `❌ Gagal stop *${name}*.`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    });
});

bot.command('docker_restart', (ctx) => {
    const name = ctx.message.text.split(' ')[1];
    if (!name) return ctx.reply('⚠️ Masukkan nama container.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
    });
    shell.exec(`docker restart ${name}`, (code) => {
        ctx.reply(code === 0 ? `✅ Container *${name}* restarted.` : `❌ Gagal restart *${name}*.`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    });
});

// --- Update Apps Manager ---
bot.action('list_updates', (ctx) => {
    ctx.editMessageText('🔄 *UPDATE MANAGER*\n\nSedang mengambil daftar aplikasi dari PM2...', { parse_mode: 'Markdown' });

    // Get PM2 list in JSON format to get paths
    shell.exec('pm2 jlist', { silent: true }, (code, stdout, stderr) => {
        if (code !== 0) return ctx.editMessageText('❌ Gagal mengambil data PM2.', {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });

        try {
            const list = JSON.parse(stdout);
            if (list.length === 0) return ctx.editMessageText('📭 Tidak ada aplikasi aktif di PM2.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });

            const buttons = [];
            list.forEach(app => {
                // Create button for each app: Name (ID)
                // Callback data format: update_app:<name>
                buttons.push([Markup.button.callback(`🚀 Update ${app.name}`, `update_app:${app.name}`)]);
            });
            
            // Add cancel button
            buttons.push([Markup.button.callback('❌ Cancel', 'delete_msg'), Markup.button.callback('⬅️ Kembali', 'back_to_main')]);

            ctx.editMessageText('📦 *Pilih Aplikasi untuk Di-Update:*\n\nBot akan melakukan:\n1. `git pull` (ambil code terbaru)\n2. `pm2 restart` (restart app)', {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            });

        } catch (e) {
            console.error(e);
            ctx.editMessageText('❌ Error parsing data aplikasi.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }
    });
});

// Handle Update Action (Regex to capture app name)
bot.action(/update_app:(.+)/, async (ctx) => {
    const appName = ctx.match[1];
    
    // Helper for async shell exec with CWD support
    const execPromise = (cmd, cwd) => {
        return new Promise((resolve) => {
            // Use native child_process exec for better CWD handling on Windows
            exec(cmd, { cwd: cwd }, (error, stdout, stderr) => {
                resolve({ 
                    code: error ? error.code || 1 : 0, 
                    stdout: stdout || '', 
                    stderr: stderr || '' 
                });
            });
        });
    };

    try {
        await ctx.editMessageText(`⏳ *Memulai Update: ${appName}*...`, { parse_mode: 'Markdown' });

        // 1. Get App Path from PM2 (Use shell.exec for simple commands)
        // pm2 jlist is global, so no cwd needed
        const pm2Res = await new Promise(r => shell.exec('pm2 jlist', { silent: true }, (c, o, e) => r({code:c, stdout:o, stderr:e})));
        
        if (pm2Res.code !== 0) throw new Error('Gagal mengambil data PM2');

        const list = JSON.parse(pm2Res.stdout);
        const app = list.find(p => p.name === appName);
        
        if (!app) {
            return ctx.editMessageText(`❌ Aplikasi *${appName}* tidak ditemukan di PM2.`, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }

        const appPath = app.pm2_env.pm_cwd;
        
        // 2. Execute GIT PULL
        await ctx.editMessageText(`⏳ *Update: ${appName}*\n\n📂 Folder: \`${appPath}\`\n⬇️ Menjalankan git pull...`, { parse_mode: 'Markdown' });
        
        // Check if git exists in the folder
        if (!fs.existsSync(path.join(appPath, '.git'))) {
             return ctx.editMessageText(`❌ Folder \`${appPath}\` bukan git repository!`, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }

        // Run git pull with specific CWD
        const gitRes = await execPromise('git pull', appPath);
        const output = (gitRes.stdout + '\n' + gitRes.stderr).trim();

        // Check result
        if (output.includes('Already up to date')) {
            return ctx.editMessageText(`✅ *Update Selesai: ${appName}*\n\nRepo sudah versi terbaru. Tidak ada perubahan.`, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }

        if (gitRes.code !== 0) {
            let reason = 'Unknown Error';
            if (output.includes('Conflict')) reason = '⚠️ Merge Conflict (Harus fix manual)';
            else if (output.includes('Permission denied')) reason = '🚫 Permission Denied (Cek SSH Key)';
            else if (output.includes('Could not resolve host')) reason = '🌐 Network Error / Timeout';
            else if (output.includes('Please commit your changes')) reason = '⚠️ Ada perubahan lokal yang belum di-commit. (Coba stash atau commit dulu)';
            else if (output.includes('not a git repository')) reason = '⚠️ Folder bukan git repository';
            else if (output.includes('dubious ownership')) reason = '⚠️ Owner folder berbeda (Git security)';
            
            return ctx.editMessageText(`❌ *Git Pull Gagal!*\n\n*Alasan:* ${reason}\n\n*Log Detail:*\n\`\`\`\n${output.substring(0, 1000)}\n\`\`\``, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }

        // 3. Success Update -> Restart PM2
        const gitStatus = gitRes.stdout.trim().substring(0, 200);
        await ctx.editMessageText(`⏳ *Update: ${appName}*\n\n✅ Git Pull Berhasil!\n🔄 Restarting PM2 process...`, { parse_mode: 'Markdown' });
        
        const pm2Restart = await execPromise(`pm2 restart ${appName}`, appPath);
        
        if (pm2Restart.code === 0) {
            ctx.editMessageText(`🎉 *UPDATE SUKSES!* ✅\n\n📦 App: *${appName}*\n📝 Git: _${gitStatus}_\n🔄 PM2: Restarted`, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        } else {
            ctx.editMessageText(`⚠️ *Git berhasil, tapi PM2 Restart gagal.*\nError: ${pm2Restart.stderr}`, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }

    } catch (e) {
        console.error(e);
        ctx.editMessageText(`❌ Terjadi kesalahan sistem saat update.\n${e.message}`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    }
});

// Helper to delete message
bot.action('delete_msg', (ctx) => {
    ctx.deleteMessage();
});

bot.action('status_sys', async (ctx) => {
    try {
        const os = await si.osInfo();
        const time = await si.time();
        
        ctx.editMessageText(
            `ℹ️ *System Information*

*Hostname:* ${os.hostname}
*Platform:* ${os.platform}
*Distro:* ${os.distro} ${os.release}
*Kernel:* ${os.kernel}
*Arch:* ${os.arch}

*Uptime:* ${(time.uptime / 3600).toFixed(2)} hours
*Time:* ${new Date(time.current).toLocaleString()}`,
            { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'status_sys')],
                    [Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]
                ])
            }
        );
    } catch (e) {
        ctx.editMessageText('❌ Gagal mengambil system info.', {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    }
});

// --- Deployment & Management Commands ---

bot.command('deploy', async (ctx) => {
    const args = ctx.message.text.split(' ');
    // /deploy <name> <repo> <port>
    if (args.length !== 4) {
        return ctx.reply('⚠️ Format salah!\nGunakan: `/deploy <name> <repo_url> <port>`', { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    }

    const [_, name, repo, port] = args;
    const appPath = path.join(APPS_DIR, name);

    ctx.reply(`🚀 Memulai deployment untuk *${name}*...\nRepo: ${repo}\nPort: ${port}`, { parse_mode: 'Markdown' });

    try {
        // 1. Check if app already exists
        if (fs.existsSync(appPath)) {
            return ctx.reply(`❌ Aplikasi ${name} sudah ada! Gunakan nama lain atau delete terlebih dahulu.`, {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }

        // 2. Clone Repo
        ctx.reply('📥 Cloning repository...');
        if (shell.exec(`git clone ${repo} ${appPath}`).code !== 0) {
            throw new Error('Git clone failed');
        }

        // 3. Install Dependencies
        ctx.reply('📦 Installing dependencies (ini mungkin memakan waktu)...');
        // Detect package.json or requirements.txt
        if (fs.existsSync(path.join(appPath, 'package.json'))) {
            if (shell.exec(`cd ${appPath} && npm install`).code !== 0) {
                throw new Error('NPM Install failed');
            }
        } else if (fs.existsSync(path.join(appPath, 'requirements.txt'))) {
             if (shell.exec(`cd ${appPath} && pip install -r requirements.txt`).code !== 0) {
                throw new Error('Pip Install failed');
            }
        }

        // 4. Start with PM2
        ctx.reply('🔥 Starting process with PM2...');
        let script = 'index.js'; // Default
        const pkgPath = path.join(appPath, 'package.json');
        
        if (fs.existsSync(pkgPath)) {
            const pkg = require(pkgPath);
            script = pkg.main || 'index.js';
            if (pkg.scripts && pkg.scripts.start) {
                // If it's a Next.js or complex app, use npm start
                script = 'npm -- start';
            }
        }

        // PM2 Command
        const pm2Cmd = `pm2 start ${script} --name ${name} --cwd ${appPath} --port ${port}`;
        // Note: passing port via env usually works better: PORT=3000 pm2 start ...
        // Let's try to set PORT env
        const startCmd = `cd ${appPath} && PORT=${port} pm2 start ${script} --name ${name}`;
        
        if (shell.exec(startCmd).code !== 0) {
            throw new Error('PM2 Start failed');
        }
        shell.exec('pm2 save');

        // 5. Setup Nginx (Reverse Proxy)
        ctx.reply('🌐 Configuring Nginx...');
        const nginxConfig = `
server {
    listen 80;
    server_name ${name}.${VPS_IP}.nip.io;

    location / {
        proxy_pass http://localhost:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
`;
        const configPath = path.join(NGINX_AVAILABLE, name);
        fs.writeFileSync(configPath, nginxConfig); // Might need sudo
        
        // Enable site
        shell.exec(`ln -s ${configPath} ${path.join(NGINX_ENABLED, name)}`);
        
        // Reload Nginx
        if (shell.exec('sudo systemctl reload nginx').code !== 0) {
            ctx.reply('⚠️ Gagal reload Nginx. Cek config manual.');
        }

        ctx.reply(`✅ *Deployment Berhasil!* 🎉\n\nApp: ${name}\nURL: http://${name}.${VPS_IP}.nip.io`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });

    } catch (err) {
        console.error(err);
        ctx.reply(`❌ Deployment Gagal:\n${err.message}`, {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
        // Cleanup if possible?
    }
});

bot.command('list', (ctx) => {
    shell.exec('pm2 jlist', { silent: true }, (code, stdout, stderr) => {
        if (code !== 0) return ctx.reply('❌ Gagal mengambil list PM2.', {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
        
        try {
            const list = JSON.parse(stdout);
            if (list.length === 0) return ctx.reply('📭 Tidak ada aplikasi yang berjalan.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
            
            let msg = '📋 *Active Applications:*\n\n';
            list.forEach(proc => {
                const status = proc.pm2_env.status === 'online' ? '🟢' : '🔴';
                const memory = formatBytes(proc.monit.memory);
                const cpu = proc.monit.cpu;
                const uptime = ((Date.now() - proc.pm2_env.pm_uptime) / 3600000).toFixed(1) + 'h';
                
                msg += `${status} *${proc.name}* (ID: ${proc.pm_id})\n`;
                msg += `   CPU: ${cpu}% | Mem: ${memory}\n`;
                msg += `   Uptime: ${uptime} | Restarts: ${proc.pm2_env.restart_time}\n\n`;
            });
            
            ctx.reply(msg, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'list_apps')],
                    [Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]
                ])
            });
        } catch (e) {
            ctx.reply('❌ Error parsing PM2 data.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }
    });
});

bot.action('list_apps', (ctx) => {
    // Reuse list logic or call command
    shell.exec('pm2 jlist', { silent: true }, (code, stdout, stderr) => {
        if (code !== 0) return ctx.editMessageText('❌ Gagal mengambil list PM2.', {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
        
        try {
            const list = JSON.parse(stdout);
            if (list.length === 0) return ctx.editMessageText('📭 Tidak ada aplikasi yang berjalan.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
            
            let msg = '📋 *Active Applications:*\n\n';
            list.forEach(proc => {
                const status = proc.pm2_env.status === 'online' ? '🟢' : '🔴';
                msg += `${status} *${proc.name}*\n`;
            });
            
            ctx.editMessageText(msg, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🔄 Refresh', 'list_apps')],
                    [Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]
                ])
            });
        } catch (e) {
            ctx.editMessageText('❌ Error parsing PM2 data.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }
    });
});

bot.command('stop', (ctx) => {
    const name = ctx.message.text.split(' ')[1];
    if (!name) return ctx.reply('⚠️ Masukkan nama app. Contoh: `/stop myapp`', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
    });
    
    if (shell.exec(`pm2 stop ${name}`).code === 0) {
        ctx.reply(`✅ App *${name}* stopped.`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    } else {
        ctx.reply(`❌ Gagal stop app *${name}*.`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    }
});

bot.command('restart', (ctx) => {
    const name = ctx.message.text.split(' ')[1];
    if (!name) return ctx.reply('⚠️ Masukkan nama app. Contoh: `/restart myapp`', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
    });
    
    if (shell.exec(`pm2 restart ${name}`).code === 0) {
        ctx.reply(`✅ App *${name}* restarted.`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    } else {
        ctx.reply(`❌ Gagal restart app *${name}*.`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    }
});

bot.command('delete', (ctx) => {
    const name = ctx.message.text.split(' ')[1];
    if (!name) return ctx.reply('⚠️ Masukkan nama app. Contoh: `/delete myapp`', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
    });
    
    ctx.reply(`🗑️ Menghapus aplikasi *${name}*...`, { parse_mode: 'Markdown' });
    
    // 1. PM2 Delete
    shell.exec(`pm2 delete ${name}`);
    shell.exec('pm2 save');
    
    // 2. Remove Nginx Config
    const configPath = path.join(NGINX_AVAILABLE, name);
    const enabledPath = path.join(NGINX_ENABLED, name);
    if (fs.existsSync(configPath)) shell.rm(configPath);
    if (fs.existsSync(enabledPath)) shell.rm(enabledPath);
    shell.exec('sudo systemctl reload nginx');
    
    // 3. Remove Files (Optional - maybe risky to auto delete files?)
    // Let's keep files for safety or ask confirmation. 
    // The requirement says "Hapus aplikasi", implies full cleanup.
    const appPath = path.join(APPS_DIR, name);
    if (fs.existsSync(appPath)) {
        shell.rm('-rf', appPath);
        ctx.reply(`✅ Folder aplikasi dihapus.`);
    }
    
    ctx.reply(`✅ Aplikasi *${name}* berhasil dihapus dari PM2 dan Nginx.`, { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
    });
});

bot.command('logs', (ctx) => {
    const args = ctx.message.text.split(' ');
    const name = args[1];
    const lines = args[2] || 50;
    
    if (!name) return ctx.reply('⚠️ Masukkan nama app. Contoh: `/logs myapp 20`', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
    });
    
    // PM2 logs are usually in ~/.pm2/logs/
    // We can try to use pm2 logs command but it streams. 
    // Better to read log file directly if we can find it.
    // Or use `pm2 logs <name> --lines <lines> --nostream`
    
    shell.exec(`pm2 logs ${name} --lines ${lines} --nostream`, { silent: true }, (code, stdout, stderr) => {
         // PM2 logs output is sometimes mixed. 
         // Let's just try to read the log file path from pm2 jlist
         
         shell.exec(`pm2 jlist`, { silent: true }, (c, out, err) => {
             try {
                 const list = JSON.parse(out);
                 const app = list.find(p => p.name === name);
                 if (!app) return ctx.reply(`❌ App ${name} tidak ditemukan.`, {
                    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
                 });
                 
                 const logFile = app.pm2_env.pm_out_log_path;
                 const errFile = app.pm2_env.pm_err_log_path;
                 
                 // Read last N lines
                 const logs = shell.tail({'-n': lines}, logFile);
                 
                 if (logs.length > 4000) {
                     // Split if too long
                     ctx.reply(`📜 *Logs for ${name} (truncated):*\n\n` + logs.substring(0, 4000), { 
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
                     });
                 } else {
                     ctx.reply(`📜 *Logs for ${name}:*\n\n` + logs, { 
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
                     });
                 }
                 
             } catch (e) {
                 ctx.reply('❌ Gagal mengambil logs.', {
                    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
                 });
             }
         });
    });
});

// Launch Bot
bot.launch().then(() => {
    console.log('🤖 Bot started!');
}).catch((err) => {
    console.error('❌ Bot failed to start', err);
});

// Graceful Stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
