const express = require('express');
const cors = require('cors');
const wol = require('wake_on_lan');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { Webhook } = require('discord-webhook-node');
const RustPlus = require('@liamcottle/rustplus.js');
const { v4: uuidv4 } = require('uuid');
const PushReceiverClient = require('@liamcottle/push-receiver/src/client');
const AndroidFCM = require('@liamcottle/push-receiver/src/android/fcm');

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
  rustPlusServerIP: '',
  rustPlusServerPort: 28082,
  rustPlusPlayerId: '',
  rustPlusPlayerToken: '',
  rustPlusTokenExpiry: '',
  rustPlusServerName: '',
  fcmCredentials: null,
  smartAlarms: [],
  detectedEntities: {}
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

// Rust+ connection and notifications
let rustPlusClient = null;
let fcmClient = null;

// Get Expo Push Token
async function getExpoPushToken(fcmToken) {
  const response = await axios.post('https://exp.host/--/api/v2/push/getExpoPushToken', {
    type: 'fcm',
    deviceId: uuidv4(),
    development: false,
    appId: 'com.facepunch.rust.companion',
    deviceToken: fcmToken,
    projectId: "49451aca-a822-41e6-ad59-955718d0ff9c",
  });
  return response.data.data.expoPushToken;
}

// Register with Rust+ API
async function registerWithRustPlus(authToken, expoPushToken) {
  return axios.post('https://companion-rust.facepunch.com:443/api/push/register', {
    AuthToken: authToken,
    DeviceId: 'rust-booter',
    PushKind: 3,
    PushToken: expoPushToken,
  });
}

// FCM Registration
async function registerFCM() {
  try {
    console.log('🔧 Registering FCM credentials...');
    
    // Use the proper FCM registration method with Rust+ specific credentials
    const apiKey = "AIzaSyB5y2y-Tzqb4-I4Qnlsh_9naYv_TD8pCvY";
    const projectId = "rust-companion-app";
    const gcmSenderId = "976529667804";
    const gmsAppId = "1:976529667804:android:d6f1ddeb4403b338fea619";
    const androidPackageName = "com.facepunch.rust.companion";
    const androidPackageCert = "E28D05345FB78A7A1A63D70F4A302DBF426CA5AD";
    
    const credentials = await AndroidFCM.register(
      apiKey, 
      projectId, 
      gcmSenderId, 
      gmsAppId, 
      androidPackageName, 
      androidPackageCert
    );
    
    console.log('✅ FCM credentials registered successfully');
    
    // Get Expo push token
    console.log('🔧 Fetching Expo Push Token...');
    const expoPushToken = await getExpoPushToken(credentials.fcm.token);
    console.log('✅ Expo Push Token:', expoPushToken);
    
    // Register with Rust+ API (we'll need the auth token from the user)
    console.log('⚠️  Note: You need to provide your Rust+ auth token to complete registration');
    
    return {
      ...credentials,
      expoPushToken: expoPushToken
    };
  } catch (error) {
    console.error('❌ FCM registration failed:', error);
    throw error;
  }
}

// FCM Listen for notifications
async function fcmListen(config) {
  if (!config.fcmCredentials) {
    throw new Error('FCM Credentials missing. Please register FCM first.');
  }

  console.log('📡 Listening for FCM Notifications');
  const androidId = config.fcmCredentials.gcm.androidId;
  const securityToken = config.fcmCredentials.gcm.securityToken;
  
  fcmClient = new PushReceiverClient(androidId, securityToken, []);
  
  fcmClient.on('ON_DATA_RECEIVED', (data) => {
    const timestamp = new Date().toLocaleString();
    console.log(`\x1b[32m%s\x1b[0m`, `[${timestamp}] FCM Notification Received`);
    console.log('FCM Data:', data);
    
    // Handle Rust+ pairing notification
    handleRustPlusPairing(data);
  });

  // Force exit on ctrl + c
  process.on('SIGINT', async () => {
    if (fcmClient) {
      await fcmClient.disconnect();
    }
    process.exit(0);
  });

  await fcmClient.connect();
  console.log('✅ FCM listener connected');
}

// Handle Rust+ pairing notification
function handleRustPlusPairing(data) {
  console.log('🔗 Processing Rust+ pairing data:', data);
  
    try {
      // Extract pairing information from FCM appData
      const bodyData = data.appData.find(item => item.key === 'body');
      if (bodyData && bodyData.value) {
        const pairingInfo = JSON.parse(bodyData.value);
        
        // Check if this is a server pairing notification
        if (pairingInfo.type === 'server') {
          console.log('✅ Rust+ server pairing successful!');
          console.log(`Server: ${pairingInfo.ip}:${pairingInfo.port}`);
          console.log(`Player ID: ${pairingInfo.playerId}`);
          console.log(`Player Token: ${pairingInfo.playerToken}`);
          console.log(`Server Name: ${pairingInfo.name}`);
          
          // Update configuration with pairing data
          const config = loadConfig();
          const updatedConfig = {
            ...config,
            rustPlusServerIP: pairingInfo.ip,
            rustPlusServerPort: parseInt(pairingInfo.port),
            rustPlusPlayerId: pairingInfo.playerId,
            rustPlusPlayerToken: pairingInfo.playerToken,
            rustPlusServerName: pairingInfo.name
          };
          
          if (saveConfig(updatedConfig)) {
            console.log('✅ Configuration updated with server pairing data');
            
            // Connect to Rust+ server
            connectToRustPlus(updatedConfig);
          } else {
            console.error('❌ Failed to save pairing data to config');
          }
        }
        // Check if this is a smart device pairing notification
        else if (pairingInfo.type === 'entity' || pairingInfo.entityId) {
          console.log('✅ Smart device pairing detected!');
          console.log(`Entity ID: ${pairingInfo.entityId}`);
          console.log(`Entity Type: ${pairingInfo.entityType || 'unknown'}`);
          console.log(`Entity Name: ${pairingInfo.entityName || 'Unnamed Device'}`);
          
          // Store the smart device information
          const config = loadConfig();
          if (!config.detectedEntities) {
            config.detectedEntities = {};
          }
          
          // Update server IP if it's different (smart device notifications also contain server info)
          if (pairingInfo.ip && pairingInfo.ip !== config.rustPlusServerIP) {
            console.log(`🔄 Updating server IP from ${config.rustPlusServerIP} to ${pairingInfo.ip}`);
            config.rustPlusServerIP = pairingInfo.ip;
            config.rustPlusServerPort = parseInt(pairingInfo.port) || config.rustPlusServerPort;
            config.rustPlusPlayerId = pairingInfo.playerId || config.rustPlusPlayerId;
            config.rustPlusPlayerToken = pairingInfo.playerToken || config.rustPlusPlayerToken;
            config.rustPlusServerName = pairingInfo.name || config.rustPlusServerName;
          }
          
          // Check if entity is already paired
          if (config.detectedEntities[pairingInfo.entityId]) {
            console.log(`⏸️ Entity ${pairingInfo.entityId} is already paired - skipping`);
            // Update lastChanged timestamp but preserve existing name
            config.detectedEntities[pairingInfo.entityId].lastChanged = new Date().toISOString();
            config.detectedEntities[pairingInfo.entityId].paired = true;
            saveConfig(config);
            return;
          }
          
          config.detectedEntities[pairingInfo.entityId] = {
            id: pairingInfo.entityId,
            name: pairingInfo.entityName || `Smart Device ${pairingInfo.entityId}`,
            type: pairingInfo.entityType || 'unknown',
            lastValue: false,
            lastChanged: new Date().toISOString(),
            paired: true
          };
          
          if (saveConfig(config)) {
            console.log('✅ Smart device added to detected entities');
            
            // If server IP changed, reconnect to the new server
            if (pairingInfo.ip && pairingInfo.ip !== config.rustPlusServerIP) {
              console.log('🔄 Server IP changed - reconnecting to new server...');
              if (rustPlusClient) {
                rustPlusClient.disconnect();
              }
              setTimeout(() => {
                connectToRustPlus(config);
              }, 2000); // Wait 2 seconds before reconnecting
            }
            
            // Subscribe to entity broadcasts by calling getEntityInfo
            if (rustPlusClient && rustPlusClient.isConnected()) {
              console.log(`📡 Subscribing to entity broadcasts for ${pairingInfo.entityId}...`);
              rustPlusClient.getEntityInfo(pairingInfo.entityId, (message) => {
                console.log(`📊 Entity info received for ${pairingInfo.entityId}:`, JSON.stringify(message, null, 2));
              });
            } else {
              console.log('⚠️ Rust+ client not connected - will subscribe when connected');
            }
          } else {
            console.error('❌ Failed to save smart device information');
          }
        }
        else if (pairingInfo.type === 'alarm') {
          console.log('🔔 Alarm notification received (not a smart device pairing)');
          console.log(`Alarm Message: ${data.appData.find(item => item.key === 'message')?.value || 'Unknown'}`);
          // Don't process as entity pairing - these are just alarm notifications
        }
        else {
          console.log('⚠️ Unknown pairing type:', pairingInfo.type);
          console.log('Full pairing data:', pairingInfo);
        }
      } else {
        console.log('⚠️  No pairing data found in FCM notification');
      }
    } catch (error) {
    console.error('❌ Error processing pairing data:', error);
  }
}

// Connect to Rust+ server
async function connectToRustPlus(config) {
  if (!config.rustPlusServerIP || !config.rustPlusPlayerId || !config.rustPlusPlayerToken) {
    console.log('⚠️ Rust+ connection skipped - missing credentials');
    return null;
  }

  // Prevent multiple simultaneous connection attempts
  if (isConnecting) {
    console.log('⚠️ Rust+ connection already in progress - skipping duplicate attempt');
    return null;
  }

  // Check if we're already connected to avoid duplicate connections
  try {
    if (rustPlusClient && rustPlusClient.isConnected()) {
      console.log('⚠️ Rust+ already connected - skipping duplicate connection');
      return rustPlusClient;
    }
  } catch (error) {
    console.log('⚠️ Error checking existing connection, proceeding with new connection:', error.message);
    // Continue with new connection attempt
  }

  isConnecting = true;

  try {
    console.log(`🔗 Connecting to Rust+ server: ${config.rustPlusServerIP}:${config.rustPlusServerPort}`);
    
    // Add connection timeout
    const connectionTimeout = setTimeout(() => {
      console.log('⏰ Connection timeout - server may be down or unreachable');
      if (rustPlusClient) {
        rustPlusClient.disconnect();
      }
    }, 15000); // 15 second timeout
    
    rustPlusClient = new RustPlus(config.rustPlusServerIP, config.rustPlusServerPort, config.rustPlusPlayerId, config.rustPlusPlayerToken);
    
    // Set up event listeners
  rustPlusClient.on('connected', () => {
    console.log('✅ Connected to Rust+ server');
    isConnecting = false; // Reset connection flag
    clearTimeout(connectionTimeout); // Clear the timeout since we connected
    // Start listening for smart alarm messages
    startSmartAlarmListener(config);
    
    // Request initial data to start receiving broadcasts
    console.log('📡 Requesting initial server data to start receiving messages...');
    
    // Wait for WebSocket to be fully ready before sending requests
    setTimeout(() => {
      if (rustPlusClient && rustPlusClient.isConnected()) {
        console.log('📡 WebSocket is ready, sending initial requests...');
        
        // Get server info to start receiving broadcasts
        rustPlusClient.getInfo((message) => {
          console.log('📊 Server info received:', JSON.stringify(message, null, 2));
        });
        
        // Get team info to start receiving team messages
        rustPlusClient.getTeamInfo((message) => {
          console.log('👥 Team info received:', JSON.stringify(message, null, 2));
        });
        
        // Get time to start receiving time updates
        rustPlusClient.getTime((message) => {
          console.log('⏰ Time info received:', JSON.stringify(message, null, 2));
        });
        
        // Subscribe to existing smart alarms for broadcasts
        setTimeout(() => {
          subscribeToExistingEntities(config);
        }, 2000); // Wait 2 more seconds for initial requests to complete
      } else {
        console.log('⚠️ WebSocket not ready, skipping initial requests');
      }
    }, 1000); // Wait 1 second for WebSocket to stabilize
  });
    
    rustPlusClient.on('disconnected', () => {
      console.log('❌ Disconnected from Rust+ server - attempting to reconnect in 5 seconds...');
      isConnecting = false; // Reset connection flag
      // Auto-reconnect after 5 seconds
      setTimeout(() => {
        if (config.rustPlusServerIP && config.rustPlusPlayerId && config.rustPlusPlayerToken) {
          console.log('🔄 Attempting to reconnect to Rust+ server...');
          connectToRustPlus(config);
        }
      }, 5000);
    });
    
    rustPlusClient.on('error', (error) => {
      console.error('❌ Rust+ error:', error);
      isConnecting = false; // Reset connection flag
      clearTimeout(connectionTimeout); // Clear timeout on error
      
      // Only attempt to reconnect for certain errors, not timeouts
      if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
        console.log('⚠️ Server appears to be down or unreachable - will retry less frequently');
        // Longer delay for connection issues
        setTimeout(() => {
          if (config.rustPlusServerIP && config.rustPlusPlayerId && config.rustPlusPlayerToken) {
            console.log('🔄 Attempting to reconnect to Rust+ server after connection error...');
            connectToRustPlus(config);
          }
        }, 30000); // 30 second delay for connection issues
      } else {
        // Shorter delay for other errors
        setTimeout(() => {
          if (config.rustPlusServerIP && config.rustPlusPlayerId && config.rustPlusPlayerToken) {
            console.log('🔄 Attempting to reconnect to Rust+ server after error...');
            connectToRustPlus(config);
          }
        }, 10000);
      }
    });
    
    rustPlusClient.on('entityChanged', (entity) => {
      console.log(`🔧 Entity changed: ${entity.entityId} - ${entity.value}`);
    });
    
    rustPlusClient.on('teamChanged', (teamInfo) => {
      console.log('👥 Team info updated:', teamInfo);
    });
    
    // Listen for all messages for smart alarms
    rustPlusClient.on('message', (message) => {
      console.log('📨 Rust+ Message Event:', JSON.stringify(message, null, 2));
      processSmartAlarmMessage(message, config);
    });
    
    rustPlusClient.on('teamMessage', (message) => {
      console.log(`💬 Team message: ${message.message}`);
    });
    
    rustPlusClient.on('entityInfo', (entityInfo) => {
      console.log(`📊 Entity info: ${entityInfo.entityId} - ${entityInfo.value}`);
    });
    
    // Connect to the server
    await rustPlusClient.connect();
    
    return rustPlusClient;
  } catch (error) {
    console.error('Failed to connect to Rust+ server:', error);
    isConnecting = false; // Reset connection flag
    // Attempt to reconnect on connection failure
    setTimeout(() => {
      if (config.rustPlusServerIP && config.rustPlusPlayerId && config.rustPlusPlayerToken) {
        console.log('🔄 Attempting to reconnect to Rust+ server after connection failure...');
        connectToRustPlus(config);
      }
    }, 15000);
    return null;
  }
}

// Smart Alarm Functions
function startSmartAlarmListener(config) {
  console.log('🔔 Smart alarm listener started');
}

// Subscribe to existing entities for broadcasts
function subscribeToExistingEntities(config) {
  if (!rustPlusClient || !rustPlusClient.isConnected()) {
    console.log('⚠️ Cannot subscribe to entities - not connected to Rust+');
    return;
  }

  if (!config.detectedEntities || Object.keys(config.detectedEntities).length === 0) {
    console.log('📡 No entities to subscribe to');
    return;
  }

  console.log('📡 Subscribing to existing entities for broadcasts...');
  
  Object.values(config.detectedEntities).forEach(entity => {
    console.log(`📡 Subscribing to entity ${entity.id} (${entity.name})...`);
    rustPlusClient.getEntityInfo(entity.id, (message) => {
      console.log(`📊 Entity info received for ${entity.id}:`, JSON.stringify(message, null, 2));
    });
  });
}

// Connection health check
function startConnectionHealthCheck(config) {
  setInterval(() => {
    if (config.rustPlusServerIP && config.rustPlusPlayerId && config.rustPlusPlayerToken) {
      if (!rustPlusClient || !rustPlusClient.isConnected()) {
        console.log('🔄 Rust+ connection lost - attempting to reconnect...');
        connectToRustPlus(config);
        } else {
          // Keep connection active by requesting data periodically (less frequently to avoid rate limits)
          console.log('🔄 Keeping Rust+ connection active...');
          try {
            if (rustPlusClient && rustPlusClient.isConnected()) {
              rustPlusClient.getTime((message) => {
                console.log('⏰ Periodic time check:', JSON.stringify(message, null, 2));
              });
            } else {
              console.log('⚠️ Rust+ client not ready for periodic check');
            }
          } catch (error) {
            console.log('⚠️ Error during periodic Rust+ check:', error.message);
          }
        }
      }
    }, 60000); // Check every 60 seconds (reduced frequency)
}

function processSmartAlarmMessage(message, config) {
  // Always log every single Rust+ message
  console.log('📨 Rust+ Message Received:', JSON.stringify(message, null, 2));
  
  // Load fresh config to avoid stale data
  const freshConfig = loadConfig();

  // Check for entity changes (like smart alarms)
  if (message.broadcast && message.broadcast.entityChanged) {
    const entityChanged = message.broadcast.entityChanged;
    const entityId = entityChanged.entityId;
    const rawValue = entityChanged.payload.value;
    
    // Handle null/undefined values - treat empty payload as "inactive"
    let value;
    if (rawValue === null || rawValue === undefined) {
      console.log(`🔧 Entity Changed Debug: ID=${entityId}, Raw Value=${rawValue} - Treating as inactive (empty payload)`);
      value = false; // Empty payload means entity is inactive
    } else {
      value = rawValue; // Use the actual value
    }
    
    console.log(`🔧 Entity Changed Debug: ID=${entityId}, Raw Value=${rawValue}, Final Value=${value}, Type=${typeof rawValue}`);
    console.log(`🔧 Entity ${entityId} is now ${value ? "active" : "inactive"}`);
    
    // Store the entity info for the frontend to use
    if (!freshConfig.detectedEntities) {
      freshConfig.detectedEntities = {};
    }
    
    // Check if entity already exists to preserve its name
    const existingEntity = freshConfig.detectedEntities[entityId];
    const entityName = existingEntity ? existingEntity.name : `Entity ${entityId}`;
    
    freshConfig.detectedEntities[entityId] = {
      id: entityId,
      lastValue: value,
      lastChanged: new Date().toISOString(),
      name: entityName, // Preserve existing name or use default
      type: existingEntity ? existingEntity.type : 'unknown',
      paired: existingEntity ? existingEntity.paired : false
    };
    
    // Debug: Log smart alarms before save
    console.log(`🔍 Before save - Smart alarms:`, JSON.stringify(freshConfig.smartAlarms, null, 2));
    
    // Save the updated config with detected entities
    saveConfig(freshConfig);
    
    // Debug: Log smart alarms after save (reload to verify)
    const reloadedConfig = loadConfig();
    console.log(`🔍 After save - Smart alarms:`, JSON.stringify(reloadedConfig.smartAlarms, null, 2));
    
    // Check each smart alarm rule for entity changes
    if (freshConfig.smartAlarms && freshConfig.smartAlarms.length > 0) {
      freshConfig.smartAlarms.forEach((alarm, index) => {
        if (alarm.enabled && alarm.entityId === entityId.toString()) {
          // Check if the trigger condition matches
          // triggerOnActivation = true means trigger when entity becomes active (value = true)
          // triggerOnActivation = false means trigger when entity becomes inactive (value = false)
          // Default to true (activation) if not set for backward compatibility
          const triggerOnActivation = alarm.triggerOnActivation !== undefined ? alarm.triggerOnActivation : true;
          const shouldTrigger = triggerOnActivation ? value : !value;
          
          
          if (shouldTrigger) {
            console.log(`🚨 Smart alarm triggered: ${alarm.name} (Entity ${entityId} is now ${value ? "active" : "inactive"}) - Trigger: ${triggerOnActivation ? "Activation" : "Deactivation"}`);
            triggerSmartAlarmAction(alarm, freshConfig, value);
          } else {
            console.log(`⏸️ Smart alarm condition not met: ${alarm.name} (Entity ${entityId} is ${value ? "active" : "inactive"}, but trigger is set to ${triggerOnActivation ? "Activation" : "Deactivation"})`);
          }
        }
      });
    }
  }

  // Check for team messages and other message types
  if (message.broadcast && message.broadcast.teamMessage) {
    const teamMessage = message.broadcast.teamMessage;
    console.log(`💬 Team Message: ${teamMessage.message}`);
    
    // Check smart alarms for team message content filtering
    if (config.smartAlarms && config.smartAlarms.length > 0) {
      config.smartAlarms.forEach((alarm, index) => {
        if (alarm.enabled && alarm.messageFilter && alarm.messageFilter.trim() !== '') {
          const messageContent = teamMessage.message.toLowerCase();
          const filterContent = alarm.messageFilter.toLowerCase();
          
          if (messageContent.includes(filterContent)) {
            console.log(`🚨 Smart alarm triggered by team message: ${alarm.name}`);
            triggerSmartAlarmAction(alarm, config);
          }
        }
      });
    }
  }

  // Log any other message types
  if (message.broadcast) {
    console.log('📡 Broadcast message type:', Object.keys(message.broadcast));
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

// Send Rust+ notification
async function sendRustPlusNotification(message) {
  if (!rustPlusClient) {
    console.log('Rust+ client not available, skipping notification');
    return;
  }

  try {
    // Wait for connection using the connected event (following the example pattern)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000); // 10 second timeout

      rustPlusClient.once('connected', () => {
        clearTimeout(timeout);
        resolve();
      });

      rustPlusClient.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    // Now send the message after connection is established
    await rustPlusClient.sendTeamMessage(message);
    console.log('✅ Rust+ notification sent:', message);
  } catch (error) {
    console.error('❌ Failed to send Rust+ notification:', error);
    throw error;
  }
}

// Disconnect from Rust+ server
async function disconnectFromRustPlus() {
  if (rustPlusClient && rustPlusClient.isConnected()) {
    try {
      await rustPlusClient.disconnect();
      console.log('✅ Disconnected from Rust+ server');
    } catch (error) {
      console.error('Error disconnecting from Rust+ server:', error);
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

// Register FCM credentials
app.post('/api/rust-plus/register-fcm', async (req, res) => {
  try {
    console.log('🔧 Registering FCM credentials...');
    
    const credentials = await registerFCM();
    
    // Save credentials to config
    const config = loadConfig();
    const updatedConfig = {
      ...config,
      fcmCredentials: credentials
    };
    
    if (saveConfig(updatedConfig)) {
      res.json({ 
        success: true, 
        message: 'FCM credentials registered successfully',
        credentials: credentials
      });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save FCM credentials' });
    }
  } catch (error) {
    console.error('FCM registration failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Register with Rust+ API using auth token
app.post('/api/rust-plus/register-rustplus', async (req, res) => {
  try {
    const { authToken } = req.body;
    
    if (!authToken) {
      return res.status(400).json({ 
        success: false, 
        error: 'Auth token is required' 
      });
    }
    
    const config = loadConfig();
    
    if (!config.fcmCredentials || !config.fcmCredentials.expoPushToken) {
      return res.status(400).json({ 
        success: false, 
        error: 'FCM credentials missing. Please register FCM first.' 
      });
    }
    
    console.log('🔧 Registering with Rust+ API...');
    await registerWithRustPlus(authToken, config.fcmCredentials.expoPushToken);
    
    // Save auth token to config
    const updatedConfig = {
      ...config,
      rustPlusAuthToken: authToken
    };
    
    if (saveConfig(updatedConfig)) {
      console.log('✅ Successfully registered with Rust+ API');
      res.json({ 
        success: true, 
        message: 'Successfully registered with Rust+ API' 
      });
    } else {
      res.status(500).json({ success: false, error: 'Failed to save auth token' });
    }
  } catch (error) {
    console.error('Rust+ registration failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start FCM listening
app.post('/api/rust-plus/start-fcm-listen', async (req, res) => {
  try {
    const config = loadConfig();
    
    if (!config.fcmCredentials) {
      return res.status(400).json({ 
        success: false, 
        error: 'FCM credentials missing. Please register FCM first.' 
      });
    }
    
    console.log('📡 Starting FCM listener...');
    await fcmListen(config);
    
    res.json({ 
      success: true, 
      message: 'FCM listener started. Waiting for Rust+ pairing notification...' 
    });
  } catch (error) {
    console.error('FCM listen failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test Rust+ connection
app.post('/api/test-rust-plus', async (req, res) => {
  try {
    const { serverIP, serverPort, playerId, playerToken } = req.body;
    
    if (!serverIP || !playerId || !playerToken) {
      return res.status(400).json({ success: false, error: 'Server IP, Player ID, and Player Token are required' });
    }
    
    const testConfig = {
      rustPlusEnabled: true,
      rustPlusServerIP: serverIP,
      rustPlusServerPort: parseInt(serverPort) || 28082,
      rustPlusPlayerId: playerId,
      rustPlusPlayerToken: playerToken
    };
    
    // Test connection
    const testClient = await connectToRustPlus(testConfig);
    
    if (testClient) {
      // Send test message
      await sendRustPlusNotification('🧪 Rust+ Test Notification - This is a test message from your Rust Booter system!');
      
      // Disconnect test client
      await disconnectFromRustPlus();
      
      res.json({ success: true, message: 'Rust+ test notification sent successfully' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to connect to Rust+ server' });
    }
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
    
    if (!config.detectedEntities || !config.detectedEntities[entityId]) {
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

// Get Rust+ connection status
app.get('/api/rust-plus-status', (req, res) => {
  try {
    const config = loadConfig();
    
    if (!config.rustPlusServerIP || !config.rustPlusPlayerId || !config.rustPlusPlayerToken) {
      return res.json({ 
        connected: false, 
        connecting: false, 
        error: 'No Rust+ credentials configured' 
      });
    }
    
    if (!rustPlusClient) {
      return res.json({ 
        connected: false, 
        connecting: false, 
        error: 'Rust+ client not initialized' 
      });
    }
    
    let connected = false;
    let connecting = false;
    
    try {
      connected = rustPlusClient.isConnected();
      connecting = !connected && config.rustPlusServerIP; // Assume connecting if we have credentials but not connected
    } catch (error) {
      console.log('⚠️ Error checking Rust+ connection status:', error.message);
      connected = false;
      connecting = false;
    }
    
    res.json({ 
      connected: connected,
      connecting: connecting,
      serverIP: config.rustPlusServerIP,
      serverPort: config.rustPlusServerPort,
      serverName: config.rustPlusServerName
    });
  } catch (error) {
    res.status(500).json({ 
      connected: false, 
      connecting: false, 
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
  
  // Start FCM listener if we have credentials
  if (config.fcmCredentials && config.fcmCredentials.fcm && config.fcmCredentials.fcm.token) {
    console.log('🔧 Starting FCM listener on startup...');
    fcmListen(config);
  } else {
    console.log('⚠️ No FCM credentials found - FCM listener not started');
  }
  
  // Connect to Rust+ if server is paired (but wait a bit to see if FCM updates the server IP)
  if (config.rustPlusServerIP && config.rustPlusPlayerId && config.rustPlusPlayerToken) {
    console.log('🔗 Will attempt Rust+ connection after FCM listener stabilizes...');
    // Wait 5 seconds to see if FCM notifications update the server IP
    setTimeout(async () => {
      const currentConfig = loadConfig();
      if (currentConfig.rustPlusServerIP && currentConfig.rustPlusPlayerId && currentConfig.rustPlusPlayerToken) {
        console.log('🔗 Connecting to Rust+ server...');
        await connectToRustPlus(currentConfig);
      }
    }, 5000);
  } else {
    console.log('⚠️ No Rust+ server paired - skipping connection');
  }
  
  // Start connection health check (only if we have server credentials)
  if (config.rustPlusServerIP && config.rustPlusPlayerId && config.rustPlusPlayerToken) {
    startConnectionHealthCheck(config);
  }
});
