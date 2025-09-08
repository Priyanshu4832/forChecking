const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const os = require('os');

// Server configuration
const SERVER_PORT = process.env.PORT || 3000;
const SERVER_HOST = "0.0.0.0";

// CORS configuration for cross-device compatibility
const CORS_CONFIG = {
  origin: "*",
  methods: ["GET", "POST"],
  credentials: true
};

// Socket.IO configuration for better device compatibility
const SOCKET_CONFIG = {
  cors: CORS_CONFIG,
  transports: ['websocket', 'polling'], // Support devices with WebSocket issues
  pingTimeout: 60000, // Increased timeout for mobile devices
  pingInterval: 25000,
  maxHttpBufferSize: 1e8, // 100MB for large file transfers
  allowEIO3: true, // Enable Engine.IO v3 compatibility
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  }
};

// Initialize server
const app = express();
const server = http.createServer(app);
const io = new Server(server, SOCKET_CONFIG);

// Middleware for CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// Serve static files if needed
app.use(express.static("public"));

// Data structures for managing peers
const peers = new Map(); // socket.id -> { name, pairedWith, lastSeen }

// Utility function to get local IP address
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return 'localhost';
}

// Broadcast available peers to all clients
function broadcastAvailablePeers() {
  const availablePeers = Array.from(peers.values())
    .filter(peer => !peer.pairedWith)
    .map(peer => peer.name);
  
  io.emit("available-peers", availablePeers);
}

// Clean up disconnected peers (runs every 30 seconds)
setInterval(() => {
  const now = Date.now();
  let cleaned = false;
  
  for (const [socketId, peer] of peers.entries()) {
    // Remove peers that haven't been seen for over 2 minutes
    if (now - peer.lastSeen > 120000) {
      peers.delete(socketId);
      cleaned = true;
    }
  }
  
  if (cleaned) {
    broadcastAvailablePeers();
  }
}, 30000);

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log(`Device connected: ${socket.id}`);
  
  // Update peer information on join
  socket.on("join", (name) => {
    peers.set(socket.id, { 
      name, 
      pairedWith: null, 
      lastSeen: Date.now(),
      userAgent: socket.handshake.headers['user-agent'] || 'Unknown'
    });
    
    console.log(`${name} joined from ${socket.handshake.address}`);
    broadcastAvailablePeers();
  });

  // Handle pairing requests
  socket.on("connect-request", ({ from, to }) => {
    const fromPeer = Array.from(peers.entries()).find(([_, peer]) => peer.name === from);
    const toPeer = Array.from(peers.entries()).find(([_, peer]) => peer.name === to);

    if (!fromPeer || !toPeer) {
      socket.emit("connect-error", "Peer not found");
      return;
    }

    if (fromPeer[1].pairedWith || toPeer[1].pairedWith) {
      socket.emit("connect-error", "One of the peers is already paired");
      return;
    }

    // Establish pairing
    peers.get(fromPeer[0]).pairedWith = toPeer[0];
    peers.get(toPeer[0]).pairedWith = fromPeer[0];
    peers.get(fromPeer[0]).lastSeen = Date.now();
    peers.get(toPeer[0]).lastSeen = Date.now();

    // Notify both peers
    io.to(fromPeer[0]).emit("paired", to);
    io.to(toPeer[0]).emit("paired", from);
    
    console.log(`${from} paired with ${to}`);
    broadcastAvailablePeers();
  });

  // Handle WebRTC signaling
  const handleSignaling = (eventName) => {
    return (data) => {
      const peer = peers.get(socket.id);
      if (peer && peer.pairedWith) {
        io.to(peer.pairedWith).emit(eventName, data);
      }
    };
  };

  socket.on("offer", handleSignaling("offer"));
  socket.on("answer", handleSignaling("answer"));
  
  socket.on("candidate", (data) => {
  const peer = peers.get(socket.id);
  console.log(`Got candidate from ${peer?.name}, pairedWith=${peer?.pairedWith}`);
  if (peer && peer.pairedWith) {
    io.to(peer.pairedWith).emit("candidate", data);
  } else {
    console.log(`Dropping candidate from ${peer?.name}`);
  }
});

  // Handle disconnection
  socket.on("disconnect", (reason) => {
    const peer = peers.get(socket.id);
    
    if (peer) {
      console.log(`${peer.name} disconnected: ${reason}`);
      
      // Notify paired peer about disconnection
      if (peer.pairedWith) {
        const partner = peers.get(peer.pairedWith);
        if (partner) {
          partner.pairedWith = null;
          io.to(peer.pairedWith).emit("peer-disconnected", {
            name: peer.name,
            reason: reason
          });
        }
      }
      
      peers.delete(socket.id);
      broadcastAvailablePeers();
    }
  });

  // Handle connection errors
  socket.on("error", (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
});

// Start the server
server.listen(SERVER_PORT, SERVER_HOST, () => {
  const ip = getLocalIpAddress();
  console.log("WebRTC Signaling Server running on:");
  console.log(`- Local: http://localhost:${SERVER_PORT}`);
  console.log(`- Network: http://${ip}:${SERVER_PORT}`);
  console.log(`- Environment: ${process.env.NODE_ENV || 'development'}`);
});

