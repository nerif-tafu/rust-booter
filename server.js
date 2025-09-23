const express = require('express');
const cors = require('cors');
const wol = require('wake_on_lan');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { Webhook } = require('discord-webhook-node');

const app = express();
const PORT = process.env.PORT || 8534;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuration file path
const CONFIG_FILE = 'config.json';

// Default configuration
const defaultConfig = {
  gamingPCIP: '',
  gamingPCMAC: '',
  rustServerIP: '',
  rustServerPort: 28015,
  discordWebhookURL: '',
  discordRoleID: '',
  discordEnabled: false,
  discordCustomMessage: ''
};

// Load configuration
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      return { ...defaultConfig, ...JSON.parse(data) };
    } else {
      // Generate default config file if it doesn't exist
      console.log('Config file not found, creating default config.json...');
      saveConfig(defaultConfig);
      return defaultConfig;
    }
  } catch (error) {
    console.error('Error loading config:', error);
    return defaultConfig;
  }
}

// Save configuration
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving config:', error);
    return false;
  }
}

// Send Discord notification
async function sendDiscordNotification(config, message, isError = false) {
  if (!config.discordEnabled || !config.discordWebhookURL) {
    return;
  }

  try {
    const webhook = new Webhook(config.discordWebhookURL);
    
    // Add custom message if provided
    let fullMessage = message;
    if (config.discordCustomMessage && config.discordCustomMessage.trim()) {
      fullMessage += `\n\n**Custom Message:** ${config.discordCustomMessage}`;
    }
    
    const embed = {
      title: isError ? '❌ Rust Booter - Error' : '🎮 Rust Booter - Status',
      description: fullMessage,
      color: isError ? 0xff0000 : 0x00ff00, // Red for error, green for success
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Rust Booter System'
      }
    };

    let content = '';
    if (config.discordRoleID) {
      content = `<@&${config.discordRoleID}>`;
    }
    
    // Add custom message to content if provided
    if (config.discordCustomMessage && config.discordCustomMessage.trim()) {
      content += (content ? ' ' : '') + config.discordCustomMessage;
    }

    await webhook.send(content, [embed]);
    console.log('Discord notification sent successfully');
  } catch (error) {
    console.error('Failed to send Discord notification:', error);
  }
}

// Send WOL packet
function sendWOLPacket(macAddress) {
  return new Promise((resolve, reject) => {
    wol.wake(macAddress, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

// Check gaming PC health
async function checkPCHealth(pcIP) {
  try {
    const response = await axios.get(`http://${pcIP}:5000/health`, {
      timeout: 5000
    });
    return response.data.status === 'healthy';
  } catch (error) {
    return false;
  }
}

// Launch game on PC
async function launchGame(pcIP, serverIP, serverPort) {
  try {
    console.log(`Sending game launch request to ${pcIP}:5000/game/launch`);
    console.log(`Request body:`, { server_ip: serverIP, server_port: serverPort });
    
    const response = await axios.post(`http://${pcIP}:5000/game/launch`, {
      server_ip: serverIP,
      server_port: serverPort
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    console.log(`Game launch response:`, response.data);
    return response.data;
  } catch (error) {
    console.error(`Game launch error:`, error.message);
    console.error(`Full error:`, error);
    throw new Error(`Failed to launch game: ${error.message}`);
  }
}

// Wait for PC to be ready
async function waitForPCReady(pcIP, maxAttempts = 150, intervalMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`Health check attempt ${attempt}/${maxAttempts} for ${pcIP}`);
    
    if (await checkPCHealth(pcIP)) {
      console.log(`PC ${pcIP} is ready!`);
      return true;
    }
    
    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
  
  throw new Error(`PC ${pcIP} did not become ready within ${maxAttempts * intervalMs / 1000} seconds`);
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get current configuration
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json(config);
});

// Update configuration
app.post('/api/config', (req, res) => {
  const newConfig = req.body;
  const currentConfig = loadConfig();
  const updatedConfig = { ...currentConfig, ...newConfig };
  
  if (saveConfig(updatedConfig)) {
    res.json({ success: true, config: updatedConfig });
  } else {
    res.status(500).json({ success: false, error: 'Failed to save configuration' });
  }
});

// Test Discord webhook
app.post('/api/test-discord', async (req, res) => {
  try {
    const { webhookURL, roleID, customMessage } = req.body;
    
    if (!webhookURL) {
      return res.status(400).json({ success: false, error: 'Webhook URL is required' });
    }
    
    const testConfig = {
      discordEnabled: true,
      discordWebhookURL: webhookURL,
      discordRoleID: roleID || '',
      discordCustomMessage: customMessage || ''
    };
    
    await sendDiscordNotification(testConfig, `🧪 **Discord Test Notification**\n\nThis is a test message from your Rust Booter system!\n\nIf you can see this, your Discord integration is working correctly.`, false);
    
    res.json({ success: true, message: 'Discord test notification sent successfully' });
  } catch (error) {
    console.error('Discord test failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Main boot sequence endpoint
app.post('/go', async (req, res) => {
  try {
    const config = loadConfig();
    
    // Validate configuration
    if (!config.gamingPCIP || !config.gamingPCMAC || !config.rustServerIP) {
      return res.status(400).json({
        success: false,
        error: 'Missing required configuration. Please set Gaming PC IP, MAC address, and Rust server IP.'
      });
    }
    
    console.log('Starting boot sequence...');
    console.log(`Gaming PC: ${config.gamingPCIP} (${config.gamingPCMAC})`);
    console.log(`Rust Server: ${config.rustServerIP}:${config.rustServerPort}`);
    
    // Send Discord notification - Boot sequence started
    await sendDiscordNotification(config, `🚀 **Boot sequence started!**\n\n**Gaming PC:** ${config.gamingPCIP}\n**Rust Server:** ${config.rustServerIP}:${config.rustServerPort}\n\nStarting WOL packet...`);
    
    // Step 1: Send WOL packet
    console.log('Sending WOL packet...');
    await sendWOLPacket(config.gamingPCMAC);
    console.log('WOL packet sent successfully');
    
    // Step 2: Wait for PC to be ready
    console.log('Waiting for PC to boot...');
    await waitForPCReady(config.gamingPCIP);
    
    // Send Discord notification - PC is ready
    await sendDiscordNotification(config, `✅ **Gaming PC is ready!**\n\n**PC IP:** ${config.gamingPCIP}\n\nLaunching Rust game...`);
    
    // Step 3: Launch game
    console.log('Launching game...');
    const launchResult = await launchGame(config.gamingPCIP, config.rustServerIP, config.rustServerPort);
    console.log('Game launched successfully');
    console.log('Launch result:', launchResult);
    
    // Send Discord notification - Boot sequence completed
    await sendDiscordNotification(config, `🎉 **Boot sequence completed successfully!**\n\n**Rust Server:** ${config.rustServerIP}:${config.rustServerPort}\n**Steam URL:** ${launchResult.steam_url}\n\nGame should be starting now!`);
    
    const responseData = {
      success: true,
      message: 'Boot sequence completed successfully',
      launchResult
    };
    
    console.log('Sending success response:', responseData);
    res.json(responseData);
    
  } catch (error) {
    console.error('Boot sequence failed:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    
    // Send Discord notification - Error
    await sendDiscordNotification(config, `❌ **Boot sequence failed!**\n\n**Error:** ${error.message}\n\nPlease check the system logs for more details.`, true);
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Rust Booter server running on http://localhost:${PORT}`);
  console.log('Configuration file:', CONFIG_FILE);
  
  // Initialize config on startup
  const config = loadConfig();
  console.log('Configuration loaded successfully');
});
