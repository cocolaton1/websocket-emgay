import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import fetch from 'node-fetch';
import geoip from 'geoip-lite';
import UAParser from 'ua-parser-js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

let db;
let messagesCollection;
let clientsCollection;

async function connectToMongoDB() {
  try {
    const client = await MongoClient.connect(MONGODB_URI);
    db = client.db();
    messagesCollection = db.collection('messages');
    clientsCollection = db.collection('clients');
    console.log('Connected to MongoDB');
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/chat.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'chat.html'));
});

app.get('/api/messages', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const messages = await messagesCollection.find().sort({ timestamp: -1 }).skip(offset).limit(limit).toArray();
  res.json(messages);
});

const usersInChat = new Map();
const messageReceivers = new Map();

wss.on('connection', async (ws, req) => {
  const userID = crypto.randomUUID();
  usersInChat.set(userID, ws);

  const clientInfo = await getClientInfo(req);
  await clientsCollection.insertOne({ ...clientInfo, userID, connectedAt: new Date() });

  ws.on('message', async (data) => {
    await handleMessage(ws, data, userID);
  });

  ws.on('close', () => {
    handleDisconnect(userID);
  });

  broadcastUserCount();
});

async function getClientInfo(req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];
  const geo = geoip.lookup(ip);
  const ua = UAParser(userAgent);

  return {
    ip,
    country: geo ? geo.country : 'Unknown',
    city: geo ? geo.city : 'Unknown',
    browser: ua.browser.name,
    os: ua.os.name,
    device: ua.device.type || 'desktop'
  };
}

async function handleMessage(ws, data, userID) {
  console.log('Received message:', data.toString());
  
  if (data.toString() === 'Message Receiver') {
    messageReceivers.set(userID, ws);
    ws.send(JSON.stringify({ type: 'userCount', count: usersInChat.size }));
  } else {
    try {
      const messageData = JSON.parse(data.toString());
      
      if (messageData.type === 'chat') {
        const newMessage = {
          id: crypto.randomUUID(),
          userId: userID,
          content: messageData.message.content,
          timestamp: new Date(messageData.message.timestamp)
        };
        
        try {
          await messagesCollection.insertOne(newMessage);
          console.log('Message saved to MongoDB:', newMessage);
          
          // Broadcast the message to all connected clients
          broadcastToAll(JSON.stringify({ type: 'chat', message: newMessage }));
        } catch (error) {
          console.error('Error saving message to MongoDB:', error);
        }
      } else {
        broadcastToAll(JSON.stringify(messageData));
      }
    } catch (e) {
      console.error('Error parsing or processing message:', e);
    }
  }
}

function broadcastToAll(message) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

function handleDisconnect(userID) {
  usersInChat.delete(userID);
  messageReceivers.delete(userID);
  clientsCollection.updateOne({ userID }, { $set: { disconnectedAt: new Date() } });
  broadcastUserCount();
}

function broadcastUserCount() {
  const userCount = usersInChat.size;
  const message = JSON.stringify({ type: 'userCount', count: userCount });
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

async function startServer() {
  await connectToMongoDB();
  server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

startServer();
