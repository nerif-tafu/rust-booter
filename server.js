const express = require('express');
const cors = require('cors');
const wol = require('wake_on_lan');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { Webhook } = require('discord-webhook-node');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8534;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuration file path
const CONFIG_FILE = 'config.json';

// Global connection state
let isConnecting = false;

// Default configuration
const defaultConfig = {
  gamingPCIP: '',
  gamingPCMAC: '',
  rustServerIP: '',
  rustServerPort: 28015,
  discordWebhookURL: '',
  rustPlusEnabled: false,
  selectedServerId: '',
  smartAlarms: [],
  detectedEntities: {}
};

// WebSocket client class for Rust+ API
class RustPlusWebSocketClient {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 5000;
    this.messageHandlers = new Map();
    this.servers = {};
    this.selectedServerId = null;
  }

  async connect() {
    if (this.isConnected || this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    console.log('🔗 Connecting to Rust+ WebSocket API...');

    try {
      this.ws = new WebSocket('wss://rust-plus-api.tafu.casa');
      
      this.ws.on('open', () => {
        console.log('✅ Connected to Rust+ WebSocket API');
        this.isConnected = true;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        
        // Request initial server list
        this.getServers();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
  } catch (error) {
          console.error('❌ Error parsing WebSocket message:', error);
        }
      });

      this.ws.on('close', () => {
        console.log('❌ Disconnected from Rust+ WebSocket API');
        this.isConnected = false;
        this.isConnecting = false;
        this.attemptReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
        this.isConnected = false;
        this.isConnecting = false;
        this.attemptReconnect();
      });

    } catch (error) {
      console.error('❌ Failed to connect to WebSocket:', error);
      this.isConnecting = false;
      this.attemptReconnect();
    }
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('❌ Max reconnection attempts reached');
    return;
  }

    this.reconnectAttempts++;
    console.log(`🔄 Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelay/1000}s...`);
    
    setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
  }

  handleMessage(message) {
    // Only log relevant messages for Rust Booter functionality
    const relevantTypes = ['servers_list', 'entity_changed', 'team_message', 'server_connected', 'server_disconnected'];
    
    if (relevantTypes.includes(message.type)) {
      console.log('📨 WebSocket message received:', JSON.stringify(message, null, 2));
    }
    
    switch (message.type) {
      case 'servers_list':
        this.handleServersList(message.data);
        break;
      case 'server_info':
        this.handleServerInfo(message.data);
        break;
      case 'map_data':
        this.handleMapData(message.data);
        break;
      case 'team_info':
        this.handleTeamInfo(message.data);
        break;
      case 'entity_info':
        this.handleEntityInfo(message.data);
        break;
      case 'switch_toggled':
        this.handleSwitchToggled(message.data);
        break;
      case 'team_message_sent':
        this.handleTeamMessageSent(message.data);
        break;
      case 'team_message':
        this.handleTeamMessage(message.data);
        break;
      case 'entity_changed':
        this.handleEntityChanged(message.data);
        break;
      case 'server_connected':
        this.handleServerConnected(message.data);
        break;
      case 'server_disconnected':
        this.handleServerDisconnected(message.data);
        break;
      case 'live_event':
        this.handleLiveEvent(message.data);
        break;
      default:
        // Only log unknown types if they might be relevant
        if (message.type && !message.type.includes('server_message')) {
          console.log('📡 Unknown message type:', message.type);
        }
    }
  }

  handleServersList(data) {
    this.servers = data.servers || {};
    console.log('📋 Servers list updated:', Object.keys(this.servers).length, 'servers');
    
    // Update detected entities from server data
    this.updateDetectedEntities();
  }

  updateDetectedEntities() {
    const config = loadConfig();
    if (!config.detectedEntities) {
      config.detectedEntities = {};
    }

    // Clear existing entities and rebuild from server data
    config.detectedEntities = {};

    Object.entries(this.servers).forEach(([serverId, server]) => {
      // Add switches
      if (server.switches) {
        server.switches.forEach(switchEntity => {
          config.detectedEntities[switchEntity.entityId] = {
            id: switchEntity.entityId,
            name: switchEntity.entityName || `Switch ${switchEntity.entityId}`,
            type: switchEntity.entityType || 'switch',
            lastValue: false,
            lastChanged: new Date().toISOString(),
            paired: true,
            serverId: serverId,
            serverName: server.name
          };
        });
      }

      // Add alarms
      if (server.alarms) {
        server.alarms.forEach(alarmEntity => {
          config.detectedEntities[alarmEntity.entityId] = {
            id: alarmEntity.entityId,
            name: alarmEntity.entityName || `Alarm ${alarmEntity.entityId}`,
            type: alarmEntity.entityType || 'alarm',
            lastValue: false,
            lastChanged: new Date().toISOString(),
            paired: true,
            serverId: serverId,
            serverName: server.name
          };
        });
      }
    });

    saveConfig(config);
    const entityCount = Object.keys(config.detectedEntities).length;
    if (entityCount > 0) {
      console.log('📊 Updated detected entities from server data:', entityCount, 'entities');
    }
  }

  handleServerInfo(data) {
    // Only log if there's important info
    if (data && data.name) {
      console.log('📊 Server info received for:', data.name);
    }
  }

  handleMapData(data) {
    // Map data is not relevant for Rust Booter
  }

  handleTeamInfo(data) {
    // Team info is not relevant for Rust Booter
  }

  handleEntityInfo(data) {
    // Entity info is not relevant for Rust Booter
  }

  handleSwitchToggled(data) {
    // Switch toggled is not relevant for Rust Booter
  }

  handleTeamMessageSent(data) {
    // Team message sent is not relevant for Rust Booter
  }

  handleTeamMessage(data) {
    console.log('💬 Team message received:', data.message);
  }

  handleEntityChanged(data) {
    console.log('🔧 Entity changed:', data.entityId, 'is now', data.isActive ? 'active' : 'inactive');
    // Process smart alarm triggers here
    this.processEntityChange(data);
  }

  handleServerConnected(data) {
    console.log('🟢 Server connected:', data.serverName);
  }

  handleServerDisconnected(data) {
    console.log('🔴 Server disconnected:', data.serverName);
  }

  handleLiveEvent(data) {
    // Live events are not relevant for Rust Booter
  }

  processEntityChange(data) {
    // Load config and process smart alarms
    const config = loadConfig();
    console.log(`🔍 Smart alarms in config:`, config.smartAlarms);
    
    if (!config.smartAlarms || config.smartAlarms.length === 0) {
      console.log('⚠️ No smart alarms configured');
      return;
    }

    // Update the entity status in detected entities.
    // entityId comes off the wire, so reject the keys that would let this
    // assignment reach Object.prototype. A plain truthiness check is not
    // enough: detectedEntities['__proto__'] is inherited-truthy, so the write
    // would land on the prototype and affect every object in the process.
    const changedId = data.entityId;
    if (
      changedId !== '__proto__' &&
      changedId !== 'constructor' &&
      changedId !== 'prototype' &&
      config.detectedEntities &&
      Object.prototype.hasOwnProperty.call(config.detectedEntities, changedId)
    ) {
      const entity = config.detectedEntities[changedId];
      entity.lastValue = data.isActive;
      entity.lastChanged = new Date().toISOString();
      saveConfig(config);
    }

    console.log(`🔍 Processing entity change for entityId: ${data.entityId} (type: ${typeof data.entityId})`);
    console.log(`🔍 Available smart alarms:`, config.smartAlarms.map(alarm => ({
      name: alarm.name,
      entityId: alarm.entityId,
      entityIdType: typeof alarm.entityId,
      enabled: alarm.enabled
    })));

    config.smartAlarms.forEach((alarm) => {
      // Convert both to strings for comparison to handle type mismatches
      const alarmEntityId = String(alarm.entityId);
      const dataEntityId = String(data.entityId);
      
      console.log(`🔍 Comparing alarm entityId "${alarmEntityId}" with data entityId "${dataEntityId}"`);
      
      if (alarm.enabled && alarmEntityId === dataEntityId) {
        const triggerOnActivation = alarm.triggerOnActivation !== undefined ? alarm.triggerOnActivation : true;
        const shouldTrigger = triggerOnActivation ? data.isActive : !data.isActive;
        
        console.log(`🔍 Alarm "${alarm.name}" - triggerOnActivation: ${triggerOnActivation}, data.isActive: ${data.isActive}, shouldTrigger: ${shouldTrigger}`);
        
        if (shouldTrigger) {
          console.log(`🚨 Smart alarm triggered: ${alarm.name}`);
          triggerSmartAlarmAction(alarm, config, data.isActive);
        } else {
          console.log(`⏸️ Smart alarm condition not met: ${alarm.name} (triggerOnActivation: ${triggerOnActivation}, isActive: ${data.isActive})`);
        }
      }
    });
  }

  sendCommand(command) {
    if (!this.isConnected || !this.ws) {
      console.error('❌ WebSocket not connected');
      return false;
    }

    try {
      this.ws.send(JSON.stringify(command));
      return true;
    } catch (error) {
      console.error('❌ Error sending WebSocket command:', error);
      return false;
    }
  }

  getServers() {
    return this.sendCommand({ type: 'get_servers' });
  }

  getServerInfo(serverId) {
    return this.sendCommand({ type: 'get_server_info', serverId });
  }

  getMapData(serverId) {
    return this.sendCommand({ type: 'get_map_data', serverId });
  }

  getTeamInfo(serverId) {
    return this.sendCommand({ type: 'get_team_info', serverId });
  }

  getEntityInfo(serverId, entityId) {
    return this.sendCommand({ type: 'get_entity_info', serverId, entityId });
  }

  toggleSwitch(serverId, entityId) {
    return this.sendCommand({ type: 'toggle_switch', serverId, entityId });
  }

  sendTeamMessage(serverId, message) {
    return this.sendCommand({ type: 'send_team_message', serverId, message });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
  }
}

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
  console.log('🔍 Discord notification attempt:', {
    hasWebhookURL: !!config.discordWebhookURL,
    message: message,
    isError: isError
  });
  
  if (!config.discordWebhookURL) {
    console.log('⚠️ Discord notification skipped: No webhook URL configured');
    return;
  }

  try {
    console.log('🔗 Creating Discord webhook client...');
    const webhook = new Webhook(config.discordWebhookURL);
    
    // Use the message as provided
    const fullMessage = message;
    console.log('📝 Sending Discord message:', fullMessage);
    
    const embed = {
      title: isError ? '❌ Rust Booter - Error' : '🎮 Rust Booter - Status',
      description: fullMessage,
      color: isError ? 0xff0000 : 0x00ff00, // Red for error, green for success
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Rust Booter System'
      }
    };

    // Use the message as content
    const content = message;

    await webhook.send(content, [embed]);
    console.log('Discord notification sent successfully');
  } catch (error) {
    console.error('Failed to send Discord notification:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      status: error.status,
      response: error.response ? error.response.data : 'No response data'
    });
  }
}

// WebSocket client instance
let rustPlusWSClient = null;

// Initialize WebSocket client
function initializeWebSocketClient() {
  if (!rustPlusWSClient) {
    rustPlusWSClient = new RustPlusWebSocketClient();
    rustPlusWSClient.connect();
  }
  return rustPlusWSClient;
}

// Get available servers from WebSocket
async function getAvailableServers() {
  const client = initializeWebSocketClient();
  if (client.isConnected) {
    client.getServers();
    return client.servers;
  }
  return {};
}

// Select a server for operations
function selectServer(serverId) {
  const config = loadConfig();
  config.selectedServerId = serverId;
  saveConfig(config);
  
  const client = initializeWebSocketClient();
  if (client.isConnected && serverId) {
    client.getServerInfo(serverId);
    client.getTeamInfo(serverId);
  }
}

// Smart Alarm Functions
function startSmartAlarmListener(config) {
  console.log('🔔 Smart alarm listener started via WebSocket');
}

// Subscribe to existing entities for broadcasts
function subscribeToExistingEntities(config) {
  const client = initializeWebSocketClient();
  if (!client.isConnected) {
    console.log('⚠️ Cannot subscribe to entities - WebSocket not connected');
    return;
  }

  if (!config.detectedEntities || Object.keys(config.detectedEntities).length === 0) {
    console.log('📡 No entities to subscribe to');
    return;
  }

  console.log('📡 Subscribing to existing entities for broadcasts...');
  
  Object.values(config.detectedEntities).forEach(entity => {
    console.log(`📡 Subscribing to entity ${entity.id} (${entity.name})...`);
    if (config.selectedServerId) {
      client.getEntityInfo(config.selectedServerId, entity.id);
    }
  });
}

// Connection health check
function startConnectionHealthCheck(config) {
  setInterval(() => {
    const client = initializeWebSocketClient();
    if (!client.isConnected) {
      console.log('🔄 WebSocket connection lost - attempting to reconnect...');
      client.connect();
        } else {
      // Keep connection active by requesting server list periodically
      console.log('🔄 Keeping WebSocket connection active...');
      client.getServers();
    }
  }, 60000); // Check every 60 seconds
}

// Process entity changes from WebSocket
function processEntityChange(entityData) {
  const config = loadConfig();
  
  if (!config.detectedEntities) {
    config.detectedEntities = {};
  }
  
  // Update entity info
  const existingEntity = config.detectedEntities[entityData.entityId];
  const entityName = existingEntity ? existingEntity.name : `Entity ${entityData.entityId}`;
  
  config.detectedEntities[entityData.entityId] = {
    id: entityData.entityId,
    lastValue: entityData.isActive,
      lastChanged: new Date().toISOString(),
    name: entityName,
      type: existingEntity ? existingEntity.type : 'unknown',
    paired: true
  };
  
  saveConfig(config);
  
  // Check smart alarms
  if (config.smartAlarms && config.smartAlarms.length > 0) {
    config.smartAlarms.forEach((alarm) => {
      if (alarm.enabled && alarm.entityId === entityData.entityId.toString()) {
          const triggerOnActivation = alarm.triggerOnActivation !== undefined ? alarm.triggerOnActivation : true;
        const shouldTrigger = triggerOnActivation ? entityData.isActive : !entityData.isActive;
          
          if (shouldTrigger) {
          console.log(`🚨 Smart alarm triggered: ${alarm.name}`);
          triggerSmartAlarmAction(alarm, config, entityData.isActive);
          }
        }
      });
  }
}

async function triggerSmartAlarmAction(alarm, config, entityValue = null) {
  console.log(`🚨 Executing smart alarm action: ${alarm.name}`);
  
  try {
    // Wake up PC if enabled
    if (alarm.wakePC) {
      console.log('🖥️ Starting complete boot sequence for smart alarm...');
      await wakeUpPC(config);
    }
    
    // Send Discord notification if enabled
    if (alarm.sendDiscord && config.discordWebhookURL) {
      console.log('💬 Sending Discord notification for smart alarm...');
      let message = alarm.discordMessage || `🚨 Smart Alarm Triggered: ${alarm.name}`;
      
      // Add entity status to message if available
      if (entityValue !== null) {
        message += ` (Entity is now ${entityValue ? "active" : "inactive"})`;
      }
      
      await sendDiscordNotification(config, message, false);
    }
    
    console.log(`✅ Smart alarm action completed: ${alarm.name}`);
  } catch (error) {
    console.error(`❌ Smart alarm action failed: ${alarm.name}`, error);
  }
}

// Send Rust+ notification via WebSocket
async function sendRustPlusNotification(message) {
  const config = loadConfig();
  if (!config.selectedServerId) {
    console.log('No server selected, skipping Rust+ notification');
    return;
  }

  const client = initializeWebSocketClient();
  if (!client.isConnected) {
    console.log('WebSocket not connected, skipping Rust+ notification');
    return;
  }

  try {
    const success = client.sendTeamMessage(config.selectedServerId, message);
    if (success) {
    console.log('✅ Rust+ notification sent:', message);
    } else {
      console.error('❌ Failed to send Rust+ notification');
    }
  } catch (error) {
    console.error('❌ Failed to send Rust+ notification:', error);
    throw error;
  }
}

// Disconnect from WebSocket
async function disconnectFromRustPlus() {
  if (rustPlusWSClient) {
    try {
      rustPlusWSClient.disconnect();
      console.log('✅ Disconnected from WebSocket');
    } catch (error) {
      console.error('Error disconnecting from WebSocket:', error);
    }
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

// Complete boot sequence (wake PC + launch Rust)
async function wakeUpPC(config) {
  try {
    console.log('🚀 Starting smart alarm boot sequence...');
    console.log(`Gaming PC: ${config.gamingPCIP} (${config.gamingPCMAC})`);
    console.log(`Rust Server: ${config.rustServerIP}:${config.rustServerPort}`);
    
    // Step 1: Send WOL packet
    console.log('🖥️ Sending WOL packet...');
    await sendWOLPacket(config.gamingPCMAC);
    console.log('✅ WOL packet sent successfully');
    
    // Step 2: Wait for PC to be ready
    console.log('⏳ Waiting for PC to boot...');
    await waitForPCReady(config.gamingPCIP);
    console.log('✅ PC is ready!');
    
    // Step 3: Launch game
    console.log('🎮 Launching Rust game...');
    const launchResult = await launchGame(config.gamingPCIP, config.rustServerIP, config.rustServerPort);
    console.log('✅ Game launched successfully');
    console.log('Launch result:', launchResult);
    
    return launchResult;
  } catch (error) {
    console.error('❌ Smart alarm boot sequence failed:', error);
    throw new Error(`Smart alarm boot sequence failed: ${error.message}`);
  }
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
    const { webhookURL } = req.body;
    
    if (!webhookURL) {
      return res.status(400).json({ success: false, error: 'Webhook URL is required' });
    }
    
    const testConfig = {
      discordWebhookURL: webhookURL
    };
    
    console.log('🧪 Testing Discord webhook:', webhookURL);
    await sendDiscordNotification(testConfig, `🧪 **Discord Test Notification**\n\nThis is a test message from your Rust Booter system!\n\nIf you can see this, your Discord integration is working correctly.`, false);
    
    res.json({ success: true, message: 'Discord test notification sent successfully' });
  } catch (error) {
    console.error('Discord test failed:', error);
    console.error('Discord test error details:', {
      message: error.message,
      code: error.code,
      status: error.status,
      response: error.response ? error.response.data : 'No response data',
      webhookURL: webhookURL
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test WebSocket connection
app.post('/api/test-rust-plus', async (req, res) => {
  try {
    const config = loadConfig();
    
    if (!config.selectedServerId) {
      return res.status(400).json({ 
        success: false, 
        error: 'No server selected. Please select a server first.' 
      });
    }
    
    const client = initializeWebSocketClient();
    
    if (!client.isConnected) {
      return res.status(500).json({ 
        success: false, 
        error: 'WebSocket not connected' 
      });
    }
    
    // Send test message
    await sendRustPlusNotification('🧪 Rust+ Test Notification - This is a test message from your Rust Booter system!');
    
      res.json({ 
        success: true, 
      message: 'Rust+ test notification sent successfully' 
    });
  } catch (error) {
    console.error('Rust+ test failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Smart Alarm API endpoints
app.get('/api/smart-alarms', (req, res) => {
  try {
    const config = loadConfig();
    res.json({ success: true, smartAlarms: config.smartAlarms || [] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/detected-entities', (req, res) => {
  try {
    const config = loadConfig();
    res.json({ success: true, entities: config.detectedEntities || {} });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/detected-entities/:id', (req, res) => {
  try {
    const config = loadConfig();
    const entityId = req.params.id;
    const newName = req.body.name;
    
    // entityId is a request parameter, so reject the keys that would let the
    // assignment below reach Object.prototype before doing anything else.
    if (entityId === '__proto__' || entityId === 'constructor' || entityId === 'prototype') {
      return res.status(400).json({ success: false, error: 'Invalid entity id' });
    }

    if (!config.detectedEntities || !Object.prototype.hasOwnProperty.call(config.detectedEntities, entityId)) {
      return res.status(404).json({ success: false, error: 'Entity not found' });
    }

    // Update the entity name
    config.detectedEntities[entityId].name = newName;
    
    if (saveConfig(config)) {
      res.json({ success: true, entity: config.detectedEntities[entityId] });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save entity name' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get WebSocket connection status
app.get('/api/rust-plus-status', (req, res) => {
  try {
    const client = initializeWebSocketClient();
    
    res.json({ 
      connected: client.isConnected,
      connecting: client.isConnecting,
      selectedServerId: client.selectedServerId
    });
  } catch (error) {
    res.status(500).json({ 
        connected: false, 
        connecting: false, 
      error: error.message 
    });
  }
});

// Get available servers
app.get('/api/rust-plus/servers', (req, res) => {
  try {
    const client = initializeWebSocketClient();
    res.json({ 
      success: true, 
      servers: client.servers 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get entities for a specific server
app.get('/api/rust-plus/servers/:serverId/entities', (req, res) => {
  try {
    const { serverId } = req.params;
    const client = initializeWebSocketClient();
    
    if (!client.servers[serverId]) {
      return res.status(404).json({ 
        success: false, 
        error: 'Server not found' 
      });
    }
    
    const server = client.servers[serverId];
    const entities = [];
    
    // Add switches
    if (server.switches) {
      server.switches.forEach(switchEntity => {
        entities.push({
          id: switchEntity.entityId,
          name: switchEntity.entityName || `Switch ${switchEntity.entityId}`,
          type: switchEntity.entityType || 'switch',
          serverId: serverId,
          serverName: server.name
        });
      });
    }
    
    // Add alarms
    if (server.alarms) {
      server.alarms.forEach(alarmEntity => {
        entities.push({
          id: alarmEntity.entityId,
          name: alarmEntity.entityName || `Alarm ${alarmEntity.entityId}`,
          type: alarmEntity.entityType || 'alarm',
          serverId: serverId,
          serverName: server.name
        });
      });
    }
    
    res.json({ 
      success: true, 
      entities: entities 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Select a server
app.post('/api/rust-plus/select-server', (req, res) => {
  try {
    const { serverId } = req.body;
    
    if (!serverId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Server ID is required' 
      });
    }
    
    selectServer(serverId);
    
    res.json({ 
      success: true, 
      message: 'Server selected successfully' 
    });
    } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get server info
app.get('/api/rust-plus/server-info/:serverId', (req, res) => {
  try {
    const { serverId } = req.params;
    const client = initializeWebSocketClient();
    
    if (client.isConnected) {
      client.getServerInfo(serverId);
    res.json({ 
        success: true, 
        message: 'Server info request sent' 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: 'WebSocket not connected' 
      });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Toggle switch
app.post('/api/rust-plus/toggle-switch', (req, res) => {
  try {
    const { serverId, entityId } = req.body;
    
    if (!serverId || !entityId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Server ID and Entity ID are required' 
      });
    }
    
    const client = initializeWebSocketClient();
    
    if (client.isConnected) {
      const success = client.toggleSwitch(serverId, entityId);
    res.json({ 
        success: success, 
        message: success ? 'Switch toggle request sent' : 'Failed to send toggle request' 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: 'WebSocket not connected' 
      });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Smart alarms are detected automatically through message events
// No manual check needed

app.post('/api/smart-alarms', (req, res) => {
  try {
    const config = loadConfig();
    const newAlarm = {
      id: Date.now().toString(),
      name: req.body.name || 'Unnamed Alarm',
      enabled: req.body.enabled !== false, // default to true
      wakePC: req.body.wakePC || false,
      sendDiscord: req.body.sendDiscord || false,
      discordMessage: req.body.discordMessage || '',
      entityId: req.body.entityId || '',
      triggerOnActivation: req.body.triggerOnActivation !== undefined ? req.body.triggerOnActivation : true // default to activation
    };
    
    config.smartAlarms = config.smartAlarms || [];
    config.smartAlarms.push(newAlarm);
    
    if (saveConfig(config)) {
      res.json({ success: true, alarm: newAlarm });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save smart alarm' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/smart-alarms/:id', (req, res) => {
  try {
    const config = loadConfig();
    const alarmId = req.params.id;
    const alarmIndex = config.smartAlarms.findIndex(alarm => alarm.id === alarmId);
    
    if (alarmIndex === -1) {
      return res.status(404).json({ success: false, error: 'Smart alarm not found' });
    }
    
    // Debug logging for triggerOnActivation updates
    if (req.body.triggerOnActivation !== undefined) {
      console.log(`🔍 Backend Debug: Received triggerOnActivation=${req.body.triggerOnActivation} for alarm ${alarmId}`);
      console.log(`🔍 Backend Debug: Current value=${config.smartAlarms[alarmIndex].triggerOnActivation}`);
    }
    
    // Update the alarm
    config.smartAlarms[alarmIndex] = {
      ...config.smartAlarms[alarmIndex],
      name: req.body.name || config.smartAlarms[alarmIndex].name,
      enabled: req.body.enabled !== undefined ? req.body.enabled : config.smartAlarms[alarmIndex].enabled,
      wakePC: req.body.wakePC !== undefined ? req.body.wakePC : config.smartAlarms[alarmIndex].wakePC,
      sendDiscord: req.body.sendDiscord !== undefined ? req.body.sendDiscord : config.smartAlarms[alarmIndex].sendDiscord,
      discordMessage: req.body.discordMessage !== undefined ? req.body.discordMessage : config.smartAlarms[alarmIndex].discordMessage,
      entityId: req.body.entityId !== undefined ? req.body.entityId : config.smartAlarms[alarmIndex].entityId,
      triggerOnActivation: req.body.triggerOnActivation !== undefined ? req.body.triggerOnActivation : config.smartAlarms[alarmIndex].triggerOnActivation
    };
    
    // Debug logging after update
    if (req.body.triggerOnActivation !== undefined) {
      console.log(`🔍 Backend Debug: After update triggerOnActivation=${config.smartAlarms[alarmIndex].triggerOnActivation}`);
    }
    
    if (saveConfig(config)) {
      res.json({ success: true, alarm: config.smartAlarms[alarmIndex] });
    } else {
      res.status(500).json({ success: false, error: 'Failed to update smart alarm' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/smart-alarms/:id', (req, res) => {
  try {
    const config = loadConfig();
    const alarmId = req.params.id;
    const alarmIndex = config.smartAlarms.findIndex(alarm => alarm.id === alarmId);
    
    if (alarmIndex === -1) {
      return res.status(404).json({ success: false, error: 'Smart alarm not found' });
    }
    
    config.smartAlarms.splice(alarmIndex, 1);
    
    if (saveConfig(config)) {
      res.json({ success: true });
    } else {
      res.status(500).json({ success: false, error: 'Failed to delete smart alarm' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test smart alarm action
app.post('/api/test-action/:id', async (req, res) => {
  try {
    const config = loadConfig();
    const actionId = req.params.id;
    const action = config.smartAlarms.find(alarm => alarm.id === actionId);
    
    if (!action) {
      return res.status(404).json({ success: false, error: 'Action not found' });
    }
    
    console.log(`🧪 Testing smart alarm action: ${action.name}`);
    
    // Test the action with a simulated entity value
    await triggerSmartAlarmAction(action, config, true); // Simulate entity being active
    
    res.json({ success: true, message: 'Action test completed successfully' });
  } catch (error) {
    console.error('Action test failed:', error);
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
    
    // Send Rust+ notification - Boot sequence started
    await sendRustPlusNotification(`🚀 Boot sequence started! Gaming PC: ${config.gamingPCIP}, Rust Server: ${config.rustServerIP}:${config.rustServerPort}`);
    
    // Step 1: Send WOL packet
    console.log('Sending WOL packet...');
    await sendWOLPacket(config.gamingPCMAC);
    console.log('WOL packet sent successfully');
    
    // Step 2: Wait for PC to be ready
    console.log('Waiting for PC to boot...');
    await waitForPCReady(config.gamingPCIP);
    
    // Send Discord notification - PC is ready
    await sendDiscordNotification(config, `✅ **Gaming PC is ready!**\n\n**PC IP:** ${config.gamingPCIP}\n\nLaunching Rust game...`);
    
    // Send Rust+ notification - PC is ready
    await sendRustPlusNotification(`✅ Gaming PC is ready! IP: ${config.gamingPCIP}, launching Rust game...`);
    
    // Step 3: Launch game
    console.log('Launching game...');
    const launchResult = await launchGame(config.gamingPCIP, config.rustServerIP, config.rustServerPort);
    console.log('Game launched successfully');
    console.log('Launch result:', launchResult);
    
    // Send Discord notification - Boot sequence completed
    await sendDiscordNotification(config, `🎉 **Boot sequence completed successfully!**\n\n**Rust Server:** ${config.rustServerIP}:${config.rustServerPort}\n**Steam URL:** ${launchResult.steam_url}\n\nGame should be starting now!`);
    
    // Send Rust+ notification - Boot sequence completed
    await sendRustPlusNotification(`🎉 Boot sequence completed! Rust Server: ${config.rustServerIP}:${config.rustServerPort}, game should be starting now!`);
    
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
    
    // Send Rust+ notification - Error
    await sendRustPlusNotification(`❌ Boot sequence failed! Error: ${error.message}`);
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`Rust Booter server running on http://localhost:${PORT}`);
  console.log('Configuration file:', CONFIG_FILE);
  
  // Initialize config on startup
  const config = loadConfig();
  console.log('Configuration loaded successfully');
  
  // Initialize WebSocket client
  console.log('🔗 Initializing WebSocket client...');
  initializeWebSocketClient();
  
  // Start connection health check
    startConnectionHealthCheck(config);
});

