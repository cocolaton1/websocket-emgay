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

function handleMessage(ws, data, userID) {
    try {
        const messageData = JSON.parse(data);
        
        if (messageData.command === 'Picture Receiver') {
            pictureReceivers.set(userID, ws);
        } else if (messageData.command && messageData.value !== undefined) {
            // If the message has a command and value format, broadcast to all clients
            broadcastToAll(JSON.stringify(messageData));
        } else {
            // For all other messages, broadcast only to picture receivers
            broadcastToPictureReceivers(messageData);
        }
    } catch (e) {
        console.error('Error parsing data:', e);
    }
}

function broadcastToPictureReceivers(message) {
    const data = JSON.stringify(message);
    pictureReceivers.forEach((ws, userId) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data, error => {
                if (error) console.error("Error sending message to receiver:", error);
            });
        }
    });
}

function broadcastToAll(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message, error => {
                if (error) console.error("Error broadcasting message:", error);
            });
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
