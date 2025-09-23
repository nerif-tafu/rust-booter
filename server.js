const express = require('express');
const cors = require('cors');
const wol = require('wake_on_lan');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

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
  rustServerPort: 28015
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
    const response = await axios.post(`http://${pcIP}:5000/game/launch`, {
      server_ip: serverIP,
      server_port: serverPort
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    throw new Error(`Failed to launch game: ${error.message}`);
  }
}

// Wait for PC to be ready
async function waitForPCReady(pcIP, maxAttempts = 30, intervalMs = 2000) {
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
    
    // Step 1: Send WOL packet
    console.log('Sending WOL packet...');
    await sendWOLPacket(config.gamingPCMAC);
    console.log('WOL packet sent successfully');
    
    // Step 2: Wait for PC to be ready
    console.log('Waiting for PC to boot...');
    await waitForPCReady(config.gamingPCIP);
    
    // Step 3: Launch game
    console.log('Launching game...');
    const launchResult = await launchGame(config.gamingPCIP, config.rustServerIP, config.rustServerPort);
    console.log('Game launched successfully');
    
    res.json({
      success: true,
      message: 'Boot sequence completed successfully',
      launchResult
    });
    
  } catch (error) {
    console.error('Boot sequence failed:', error);
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
