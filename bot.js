require('dotenv').config();
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const si = require('systeminformation');
const shell = require('shelljs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');
// const puppeteer = require('puppeteer'); // Disable puppeteer by default to avoid MODULE_NOT_FOUND on startup

// Configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const VPS_IP = process.env.VPS_IP;
const AUTHORIZED_USERS = (process.env.AUTHORIZED_USER || '')
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

if (AUTHORIZED_USERS.length === 0) {
    console.warn('⚠️ Warning: No valid AUTHORIZED_USER found in .env');
}

// App Directories
const APPS_DIR = '/var/www';
const NGINX_AVAILABLE = '/etc/nginx/sites-available';
const NGINX_ENABLED = '/etc/nginx/sites-enabled';

const net = require('net');

// Helper to find available port
const getAvailablePort = async (startPort = 3000) => {
    const isPortAvailable = (port) => {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    resolve(false);
                } else {
                    resolve(false); // Other error, assume unsafe
                }
            });
            server.once('listening', () => {
                server.close(() => {
                    resolve(true);
                });
            });
            server.listen(port);
        });
    };

    let port = startPort;
    while (true) {
        if (await isPortAvailable(port)) {
            return port;
        }
        port++;
        if (port > 65535) throw new Error('No ports available');
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
        
        // Validation
        if (!repo.startsWith('http') && !repo.startsWith('git@')) {
            return ctx.reply('⚠️ Link tidak valid. Gunakan format HTTPS atau SSH (git@...).');
        }
        
        ctx.wizard.state.data.repo = repo;
        
        ctx.reply('📝 *Nama Aplikasi*\n\nBerikan nama untuk aplikasi ini (tanpa spasi).\n(Contoh: my-api)', { parse_mode: 'Markdown' });
        return ctx.wizard.next();
    },
    // Step 3: Ask for Domain Preference
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply('⚠️ Harap kirimkan nama valid.');
        const name = ctx.message.text.trim().replace(/\s+/g, '-').toLowerCase();
        
        // Check if name exists
        if (fs.existsSync(path.join(APPS_DIR, name))) {
            ctx.reply(`⚠️ Aplikasi dengan nama *${name}* sudah ada! Silakan ulangi /deploy atau gunakan nama lain.`, { parse_mode: 'Markdown' });
            return ctx.scene.leave();
        }
        
        ctx.wizard.state.data.name = name;

        // Ask about domain
        ctx.reply('🌐 *Pengaturan Domain*\n\nApakah Anda memiliki domain sendiri?\n\n- **Ya**: Gunakan domain custom (cth: `myapp.com`).\n- **Tidak**: Gunakan auto domain (cth: `myapp.ip.nip.io`).', 
            Markup.keyboard([['✅ Ya, Punya', '❌ Tidak, Pakai Auto (nip.io)']]).oneTime().resize()
        );
        return ctx.wizard.next();
    },
    // Step 4: Handle Domain Input
    (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply('⚠️ Silakan pilih Ya atau Tidak.');
        const answer = ctx.message.text;

        if (answer.includes('Tidak')) {
            // Auto Domain
            ctx.wizard.state.data.domain_mode = 'auto';
            ctx.reply('✅ Menggunakan **Auto Domain** (nip.io).', { parse_mode: 'Markdown', ...Markup.removeKeyboard() });
            
            // Skip next step (custom domain input)
            ctx.wizard.selectStep(4);
            return ctx.wizard.steps[4](ctx);
        } else {
            // Custom Domain
            ctx.wizard.state.data.domain_mode = 'custom';
            ctx.reply('📝 *Masukkan Nama Domain Anda*\n\nPastikan Anda sudah membuat **A Record** di DNS Manager yang mengarah ke IP VPS ini.\n\nContoh: `myapp.com` atau `api.mysite.com`', { parse_mode: 'Markdown', ...Markup.removeKeyboard() });
            return ctx.wizard.next();
        }
    },
    // Step 5: Get Custom Domain & Execute
    (ctx) => {
        if (ctx.wizard.state.data.domain_mode === 'custom') {
             if (!ctx.message || !ctx.message.text) return ctx.reply('⚠️ Harap kirimkan nama domain valid.');
             const domain = ctx.message.text.trim().toLowerCase();
             // Simple regex validation
             if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
                 return ctx.reply('⚠️ Format domain tidak valid. Contoh: `example.com`');
             }
             ctx.wizard.state.data.domain = domain;
        }

        return ctx.wizard.steps[5](ctx); // Go to actual deployment step (index 5)
    },
    // Step 6: Deployment Process
    async (ctx) => {
        // Remove keyboard just in case
        
        const { name, repo } = ctx.wizard.state.data;
        
        // AUTO PORT DETECTION
        const statusMsg = await ctx.reply('🔍 Mencari port yang tersedia...', Markup.removeKeyboard());
        
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
        
        // Determine Domain
        let domain = '';
        if (ctx.wizard.state.data.domain_mode === 'custom') {
            domain = ctx.wizard.state.data.domain;
        } else {
            domain = `${name}.${VPS_IP}.nip.io`;
        }
        
        // Start Deployment Process
        await updateStatus(`⚙️ *Memulai Deployment...*\n\n📦 App: ${name}\n🔗 Repo: ${repo}\n🌐 Domain: ${domain}\n🔌 Port: ${port}`);
        
        const appPath = path.join(APPS_DIR, name);
        
        try {
            // 1. Clone
            await updateStatus(`⚙️ *Deployment: ${name}*\n\n📥 Cloning repository...`);
            const cloneRes = shell.exec(`git clone ${repo} ${appPath}`, { silent: true });
            if (cloneRes.code !== 0) {
                throw new Error(`Git Clone Failed:\n${cloneRes.stderr}`);
            }

            // 2. Detect App Type & Install Dependencies
            await updateStatus(`⚙️ *Deployment: ${name}*\n\n🔍 Detecting application type...`);
            
            let isStatic = false;
            let script = 'index.js';
            const pkgPath = path.join(appPath, 'package.json');
            
            if (fs.existsSync(pkgPath)) {
                const pkg = require(pkgPath);
                script = pkg.main || 'index.js';
                if (pkg.scripts && pkg.scripts.start) script = 'npm -- start';
            }

            // Check if the script exists
            const scriptPath = script.includes('npm --') ? pkgPath : path.join(appPath, script);
            if (!fs.existsSync(scriptPath) && !script.includes('npm --')) {
                isStatic = true;
            }

            if (!isStatic) {
                await updateStatus(`⚙️ *Deployment: ${name}*\n\n📦 Installing dependencies...`);
                let installCmd = '';
                
                if (fs.existsSync(pkgPath)) {
                    installCmd = `cd ${appPath} && npm install`;
                } else if (fs.existsSync(path.join(appPath, 'requirements.txt'))) {
                    installCmd = `cd ${appPath} && pip install -r requirements.txt`;
                }
                
                if (installCmd) {
                    const installRes = shell.exec(installCmd, { silent: true });
                    if (installRes.code !== 0) {
                        throw new Error(`Install Failed:\n${installRes.stderr.substring(0, 500)}...`);
                    }
                }

                // 3. Start PM2 (Backend)
                await updateStatus(`⚙️ *Deployment: ${name}*\n\n🔥 Starting backend process...`);
                const startCmd = `cd ${appPath} && PORT=${port} pm2 start ${script} --name ${name}`;
                const startRes = shell.exec(startCmd, { silent: true });
                if (startRes.code !== 0) {
                    throw new Error(`PM2 Start Failed:\n${startRes.stderr}`);
                }
            } else {
                // 3. Start PM2 (Static)
                await updateStatus(`⚙️ *Deployment: ${name}*\n\n🌐 Starting static web server...`);
                
                if (!shell.which('serve')) {
                    shell.exec('npm install -g serve', { silent: true });
                }
                
                const staticCmd = `pm2 start serve --name ${name} -- -s ${appPath} -l ${port}`;
                const staticRes = shell.exec(staticCmd, { silent: true });
                if (staticRes.code !== 0) {
                    throw new Error(`Static Deploy Failed:\n${staticRes.stderr}`);
                }
            }
            shell.exec('pm2 save');

            // 4. Setup Nginx & SSL
            await updateStatus(`⚙️ *Deployment: ${name}*\n\n🌐 Configuring Nginx & SSL...`);
            
            // Clean up old configs first
            const configPath = path.join(NGINX_AVAILABLE, name);
            const enabledPath = path.join(NGINX_ENABLED, name);
            if (fs.existsSync(configPath)) shell.rm(configPath);
            if (fs.existsSync(enabledPath)) shell.rm(enabledPath);

            // Nginx Config for HTTP (Port 80)
            const nginxConfig = `
server {
    listen 80;
    server_name ${domain};

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
            fs.writeFileSync(configPath, nginxConfig);
            shell.exec(`ln -s ${configPath} ${enabledPath}`);
            
            const nginxReload = shell.exec('sudo systemctl reload nginx');
            if (nginxReload.code !== 0) {
                 await updateStatus('⚠️ Nginx reload failed. Cek config manual.');
            }

            // 5. Auto SSL with Certbot
            await updateStatus(`⚙️ *Deployment: ${name}*\n\n🔒 Requesting SSL Certificate...`);
            
            // Check if certbot is installed
            if (!shell.which('certbot')) {
                await updateStatus('⚠️ Certbot tidak ditemukan. Menginstall certbot...');
                shell.exec('sudo apt-get install certbot python3-certbot-nginx -y', { silent: true });
            }

            // Run Certbot
            const certCmd = `sudo certbot --nginx -d ${domain} --non-interactive --agree-tos --redirect -m admin@${domain}`;
            const certRes = shell.exec(certCmd, { silent: true });
            
            let finalUrl = `http://${domain}`;
            let sslStatus = '❌ SSL Failed';

            if (certRes.code === 0) {
                finalUrl = `https://${domain}`;
                sslStatus = '✅ SSL Secured';
            } else {
                console.error('Certbot Error:', certRes.stderr);
                sslStatus = '⚠️ SSL Failed (Check Logs)';
            }

            await updateStatus(`✅ *DEPLOYMENT SUCCESS!* 🎉\n\n🌍 URL: ${finalUrl}\n🔒 Status: ${sslStatus}\n🔌 Port: ${port}`);
            
        } catch (err) {
            console.error(err);
            // Cleanup: remove folder if failed
            if (fs.existsSync(appPath)) shell.rm('-rf', appPath);
            
            await updateStatus(`❌ *DEPLOYMENT GAGAL!* 😭\n\nError Detail:\n\`${err.message}\`\n\nFolder aplikasi telah dibersihkan. Silakan coba lagi.`);
        }

        return ctx.scene.leave();
    }
);

// --- SCREENSHOT WIZARD ---
const screenshotWizard = new Scenes.WizardScene(
    'screenshot_wizard',
    // Step 1: Ask for URL
    (ctx) => {
        ctx.reply('📸 *SCREENSHOT WEB*\n\nSilakan kirimkan URL website yang ingin di-screenshot.\n(Contoh: https://google.com)', { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('❌ Batal', 'cancel_ss')]
            ])
        });
        return ctx.wizard.next();
    },
    // Step 2: Process URL
    async (ctx) => {
        // Handle Cancel
        if (ctx.callbackQuery && ctx.callbackQuery.data === 'cancel_ss') {
            await ctx.answerCbQuery();
            ctx.reply('❌ Screenshot dibatalkan.', Markup.removeKeyboard());
            return ctx.scene.leave();
        }

        if (!ctx.message || !ctx.message.text) {
            ctx.reply('⚠️ Harap kirimkan URL valid.');
            return;
        }

        let url = ctx.message.text.trim();
        if (!url.startsWith('http')) url = `http://${url}`;

        const statusMsg = await ctx.reply(`📸 *Taking Screenshot...*\n\n🔗 ${url}\n🖥️ Mode: Desktop (1920x1080)`, { parse_mode: 'Markdown' });

        try {
            // Dynamic import for puppeteer
            let puppeteer;
            try {
                puppeteer = require('puppeteer');
            } catch (e) {
                ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
                ctx.reply('❌ Module `puppeteer` belum terinstall.\nSilakan jalankan `npm install puppeteer` di VPS.', {
                    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'show_more_menu')]])
                });
                return ctx.scene.leave();
            }

            const browser = await puppeteer.launch({
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
                headless: 'new'
            });
            const page = await browser.newPage();
            
            await page.setViewport({ width: 1920, height: 1080 });
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
            
            // Use os.tmpdir() to avoid triggering PM2 watch restart
            const screenshotPath = path.join(os.tmpdir(), `ss_${Date.now()}.png`);
            await page.screenshot({ path: screenshotPath, fullPage: false });
            
            await browser.close();
            
            // Send Photo
            await ctx.replyWithPhoto({ source: screenshotPath }, {
                caption: `📸 Screenshot: ${url}`,
                reply_to_message_id: ctx.message.message_id
            });
            
            // Cleanup
            fs.unlinkSync(screenshotPath);
            ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

        } catch (e) {
            console.error(e);
            ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
            
            let errorMsg = `❌ Gagal mengambil screenshot:\n${e.message}`;
            let buttons = [[Markup.button.callback('⬅️ Kembali', 'show_more_menu')]];

            // Check for missing libraries error
            if (e.message.includes('shared libraries') || e.message.includes('libnss3')) {
                errorMsg += '\n\n⚠️ *Missing Dependencies Detected!*\nKlik tombol di bawah untuk menginstall library yang kurang.';
                buttons.unshift([Markup.button.callback('🛠️ Fix Dependencies (Install Libs)', 'install_puppeteer_deps')]);
            }

            ctx.reply(errorMsg, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            });
        }

        return ctx.scene.leave();
    }
);

// --- SHELL WIZARD ---
const shellWizard = new Scenes.WizardScene(
    'shell_wizard',
    (ctx) => {
        ctx.reply('💻 *TERMINAL MODE*\n\nKetik perintah Linux apa saja (seperti di SSH).\nKetik `exit` atau `cancel` untuk keluar.\n\n⚠️ *Warning:* Hati-hati dengan perintah berbahaya (rm -rf, reboot, dll).', { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('❌ Exit Terminal', 'cancel_shell')]
            ])
        });
        return ctx.wizard.next();
    },
    async (ctx) => {
        // Check for cancel callback
        if (ctx.callbackQuery && ctx.callbackQuery.data === 'cancel_shell') {
            await ctx.answerCbQuery();
            ctx.reply('🚪 Terminal Mode ditutup.', Markup.removeKeyboard());
            return ctx.scene.leave();
        }

        if (!ctx.message || !ctx.message.text) return;
        const cmd = ctx.message.text.trim();
        
        if (['exit', 'cancel', '/cancel'].includes(cmd.toLowerCase())) {
            ctx.reply('🚪 Terminal Mode ditutup.');
            return ctx.scene.leave();
        }

        const msg = await ctx.reply(`⏳ Executing: \`${cmd}\`...`, { parse_mode: 'Markdown' });
        
        // Execute command
        exec(cmd, { timeout: 30000, maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
            let output = (stdout || '') + (stderr || '');
            if (!output) output = 'No output';
            
            // Format output
            if (output.length > 4000) {
                const truncated = output.substring(0, 4000) + '\n... (truncated)';
                ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `💻 \`$ ${cmd}\`\n\n\`\`\`\n${truncated}\n\`\`\``, { parse_mode: 'Markdown' });
            } else {
                ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `💻 \`$ ${cmd}\`\n\n\`\`\`\n${output}\n\`\`\``, { parse_mode: 'Markdown' });
            }
        });
        
        // Stay in wizard loop
        // We don't return ctx.wizard.next() because we want to stay in this step
        // But in WizardScene, the current step handler is re-executed if we don't advance? 
        // No, in Telegraf Scenes, wizard stays in current step unless next() is called or selectStep()
        // Wait, actually wizard scenes advance automatically if we return next(). 
        // If we want to loop, we need to stay. 
        // Actually, wizard steps are linear. For a loop (REPL), we should use a simple Scene or just stay in step 1.
        // Let's use `ctx.wizard.selectStep(1)` to loop back to this handler.
        return; 
    }
);

const stage = new Scenes.Stage([deployWizard, screenshotWizard, shellWizard]);
const bot = new Telegraf(BOT_TOKEN);

// Use Session & Stage
bot.use(session());
bot.use(stage.middleware());

// Middleware for Authorization
const authMiddleware = (ctx, next) => {
    // Check if user info is available
    if (!ctx.from || !ctx.from.id) {
        // Some updates like channel_post might not have 'from'
        return; 
    }

    const userId = ctx.from.id;
    
    // Check if AUTHORIZED_USERS contains valid numbers
    if (AUTHORIZED_USERS.some(id => isNaN(id))) {
        console.error('⚠️ Configuration Error: AUTHORIZED_USER env contains invalid number');
        return ctx.reply('⚠️ System Error: Invalid Authorization Configuration');
    }

    if (AUTHORIZED_USERS.includes(userId)) {
        return next();
    }
    
    // Silent fail for unauthorized users to avoid spamming them
    // or reply once
    // return ctx.reply('⛔ Unauthorized access. Please contact admin.');
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
    [Markup.button.callback('📊 Status VPS', 'status_vps'), Markup.button.callback('� List Apps', 'list_apps')],
    [Markup.button.callback('� Speedtest', 'speedtest_run'), Markup.button.callback('📦 Deploy App', 'start_deploy')],
    [Markup.button.callback('✨ Menu Lengkap & Tools', 'show_more_menu')]
]);

const moreMenu = Markup.inlineKeyboard([
    // Monitoring Section
    [Markup.button.callback('💾 Disk', 'status_disk'), Markup.button.callback('🌐 Net', 'status_net'), Markup.button.callback('� Top CPU', 'status_top')],
    
    // App Management Section
    [Markup.button.callback('� Update Apps', 'list_updates'), Markup.button.callback('� PM2 Logs', 'list_pm2_logs'), Markup.button.callback('�️ Delete App', 'delete_menu')],
    
    // Server & Security Section
    [Markup.button.callback('🔐 Login Check', 'login_monitor'), Markup.button.callback('�️ Firewall', 'status_ufw'), Markup.button.callback('� SSL Certs', 'status_ssl')],
    
    // Tools Section
    [Markup.button.callback('�️ Database', 'status_db'), Markup.button.callback('� Docker', 'status_docker'), Markup.button.callback('� Files', 'file_manager')],
    
    // Actions Section
    [Markup.button.callback('📸 Screenshot', 'start_screenshot'), Markup.button.callback('� Backup', 'backup_menu'), Markup.button.callback('� Terminal', 'start_shell')],
    
    // System Section
    [Markup.button.callback('🌐 Cek Domain', 'list_domains'), Markup.button.callback('ℹ️ Sys Info', 'status_sys'), Markup.button.callback('⚡ Reboot', 'server_menu')],
    
    // Footer
    [Markup.button.callback('⬅️ Back to Main', 'back_to_main'), Markup.button.callback('🔄 Sys Update', 'sys_update')]
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

// --- Domain & SSL Status Checker ---
bot.action('list_domains', async (ctx) => {
    await ctx.editMessageText('🌐 *DOMAIN & SSL CHECKER*\n\nSedang memindai Nginx configs...', { parse_mode: 'Markdown' });

    // Check if Nginx directory exists
    if (!fs.existsSync(NGINX_ENABLED)) {
        return ctx.editMessageText('❌ Nginx tidak terdeteksi.\nFolder `/etc/nginx/sites-enabled` tidak ditemukan.', {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'show_more_menu')]])
        });
    }

    // 1. Scan Nginx enabled sites to get domains
    // Use grep -r to find server_name directives
    shell.exec(`grep -r "server_name" ${NGINX_ENABLED}`, { silent: true }, async (code, stdout, stderr) => {
        // grep returns exit code 1 if no matches found, which is NOT an error for us.
        // Only treat code > 1 as error (e.g. permission denied)
        if (code > 1) {
            return ctx.editMessageText(`❌ Gagal membaca Nginx configs.\nError: ${stderr}`, {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'show_more_menu')]])
            });
        }

        if (code === 1 || !stdout) {
             return ctx.editMessageText('📭 Tidak ada domain yang ditemukan di Nginx.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'show_more_menu')]])
            });
        }

        // Parse domains
        const lines = stdout.split('\n');
        const domains = [];
        
        lines.forEach(line => {
            // format: /etc/nginx/sites-enabled/myapp:    server_name myapp.com;
            if (line.includes('server_name')) {
                const parts = line.split('server_name');
                if (parts[1]) {
                    let d = parts[1].trim();
                    if (d.endsWith(';')) d = d.slice(0, -1); // remove semicolon
                    // Handle multiple domains in one line "example.com www.example.com"
                    const ds = d.split(/\s+/);
                    ds.forEach(domain => {
                        // Filter out localhost, IP addresses, catch-all _, and duplicates
                        if (domain && domain !== '_' && domain !== 'localhost' && !domains.includes(domain) && !domain.match(/^\d+\.\d+\.\d+\.\d+$/)) {
                            domains.push(domain);
                        }
                    });
                }
            }
        });

        if (domains.length === 0) {
            return ctx.editMessageText('📭 Tidak ada domain valid yang ditemukan.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'show_more_menu')]])
            });
        }

        await ctx.editMessageText(`🔎 Ditemukan ${domains.length} domain.\nSedang mengecek status SSL satu per satu...`, { parse_mode: 'Markdown' });

        let report = '🌐 *DOMAIN STATUS REPORT*\n\n';
        
        for (const domain of domains) {
            // Use simple curl without --max-time first for HTTP
            const checkHttp = shell.exec(`curl -s -o /dev/null -w "%{http_code}" http://${domain}`, { silent: true }).stdout;
            
            // Check HTTPS (SSL) with 5s timeout
            // Using -I to fetch headers only is faster
            const checkHttps = shell.exec(`curl -s -o /dev/null -I -w "%{http_code}" --max-time 5 https://${domain}`, { silent: true });
            
            let status = '';
            let icon = '';
            
            // Check if HTTPS returns valid status (200, 301, 302, 404 etc)
            // If code is 000, it means connection failed (SSL error or timeout)
            if (checkHttps.code === 0 && checkHttps.stdout !== '000') {
                icon = '🔒'; // SSL OK
                status = `SSL Active (Code: ${checkHttps.stdout})`;
            } else if (checkHttp === '000') {
                 icon = '💀'; // Down
                 status = 'Unreachable / DNS Error';
            } else {
                 icon = '🔓'; // No SSL or Error
                 status = 'No SSL / Certificate Error';
            }

            report += `${icon} *${domain}*\n`;
            report += `   └ ${status}\n\n`;
        }

        // Send Report
        if (report.length > 4000) report = report.substring(0, 4000) + '...';
        
        ctx.editMessageText(report, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Refresh', 'list_domains')],
                [Markup.button.callback('⬅️ Kembali', 'show_more_menu')]
            ])
        });
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

// --- Top Processes ---
bot.action('status_top', async (ctx) => {
    try {
        await ctx.editMessageText('📈 *Mengambil Data Proses...*', { parse_mode: 'Markdown' });
        
        const data = await si.processes();
        const list = data.list
            .sort((a, b) => b.cpu - a.cpu)
            .slice(0, 10);

        let msg = `📈 *TOP 10 PROCESSES (by CPU)*\n\n`;
        msg += `\`PID    | %CPU | %MEM | NAME\`\n`;
        msg += `\`-------+------+------+----------------\`\n`;

        list.forEach(p => {
            const pid = p.pid.toString().padEnd(7);
            const cpu = p.cpu.toFixed(1).padEnd(5);
            const mem = p.mem.toFixed(1).padEnd(5);
            const name = p.name.substring(0, 15);
            msg += `\`${pid}| ${cpu}| ${mem}| ${name}\`\n`;
        });

        msg += `\n*Commands:* \`/kill <pid>\``;

        ctx.editMessageText(msg, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Refresh', 'status_top')],
                [Markup.button.callback('⬅️ Kembali', 'show_more_menu')]
            ])
        });

    } catch (e) {
        console.error(e);
        ctx.editMessageText('❌ Gagal mengambil process list.', {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'show_more_menu')]])
        });
    }
});

bot.command('kill', (ctx) => {
    const pid = ctx.message.text.split(' ')[1];
    if (!pid) return ctx.reply('⚠️ Gunakan format: `/kill <pid>`');
    
    // Safety check: prevent killing self or init
    if (pid === '1' || pid == process.pid) return ctx.reply('⛔ Tidak bisa kill process ini.');

    shell.exec(`kill -9 ${pid}`, (code, stdout, stderr) => {
        if (code === 0) ctx.reply(`✅ Process ${pid} killed.`);
        else ctx.reply(`❌ Gagal kill ${pid}: ${stderr}`);
    });
});

// --- Server Actions (Reboot) ---
bot.action('server_menu', (ctx) => {
    ctx.editMessageText('⚡ *SERVER ACTIONS*\n\nHati-hati, aksi ini berdampak pada seluruh server.', { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Reboot Server', 'server_reboot_ask')],
            [Markup.button.callback('⬅️ Kembali', 'show_more_menu')]
        ])
    });
});

bot.action('server_reboot_ask', (ctx) => {
    ctx.editMessageText('⚠️ *KONFIRMASI REBOOT*\n\nAnda yakin ingin me-restart VPS?\nSemua aplikasi akan berhenti sementara.', { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ YA, REBOOT SEKARANG', 'server_reboot_do')],
            [Markup.button.callback('❌ BATAL', 'server_menu')]
        ])
    });
});

bot.action('server_reboot_do', (ctx) => {
    ctx.reply('🔄 *System Reboot Initiated...*\n\nBot akan offline beberapa saat. 👋');
    setTimeout(() => {
        shell.exec('sudo reboot');
    }, 1000);
});

// --- System Update Action ---
bot.action('sys_update', (ctx) => {
    ctx.editMessageText('🔄 *SYSTEM UPDATE*\n\nApakah Anda yakin ingin menjalankan `apt update && apt upgrade`?\nProses ini mungkin memakan waktu beberapa menit.', { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ Ya, Update Sekarang', 'sys_update_confirm')],
            [Markup.button.callback('❌ Batal', 'show_more_menu')]
        ])
    });
});

bot.action('sys_update_confirm', (ctx) => {
    // 1. Send initial status
    ctx.editMessageText('⏳ *System Update Sedang Berjalan...*\n\nMohon tunggu, bot akan tetap aktif. Jangan matikan VPS.', { parse_mode: 'Markdown' });

    // 2. Run update in background
    // Using nohup or just exec (Node.js keeps running)
    // We use "sudo apt-get update && sudo apt-get upgrade -y"
    // Note: This requires the user running the bot to have sudo NOPASSWD access
    
    const cmd = 'sudo apt-get update && sudo apt-get upgrade -y';
    
    exec(cmd, (error, stdout, stderr) => {
        if (error) {
            console.error(`Update error: ${error}`);
            return ctx.reply(`❌ *System Update Gagal!*\n\nError:\n\`\`\`\n${stderr.substring(0, 1000)}\n\`\`\``, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }

        // Success
        const output = stdout.substring(stdout.length - 2000); // Last 2000 chars
        ctx.reply(`✅ *System Update Selesai!*\n\nOutput Terakhir:\n\`\`\`\n${output}\n\`\`\``, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    });
});

// --- Screenshot Actions ---
bot.action('start_screenshot', (ctx) => {
    ctx.scene.enter('screenshot_wizard');
});

bot.action('install_puppeteer_deps', (ctx) => {
    ctx.reply('🛠️ *Installing Dependencies...*\n\nMohon tunggu, sedang menjalankan `apt-get install` untuk library Chrome/Puppeteer (Support Ubuntu 24.04+)...', { parse_mode: 'Markdown' });
    
    // Standard Puppeteer dependencies (Updated for Ubuntu 24.04 / Debian Trixie)
    // Replaced libasound2 -> libasound2t64, libgtk-3-0 -> libgtk-3-0t64
    const deps = "ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0t64 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils";
    
    // Fallback command: Try new packages first, if fail, try old packages (for older Ubuntu)
    const cmd = `sudo apt-get update && (sudo apt-get install -y ${deps} || sudo apt-get install -y ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils)`;
    
    exec(cmd, (error, stdout, stderr) => {
        if (error) {
            console.error(`Install error: ${error}`);
            ctx.reply(`❌ *Install Gagal!*\n\nError:\n\`\`\`\n${stderr.substring(0, 1000)}\n\`\`\``, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        } else {
            ctx.reply(`✅ *Dependencies Installed!*\n\nLibrary berhasil diinstall. Silakan coba fitur Screenshot lagi.`, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('📸 Coba Screenshot', 'start_screenshot')]])
            });
        }
    });
});

// --- PM2 Logs Manager ---
bot.action('list_pm2_logs', (ctx) => {
    ctx.editMessageText('📜 *PM2 LOGS VIEWER*\n\nSedang mengambil daftar aplikasi...', { parse_mode: 'Markdown' });

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
                buttons.push([Markup.button.callback(`📄 ${app.name}`, `view_logs:${app.name}`)]);
            });
            
            buttons.push([Markup.button.callback('⬅️ Kembali', 'show_more_menu')]);

            ctx.editMessageText('📜 *Pilih Aplikasi untuk Lihat Logs:*', {
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

bot.action(/view_logs:(.+)/, (ctx) => {
    const appName = ctx.match[1];
    const lines = 50;

    ctx.editMessageText(`⏳ Mengambil logs untuk *${appName}*...`, { parse_mode: 'Markdown' });

    shell.exec('pm2 jlist', { silent: true }, (c, out, err) => {
        try {
            const list = JSON.parse(out);
            const app = list.find(p => p.name === appName);
            
            if (!app) {
                return ctx.editMessageText(`❌ App *${appName}* tidak ditemukan.`, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'list_pm2_logs')]])
                });
            }
            
            const logFile = app.pm2_env.pm_out_log_path;
            const errFile = app.pm2_env.pm_err_log_path; // We could also offer error logs
            
            // Read last N lines
            if (!fs.existsSync(logFile)) {
                 return ctx.editMessageText(`❌ Log file tidak ditemukan:\n\`${logFile}\``, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'list_pm2_logs')]])
                });
            }

            const logs = shell.tail({'-n': lines}, logFile);
            
            const header = `📜 *Logs: ${appName}* (Last ${lines} lines)\nPath: \`${logFile}\`\n\n`;
            const footer = '\n\n_Note: Gunakan /logs <name> <lines> untuk custom lines_';

            if ((header + logs + footer).length > 4000) {
                // Truncate
                const maxLen = 4000 - header.length - footer.length - 20;
                const truncatedLogs = logs.substring(logs.length - maxLen);
                
                ctx.editMessageText(header + '```\n... ' + truncatedLogs + '\n```' + footer, { 
                   parse_mode: 'Markdown',
                   ...Markup.inlineKeyboard([
                       [Markup.button.callback('🔄 Refresh', `view_logs:${appName}`)],
                       [Markup.button.callback('⬅️ Kembali ke List', 'list_pm2_logs')]
                   ])
                });
            } else {
                ctx.editMessageText(header + '```\n' + logs + '\n```' + footer, { 
                   parse_mode: 'Markdown',
                   ...Markup.inlineKeyboard([
                       [Markup.button.callback('🔄 Refresh', `view_logs:${appName}`)],
                       [Markup.button.callback('⬅️ Kembali ke List', 'list_pm2_logs')]
                   ])
                });
            }
            
        } catch (e) {
            console.error(e);
            ctx.editMessageText('❌ Gagal mengambil logs.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'list_pm2_logs')]])
            });
        }
    });
});

// --- Delete App Manager ---
bot.action('delete_menu', (ctx) => {
    ctx.editMessageText('🗑️ *DELETE MANAGER*\n\nPilih aplikasi yang ingin dihapus permanen:', { parse_mode: 'Markdown' });

    shell.exec('pm2 jlist', { silent: true }, (code, stdout, stderr) => {
        if (code !== 0) return ctx.editMessageText('❌ Gagal mengambil data PM2.', {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });

        try {
            const list = JSON.parse(stdout);
            if (list.length === 0) return ctx.editMessageText('📭 Tidak ada aplikasi aktif.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });

            const buttons = [];
            list.forEach(app => {
                // Prevent deleting the bot itself if possible, or warn user
                const isSelf = app.name === 'vps-bot' || app.pm2_env.pm_cwd === process.cwd();
                const icon = isSelf ? '⛔' : '🗑️';
                const action = isSelf ? 'ignore' : `confirm_delete:${app.name}`;
                
                buttons.push([Markup.button.callback(`${icon} ${app.name}`, action)]);
            });
            
            buttons.push([Markup.button.callback('⬅️ Kembali', 'show_more_menu')]);

            ctx.editMessageText('🗑️ *Pilih Aplikasi untuk Dihapus:*', {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            });

        } catch (e) {
            console.error(e);
            ctx.editMessageText('❌ Error parsing data.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }
    });
});

bot.action('ignore', (ctx) => {
    ctx.answerCbQuery('⛔ Aplikasi ini tidak bisa dihapus dari sini.', { show_alert: true });
});

bot.action(/confirm_delete:(.+)/, (ctx) => {
    const appName = ctx.match[1];
    ctx.editMessageText(`⚠️ *KONFIRMASI PENGHAPUSAN*\n\nAnda yakin ingin menghapus aplikasi *${appName}*?\n\nTindakan ini akan:\n1. Stop & Delete dari PM2\n2. Hapus Config Nginx\n3. Hapus Folder Aplikasi (Permanen)`, { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('✅ YA, HAPUS PERMANEN', `do_delete:${appName}`)],
            [Markup.button.callback('❌ BATAL', 'delete_menu')]
        ])
    });
});

bot.action(/do_delete:(.+)/, (ctx) => {
    const name = ctx.match[1];
    ctx.editMessageText(`🗑️ Menghapus aplikasi *${name}*...`, { parse_mode: 'Markdown' });
    
    // 1. PM2 Delete
    shell.exec(`pm2 delete ${name}`);
    shell.exec('pm2 save');
    
    // 2. Remove Nginx Config
    const configPath = path.join(NGINX_AVAILABLE, name);
    const enabledPath = path.join(NGINX_ENABLED, name);
    if (fs.existsSync(configPath)) shell.rm(configPath);
    if (fs.existsSync(enabledPath)) shell.rm(enabledPath);
    shell.exec('sudo systemctl reload nginx');
    
    // 3. Remove Files
    const appPath = path.join(APPS_DIR, name);
    if (fs.existsSync(appPath)) {
        shell.rm('-rf', appPath);
    }
    
    ctx.editMessageText(`✅ Aplikasi *${name}* berhasil dihapus.`, { 
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'delete_menu')]])
    });
});

// --- File Manager (Simple Explorer) ---
bot.action('file_manager', (ctx) => {
    // Start from APPS_DIR
    listFiles(ctx, APPS_DIR);
});

bot.action(/fm_open:(.+)/, (ctx) => {
    const targetPath = ctx.match[1];
    listFiles(ctx, targetPath);
});

bot.action(/fm_read:(.+)/, (ctx) => {
    const filePath = ctx.match[1];
    
    // Security check: only allow reading files inside APPS_DIR or common config paths
    if (!filePath.startsWith(APPS_DIR) && !filePath.startsWith('/etc/nginx')) {
        return ctx.answerCbQuery('⛔ Akses ditolak.', { show_alert: true });
    }

    try {
        if (fs.statSync(filePath).size > 50000) { // Limit 50KB
            return ctx.reply(`⚠️ File terlalu besar untuk ditampilkan di chat.\nPath: \`${filePath}\``);
        }
        
        const content = fs.readFileSync(filePath, 'utf8');
        const filename = path.basename(filePath);
        
        // Split if too long
        if (content.length > 4000) {
            ctx.reply(`📄 *${filename}* (Truncated):\n\`\`\`\n${content.substring(0, 4000)}\n\`\`\``, { parse_mode: 'Markdown' });
        } else {
            ctx.reply(`📄 *${filename}*:\n\`\`\`\n${content}\n\`\`\``, { parse_mode: 'Markdown' });
        }
        
    } catch (e) {
        ctx.reply(`❌ Gagal membaca file: ${e.message}`);
    }
});

const listFiles = (ctx, dirPath) => {
    try {
        const items = fs.readdirSync(dirPath);
        const buttons = [];
        
        // Add ".." button if not root of APPS_DIR
        if (dirPath !== APPS_DIR && dirPath.startsWith(APPS_DIR)) {
            const parentDir = path.dirname(dirPath);
            buttons.push([Markup.button.callback('📂 .. (Up)', `fm_open:${parentDir}`)]);
        }

        // Folders first, then files
        const folders = [];
        const files = [];

        items.forEach(item => {
            try {
                const fullPath = path.join(dirPath, item);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    folders.push(item);
                } else {
                    files.push(item);
                }
            } catch (e) {}
        });

        // Limit items to prevent overflow (max 20)
        const limit = 20;
        let count = 0;

        folders.forEach(folder => {
            if (count < limit) {
                const p = path.join(dirPath, folder);
                buttons.push([Markup.button.callback(`📂 ${folder}`, `fm_open:${p}`)]);
                count++;
            }
        });

        files.forEach(file => {
            if (count < limit) {
                const p = path.join(dirPath, file);
                buttons.push([Markup.button.callback(`📄 ${file}`, `fm_read:${p}`)]);
                count++;
            }
        });
        
        buttons.push([Markup.button.callback('⬅️ Kembali', 'show_more_menu')]);

        ctx.editMessageText(`📂 *FILE MANAGER*\n\nPath: \`${dirPath}\``, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons)
        });

    } catch (e) {
        ctx.editMessageText(`❌ Error akses folder: ${dirPath}`, {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'show_more_menu')]])
        });
    }
};

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

            ctx.editMessageText('📦 *Pilih Aplikasi untuk Di-Update:*\n\nBot akan melakukan:\n1. `git pull`\n2. `npm install / pip install` (jika ada)\n3. `pm2 restart`', {
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

        // 3. Install Dependencies (New Feature)
        await ctx.editMessageText(`⏳ *Update: ${appName}*\n\n📦 Checking dependencies...`, { parse_mode: 'Markdown' });
        let installLog = '';

        if (fs.existsSync(path.join(appPath, 'package.json'))) {
             // NPM Install
             const npmRes = await execPromise('npm install', appPath);
             if (npmRes.code === 0) {
                 installLog = '✅ NPM Install Success';
             } else {
                 installLog = '⚠️ NPM Install Failed (Continuing...)';
                 console.error(npmRes.stderr);
             }
        } else if (fs.existsSync(path.join(appPath, 'requirements.txt'))) {
             // Pip Install
             const pipRes = await execPromise('pip install -r requirements.txt', appPath);
             if (pipRes.code === 0) {
                 installLog = '✅ Pip Install Success';
             } else {
                 installLog = '⚠️ Pip Install Failed (Continuing...)';
                 console.error(pipRes.stderr);
             }
        } else {
            installLog = 'ℹ️ No dependencies found';
        }

        // 4. Success Update -> Restart PM2
        const gitStatus = gitRes.stdout.trim().substring(0, 200);
        await ctx.editMessageText(`⏳ *Update: ${appName}*\n\n✅ Git Pull Berhasil!\n${installLog}\n🔄 Restarting PM2 process...`, { parse_mode: 'Markdown' });
        
        // Check if we are updating ourselves
        const isSelfUpdate = path.resolve(appPath) === path.resolve(process.cwd());

        if (isSelfUpdate) {
            // Send success message FIRST because we will die soon
            await ctx.editMessageText(`🎉 *UPDATE SUKSES!* ✅\n\n📦 App: *${appName}* (Self-Update)\n📝 Git: _${gitStatus}_\n🔄 PM2: Restarting in 3s...`, { 
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
            
            // Trigger restart with delay to ensure message is sent
            setTimeout(() => {
                shell.exec(`pm2 restart ${appName}`);
            }, 1000);
            return;
        }

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
    const args = ctx.message.text.split(/\s+/).filter(a => a.length > 0);
    // /deploy <name> <repo> <port>
    if (args.length !== 4) {
        return ctx.reply('⚠️ Format salah!\nGunakan: `/deploy <name> <repo_url> <port>`', { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    }

    const [_, name, repo, port] = args;
    
    // Validation
    if (!repo.includes('://')) {
        return ctx.reply('❌ URL Repository tidak valid. Pastikan menggunakan format `https://...` atau `git@...`');
    }

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
        const cloneRes = shell.exec(`git clone ${repo} ${appPath}`, { silent: true });
        if (cloneRes.code !== 0) {
            throw new Error(`Git clone failed: ${cloneRes.stderr}`);
        }

        // 3. Install Dependencies
        ctx.reply('📦 Installing dependencies...');
        if (fs.existsSync(path.join(appPath, 'package.json'))) {
            if (shell.exec(`cd ${appPath} && npm install`, { silent: true }).code !== 0) {
                throw new Error('NPM Install failed');
            }
        } else if (fs.existsSync(path.join(appPath, 'requirements.txt'))) {
             if (shell.exec(`cd ${appPath} && pip install -r requirements.txt`, { silent: true }).code !== 0) {
                throw new Error('Pip Install failed');
            }
        }

        // 4. Start with PM2
        ctx.reply('🔥 Starting process with PM2...');
        let script = 'index.js';
        const pkgPath = path.join(appPath, 'package.json');
        
        if (fs.existsSync(pkgPath)) {
            const pkg = require(pkgPath);
            script = pkg.main || 'index.js';
            if (pkg.scripts && pkg.scripts.start) {
                script = 'npm -- start';
            }
        }

        const startCmd = `cd ${appPath} && PORT=${port} pm2 start ${script} --name ${name}`;
        const startRes = shell.exec(startCmd, { silent: true });
        if (startRes.code !== 0) {
            throw new Error(`PM2 Start failed: ${startRes.stderr}`);
        }
        shell.exec('pm2 save');

        // 5. Setup Nginx
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
        fs.writeFileSync(configPath, nginxConfig);
        shell.exec(`ln -s ${configPath} ${path.join(NGINX_ENABLED, name)}`, { silent: true });
        
        if (shell.exec('sudo systemctl reload nginx', { silent: true }).code !== 0) {
            ctx.reply('⚠️ Gagal reload Nginx. Cek config manual.');
        }

        ctx.reply(`✅ *Deployment Berhasil!* 🎉\n\nApp: ${name}\nURL: http://${name}.${VPS_IP}.nip.io`, { 
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });

    } catch (err) {
        console.error(err);
        ctx.reply(`❌ Deployment Gagal:\n\`${err.message}\``, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
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

// --- Screenshot Web Action ---
bot.command('ss', async (ctx) => {
    const url = ctx.message.text.split(' ')[1];
    
    if (!url) {
        return ctx.reply('⚠️ Masukkan URL. Contoh: `/ss https://google.com`');
    }

    const targetUrl = url.startsWith('http') ? url : `http://${url}`;
    
    const msg = await ctx.reply(`📸 *Taking Screenshot...*\n\n🔗 ${targetUrl}\n🖥️ Mode: Desktop (1920x1080)`, { parse_mode: 'Markdown' });

    try {
        // Dynamic import for puppeteer to prevent crash if not installed
        let puppeteer;
        try {
            puppeteer = require('puppeteer');
        } catch (e) {
            return ctx.editMessageText('❌ Module `puppeteer` belum terinstall.\nSilakan jalankan `npm install puppeteer` di VPS.', {
                 ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
            });
        }

        const browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox'], // Required for running as root in VPS
            headless: 'new'
        });
        const page = await browser.newPage();
        
        // Set Viewport to Desktop
        await page.setViewport({ width: 1920, height: 1080 });
        
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Use os.tmpdir() to avoid triggering PM2 watch restart
        const screenshotPath = path.join(os.tmpdir(), 'screenshot.png');
        await page.screenshot({ path: screenshotPath, fullPage: false }); // fullPage: false ensures we see what's in viewport (Desktop view)
        
        await browser.close();
        
        // Send Photo
        await ctx.replyWithPhoto({ source: screenshotPath }, {
            caption: `📸 Screenshot: ${targetUrl}`,
            reply_to_message_id: ctx.message.message_id
        });
        
        // Cleanup
        fs.unlinkSync(screenshotPath);
        
        // Delete status message
        ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id);

    } catch (e) {
        console.error(e);
        ctx.editMessageText(`❌ Gagal mengambil screenshot:\n${e.message}`, {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali ke Menu', 'back_to_main')]])
        });
    }
});

// --- Backup Manager ---
bot.action('backup_menu', (ctx) => {
    ctx.editMessageText('📦 *BACKUP APP*\n\nSedang mengambil daftar aplikasi...', { parse_mode: 'Markdown' });

    shell.exec('pm2 jlist', { silent: true }, (code, stdout, stderr) => {
        if (code !== 0) return ctx.editMessageText('❌ Gagal mengambil data PM2.', {
            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'show_more_menu')]])
        });

        try {
            const list = JSON.parse(stdout);
            if (list.length === 0) return ctx.editMessageText('📭 Tidak ada aplikasi aktif.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'show_more_menu')]])
            });

            const buttons = [];
            list.forEach(app => {
                buttons.push([Markup.button.callback(`📦 ${app.name}`, `backup_app:${app.name}`)]);
            });
            
            buttons.push([Markup.button.callback('⬅️ Kembali', 'show_more_menu')]);

            ctx.editMessageText('📦 *Pilih Aplikasi untuk Backup:*\n(Akan di-zip tanpa node_modules)', {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            });

        } catch (e) {
            ctx.editMessageText('❌ Error parsing data.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'show_more_menu')]])
            });
        }
    });
});

bot.action(/backup_app:(.+)/, async (ctx) => {
    const appName = ctx.match[1];
    
    // Initial feedback
    await ctx.editMessageText(`⏳ *Preparing Backup: ${appName}*...`, { parse_mode: 'Markdown' });

    shell.exec('pm2 jlist', { silent: true }, (code, stdout, stderr) => {
        if (code !== 0) {
            return ctx.editMessageText('❌ Gagal akses PM2.', {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'backup_menu')]])
            });
        }
        
        try {
            const list = JSON.parse(stdout);
            const app = list.find(p => p.name === appName);
            if (!app) {
                return ctx.editMessageText(`❌ App ${appName} tidak ditemukan.`, {
                    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'backup_menu')]])
                });
            }
            
            const appPath = app.pm2_env.pm_cwd;
            const backupName = `${appName}_backup_${Date.now()}.tar.gz`;
            const backupPath = path.join(os.tmpdir(), backupName);
            
            // Tar command: exclude node_modules, .git
            // Use quotes for paths to handle spaces
            const cmd = `tar --exclude=node_modules --exclude=.git -czf "${backupPath}" -C "${appPath}" .`;
            
            ctx.editMessageText(`⏳ *Compressing...*\nSource: \`${appPath}\``, { parse_mode: 'Markdown' });
            
            shell.exec(cmd, { silent: true }, async (c, out, err) => {
                if (c !== 0) {
                     return ctx.editMessageText(`❌ Backup Gagal:\n${err}`, {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'backup_menu')]])
                    });
                }
                
                try {
                    // Check size
                    if (!fs.existsSync(backupPath)) {
                        throw new Error('File backup tidak terbuat.');
                    }

                    const stats = fs.statSync(backupPath);
                    const sizeMB = stats.size / (1024 * 1024);
                    
                    if (sizeMB > 49) { // Telegram limit ~50MB
                         await ctx.editMessageText(`⚠️ *Backup Terlalu Besar* (${sizeMB.toFixed(2)} MB).\nBot tidak bisa mengirim file > 50MB.\n\nFile tersimpan di VPS: \`${backupPath}\``, {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'backup_menu')]])
                        });
                    } else {
                        await ctx.replyWithDocument({ source: backupPath, filename: backupName }, {
                            caption: `📦 Backup: ${appName}\n📅 ${new Date().toLocaleString()}\n💾 Size: ${sizeMB.toFixed(2)} MB`
                        });
                        
                        // Cleanup
                        fs.unlinkSync(backupPath);
                        
                        await ctx.editMessageText(`✅ *Backup ${appName} Terkirim!*`, {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'backup_menu')]])
                        });
                    }
                } catch (sendErr) {
                    console.error(sendErr);
                    ctx.reply(`❌ Gagal mengirim file: ${sendErr.message}`);
                }
            });
            
        } catch (e) {
            console.error(e);
            ctx.editMessageText(`❌ Error: ${e.message}`, {
                ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Kembali', 'backup_menu')]])
            });
        }
    });
});

// --- Shell Launcher ---
bot.action('start_shell', (ctx) => {
    ctx.scene.enter('shell_wizard');
});

// Launch Bot with Retry Logic
const launchBot = async (retries = 5) => {
    for (let i = 0; i < retries; i++) {
        try {
            await bot.launch();
            console.log('🤖 Bot started!');
            return;
        } catch (err) {
            console.error(`❌ Bot failed to start (Attempt ${i + 1}/${retries}):`, err.message);
            if (i === retries - 1) {
                console.error('💀 Max retries reached. Exiting...');
                process.exit(1);
            }
            // Wait 5 seconds before retrying
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
};

launchBot();

// Graceful Stop
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    process.exit(0);
});
process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    process.exit(0);
});
