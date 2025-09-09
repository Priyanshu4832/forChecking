// client-enhanced.js — Enhanced P2P file transfer with proper pairing
console.log("Enhanced WebRTC Client - P2P file transfer with pairing");

// --- Signaling socket with enhanced configuration ---
const socket = io({
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
  autoConnect: true,
  transports: ['websocket', 'polling']
});

// --- Peer naming & pairing ---
const names = ["lapras","butterfree","gyarados","blastoise","snorlax","psyduck","jigglypuff","bulbasaur"];
const myName = names[Math.floor(Math.random() * names.length)];
let pairedPeer = null;
let isInitiator = false; // Track if we initiated the connection

log(`👤 Your name: ${myName}`);
socket.emit("join", myName);

// --- Globals ---
let pc = null;
let dataChannel = null;
let receiving = {
  active: false,
  meta: null,
  chunks: new Map(),
  receivedBytes: 0,
  startTime: null,
  lastUpdateTime: null,
  lastBytes: 0,
  currentSpeed: 0,
  averageSpeed: 0,
  speedUpdateInterval: null,
  lastUiUpdate: 0
};

// Queue for ICE candidates received before remote description is set
let pendingCandidates = [];

// Enhanced RTC configuration for better connectivity
const RTC_CONFIG = {
  iceServers: [
    // Google's Servers (your original ones)
    // { urls: "stun:stun.l.google.com:19302" },
    // { urls: "stun:stun1.l.google.com:19302" },
    // { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },

    // Other known public STUN servers
    // { urls: "stun:stun.iptel.org" },
    // { urls: "stun:stun.ideasip.com" },
    // { urls: "stun:stun.sipnet.net:3478" },
    // { urls: "stun:stun.rixtelecom.se" },
    { urls: "stun:stun.services.mozilla.com:3478" }
  ],
  iceTransportPolicy: 'all',
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

// Chunk framing constants
const CHUNK_HEADER_BYTES = 12;
const CHUNK_MAGIC = 0x46494C45; // "FILE"

// --- Utilities ---
function log(msg) {
  console.log(msg);
  appendMessage(`[DEBUG] ${msg}`);
}

function appendMessage(msg) {
  const chatBox = document.getElementById("chatBox");
  if (!chatBox) return;
  const ts = new Date().toLocaleTimeString();
  chatBox.innerHTML += `<span style="color:#666;font-size:0.8em;">[${ts}]</span> ${msg}<br>`;
  chatBox.scrollTop = chatBox.scrollHeight;
}

function formatFileSize(n) {
  if (n === 0) return "0 B";
  const units = ["B","KB","MB","GB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return (n / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond > 1024 * 1024) {
    return (bytesPerSecond / (1024 * 1024)).toFixed(1) + " MB/s";
  } else if (bytesPerSecond > 1024) {
    return (bytesPerSecond / 1024).toFixed(1) + " KB/s";
  } else {
    return bytesPerSecond.toFixed(0) + " B/s";
  }
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Reset connection cleanly
function resetConnection() {
  log("Resetting connection...");
  
  if (dataChannel) {
    try { dataChannel.close(); } catch(e){}
    dataChannel = null;
  }
  if (pc) {
    try { pc.close(); } catch(e){}
    pc = null;
  }
  
  receiving = { 
    active: false, 
    meta: null, 
    chunks: new Map(), 
    receivedBytes: 0,
    startTime: null,
    lastUpdateTime: null,
    lastBytes: 0,
    currentSpeed: 0,
    averageSpeed: 0,
    speedUpdateInterval: null,
    lastUiUpdate: 0
  };
  
  pendingCandidates = [];
  //isInitiator = false;
  
  // Update UI state
  if (window.updateUIState) {
    window.updateUIState('disconnected');
  }
}

// Process queued ICE candidates
function processPendingCandidates() {
  if (!pc || !pc.remoteDescription) {
    log("Cannot process candidates - no PC or no remote description");
    return;
  }
  
  log(`Processing ${pendingCandidates.length} queued candidates`);
  
  while (pendingCandidates.length > 0) {
    const candidate = pendingCandidates.shift();
    pc.addIceCandidate(new RTCIceCandidate(candidate))
      .then(() => log("Queued ICE candidate added successfully"))
      .catch(err => log("Error adding queued candidate: " + err.message));
  }
}

// --- Socket event handlers ---

// Update dropdown of available peers
socket.on("available-peers", (list) => {
  const sel = document.getElementById("peerSelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">Select a peer to connect</option>';
  list.filter(n => n !== myName).forEach(n => {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    sel.appendChild(opt);
  });
});

socket.on("paired", (peerName) => {
  pairedPeer = peerName;
  appendMessage(`🔗 Paired with ${peerName}`);
  // Enable start button after pairing
  document.getElementById("startBtn").disabled = false;
});

socket.on("connect-error", (msg) => {
  appendMessage(`❌ Connect error: ${msg}`);
});

// Enhanced connection management
socket.on('connect', () => {
  log('Signaling socket connected');
  if (myName) {
    socket.emit("join", myName);
  }
});

socket.on('disconnect', () => {
  log('Signaling socket disconnected');
  appendMessage('⚠️ Connection lost. Attempting to reconnect...');
  resetConnection();
});

socket.on('reconnect', (attemptNumber) => {
  log(`Reconnected after ${attemptNumber} attempts`);
  appendMessage('✅ Reconnected to server');
  if (myName) {
    socket.emit("join", myName);
  }
});

socket.on('peer-disconnected', (data) => {
  appendMessage(`⚠️ ${data.name} disconnected: ${data.reason}`);
  resetConnection();
  pairedPeer = null;
  document.getElementById("startBtn").disabled = true;
});

// --- Pairing functionality ---
document.getElementById("pairBtn").onclick = () => {
  const target = document.getElementById("peerSelect").value;
  if (!target) {
    alert("No peer selected");
    return;
  }
  socket.emit("connect-request", { from: myName, to: target });
};

// --- WebRTC Connection Management ---

// Create connection (initiator/offerer)
document.getElementById("startBtn").onclick = async () => {
  if (!pairedPeer) {
    alert("Pair with someone first!");
    return;
  }
  
  log("Start clicked — creating PeerConnection as initiator");
  isInitiator = true;
  
  if (window.updateUIState) {
    window.updateUIState('connecting');
  }
  
  try {
    resetConnection();
    pc = new RTCPeerConnection(RTC_CONFIG);
    
    // Create data channel (only initiator creates it)
    dataChannel = pc.createDataChannel("filetransfer", { 
      ordered: true,
      maxRetransmits: null // reliable delivery
    });
    //new addededed
    dataChannel.bufferedAmountLowThreshold = 256 * 1024;
    setupDataChannelHandlers();

    // Set up ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        log("Sending ICE candidate to paired peer");
        socket.emit("candidate", event.candidate);
      } else {
        log("ICE gathering complete (null candidate)");
      }
    };
    
    pc.onconnectionstatechange = () => {
      log(`PC connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        appendMessage("❌ Connection failed. Try again.");
        if (window.updateUIState) {
          window.updateUIState('disconnected');
        }
      } else if (pc.connectionState === 'connected') {
        appendMessage("✅ P2P connection established!");
        if (window.updateUIState) {
          window.updateUIState('connected');
        }
      }
    };
    
    pc.oniceconnectionstatechange = () => {
      log(`ICE connection state: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        appendMessage("❌ ICE connection failed");
        if (window.updateUIState) {
          window.updateUIState('disconnected');
        }
      }
    };

    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    log("Sending offer to paired peer");
    socket.emit("offer", offer);
    appendMessage("📤 Offer created & sent to paired peer.");
    
  } catch (err) {
    log("Start error: " + err.message);
    appendMessage("❌ Error starting connection: " + err.message);
    if (window.updateUIState) {
      window.updateUIState('disconnected');
    }
  }
};

// Handle incoming offer (answerer)
socket.on("offer", async (offer) => {
  if (isInitiator) {
    log("Ignoring offer - we are the initiator");
    return;
  }
  
  log("Received offer — creating answer");
  
  if (window.updateUIState) {
    window.updateUIState('connecting');
  }
  
  try {
    resetConnection();
    pc = new RTCPeerConnection(RTC_CONFIG);
    
    // Set up data channel handler for incoming channel
    pc.ondatachannel = (event) => {
      log("Received data channel from peer");
      dataChannel = event.channel;
      setupDataChannelHandlers();
    };

    // Set up ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        log("Sending ICE candidate (answerer)");
        socket.emit("candidate", event.candidate);
      } else {
        log("ICE gathering complete (answerer)");
      }
    };
    
    pc.onconnectionstatechange = () => {
      log(`PC connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        appendMessage("❌ Connection failed. Try again.");
        if (window.updateUIState) {
          window.updateUIState('disconnected');
        }
      } else if (pc.connectionState === 'connected') {
        appendMessage("✅ P2P connection established!");
        if (window.updateUIState) {
          window.updateUIState('connected');
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      log(`ICE connection state: ${pc.iceConnectionState}`);
    };

    // Set remote description and create answer
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    log("Remote description (offer) set successfully");
    
    // Process any queued candidates
    processPendingCandidates();
    
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    log("Sending answer to peer");
    socket.emit("answer", answer);
    appendMessage("📤 Answer created & sent.");
    
  } catch (err) {
    log("Offer handling error: " + err.message);
    appendMessage("❌ Error handling offer: " + err.message);
    if (window.updateUIState) {
      window.updateUIState('disconnected');
    }
  }
});

// Handle incoming answer
socket.on("answer", async (answer) => {
  if (!isInitiator) {
    log("Ignoring answer - we are not the initiator");
    return;
  }
  
  try {
    if (!pc) { 
      log("No PC when answer arrived"); 
      return; 
    }
    
    log("Received answer from peer");
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    log("Remote description (answer) set successfully");
    
    // Process any queued candidates
    processPendingCandidates();
    
    appendMessage("📥 Answer received - connection establishing...");
    
    // Add a delayed check for data channel status
    setTimeout(() => {
      debugConnectionStatus();
      if (pc && pc.connectionState === 'connected' && (!dataChannel || dataChannel.readyState !== 'open')) {
        log("⚠️ PC connected but data channel not open - this might be a timing issue");
      }
    }, 3000);
    
  } catch (err) {
    log("Error applying answer: " + err.message);
    appendMessage("❌ Error applying answer: " + err.message);
    if (window.updateUIState) {
      window.updateUIState('disconnected');
    }
  }
});

// Handle ICE candidates
socket.on("candidate", async (candidate) => {
  try {
    if (!pc) { 
      log("Candidate received but no PC yet - discarding"); 
      return; 
    }
    
    if (pc.remoteDescription) {
      // Remote description is set, add candidate immediately
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
      log("ICE candidate added immediately");
    } else {
      // Queue candidate until remote description is set
      pendingCandidates.push(candidate);
      log(`Remote description not set - candidate queued (${pendingCandidates.length} total)`);
    }
  } catch (err) {
    log("addIceCandidate error: " + err.message);
  }
});

// --- Data Channel Management ---
function setupDataChannelHandlers() {
  if (!dataChannel) {
    log("setupDataChannelHandlers called but no dataChannel");
    return;
  }
  
  log("Setting up data channel handlers");
  
  dataChannel.onopen = () => {
    log("✅ DataChannel OPENED successfully!");
    appendMessage("✅ Data channel ready — you can send files and chat!");
    
    if (window.updateUIState) {
      window.updateUIState('connected');
    }
  };
  
  dataChannel.onclose = () => {
    log("❌ DataChannel closed");
    appendMessage("❌ Data channel closed");
    
    if (window.updateUIState) {
      window.updateUIState('disconnected');
    }
  };
  
  dataChannel.onerror = (err) => {
    log("❌ DataChannel error: " + (err && err.message ? err.message : err));
    appendMessage("❌ Data channel error occurred");
    
    if (window.updateUIState) {
      window.updateUIState('disconnected');
    }
  };

  dataChannel.onmessage = async (event) => {
    try {
      if (typeof event.data === "string") {
        let msg;
        try { 
          msg = JSON.parse(event.data); 
        } catch (e) { 
          appendMessage(`${pairedPeer || "Peer"}: ${event.data}`); 
          return; 
        }
        
        if (msg.type === "chat") {
          const sender = msg.sender || pairedPeer || "Peer";
          appendMessage(`${sender}: ${msg.message}`);
        } else if (msg.type === "file_start") {
          startFileReceive(msg);
        } else if (msg.type === "file_end") {
          log("file_end received — assembling");
          await finalizeReceive();
        } else {
          log("Unknown control message: " + JSON.stringify(msg));
        }
        return;
      }

      // Handle binary data
      let arrayBuffer;
      if (event.data instanceof Blob) {
        arrayBuffer = await event.data.arrayBuffer();
      } else if (event.data instanceof ArrayBuffer) {
        arrayBuffer = event.data;
      } else {
        log("Unknown binary message type");
        return;
      }
      
      handleFramedChunk(arrayBuffer);
    } catch (err) {
      log("onmessage error: " + err.message);
    }
  };
}

// --- File Receiving Logic ---
function startFileReceive(msg) {
  receiving.active = true;
  receiving.meta = {
    fileName: msg.fileName,
    fileSize: msg.fileSize,
    chunkSize: msg.chunkSize || 16*1024,
    fileType: msg.fileType || "application/octet-stream",
    totalChunks: Math.ceil(msg.fileSize / (msg.chunkSize || 64*1024))
  };
  receiving.chunks = new Map();
  receiving.receivedBytes = 0;
  
  // Initialize speed tracking
  receiving.startTime = Date.now();
  receiving.lastUpdateTime = receiving.startTime;
  receiving.lastBytes = 0;
  receiving.currentSpeed = 0;
  receiving.averageSpeed = 0;
  receiving.lastUiUpdate = 0;
  
  // Start speed updates
  if (receiving.speedUpdateInterval) {
    clearInterval(receiving.speedUpdateInterval);
  }
  receiving.speedUpdateInterval = setInterval(updateReceiveSpeed, 1000);
  
  appendMessage(`📥 Receiving ${receiving.meta.fileName} (${formatFileSize(receiving.meta.fileSize)})`);
  updateReceiveSpeed();
}

let receiveBuffer = new Uint8Array(0);

function handleFramedChunk(newData) {
  if (!receiving.active) return;

  // Append new data to buffer
  const tmp = new Uint8Array(receiveBuffer.length + newData.byteLength);
  tmp.set(receiveBuffer, 0);
  tmp.set(new Uint8Array(newData), receiveBuffer.length);
  receiveBuffer = tmp;

  // Process as many complete chunks as possible
  while (receiveBuffer.length >= CHUNK_HEADER_BYTES) {
    const dv = new DataView(receiveBuffer.buffer, receiveBuffer.byteOffset, receiveBuffer.byteLength);
    const magic = dv.getUint32(0, false);
    if (magic !== CHUNK_MAGIC) {
      console.error("Bad magic in chunk, resetting buffer");
      receiveBuffer = new Uint8Array(0);
      return;
    }

    const idx = dv.getUint32(4, false);
    const len = dv.getUint32(8, false);

    if (receiveBuffer.length < CHUNK_HEADER_BYTES + len) {
      // Not enough data yet → wait for next onmessage
      break;
    }

    // Extract chunk
    const chunkData = receiveBuffer.slice(CHUNK_HEADER_BYTES, CHUNK_HEADER_BYTES + len);

    if (!receiving.chunks.has(idx)) {
      receiving.chunks.set(idx, chunkData);
      receiving.receivedBytes += len;
    }

    // Remove processed bytes
    receiveBuffer = receiveBuffer.slice(CHUNK_HEADER_BYTES + len);
  }
}


function updateReceiveSpeed() {
  if (!receiving.active || !receiving.startTime) return;
  
  const now = Date.now();
  const elapsedTime = (now - receiving.startTime) / 1000;
  
  // Calculate current speed
  if (receiving.lastUpdateTime) {
    const timeDiff = (now - receiving.lastUpdateTime) / 1000;
    const bytesDiff = receiving.receivedBytes - receiving.lastBytes;
    
    if (timeDiff > 0) {
      receiving.currentSpeed = bytesDiff / timeDiff;
    }
  }
  
  // Calculate average speed
  if (elapsedTime > 0) {
    receiving.averageSpeed = receiving.receivedBytes / elapsedTime;
  }
  
  const progress = Math.round((receiving.receivedBytes / receiving.meta.fileSize) * 100);
  const currentSpeedText = formatSpeed(receiving.currentSpeed);
  const averageSpeedText = formatSpeed(receiving.averageSpeed);
  const elapsedTimeText = formatTime(elapsedTime);
  
  document.getElementById("fileStatus").innerHTML = `
    Receiving ${receiving.meta.fileName}... ${progress}%<br>
    Speed: ${currentSpeedText} (Avg: ${averageSpeedText})<br>
    Time: ${elapsedTimeText}
  `;
  
  receiving.lastUpdateTime = now;
  receiving.lastBytes = receiving.receivedBytes;
}

async function finalizeReceive() {
  if (!receiving.active || !receiving.meta) return;
  
  // Clear speed update interval
  if (receiving.speedUpdateInterval) {
    clearInterval(receiving.speedUpdateInterval);
    receiving.speedUpdateInterval = null;
  }
  
  const meta = receiving.meta;
  const expected = meta.totalChunks;

  if (receiving.chunks.size !== expected) {
    appendMessage(`⚠️ Missing chunks: got ${receiving.chunks.size}/${expected}`);
    appendMessage(`❌ Cannot assemble file - missing chunks`);
    document.getElementById("fileStatus").innerText = `Failed to receive ${meta.fileName}`;
    receiving = { 
      active: false, 
      meta: null, 
      chunks: new Map(), 
      receivedBytes: 0,
      startTime: null,
      lastUpdateTime: null,
      lastBytes: 0,
      currentSpeed: 0,
      averageSpeed: 0,
      speedUpdateInterval: null,
      lastUiUpdate: 0
    };
    return;
  }

  // Assemble file
  const parts = [];
  for (let i = 0; i < expected; i++) {
    parts.push(receiving.chunks.get(i));
  }

  const blob = new Blob(parts, { type: meta.fileType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = meta.fileName;
  a.textContent = `📁 Download ${meta.fileName}`;
  a.style.display = "block";
  a.style.margin = "6px 0";
  a.onclick = () => { setTimeout(() => URL.revokeObjectURL(url), 1500); };
  document.getElementById("download").appendChild(a);

  // Display final stats
  const totalTime = (Date.now() - receiving.startTime) / 1000;
  const averageSpeed = receiving.receivedBytes / totalTime;
  
  document.getElementById("fileStatus").innerHTML = `
    ✅ File received: ${meta.fileName}<br>
    Average speed: ${formatSpeed(averageSpeed)}<br>
    Total time: ${formatTime(totalTime)}
  `;
  
  appendMessage(`📁 File ready: ${meta.fileName} (${formatFileSize(blob.size)})`);

  // Reset receiving
  receiving = { 
    active: false, 
    meta: null, 
    chunks: new Map(), 
    receivedBytes: 0,
    startTime: null,
    lastUpdateTime: null,
    lastBytes: 0,
    currentSpeed: 0,
    averageSpeed: 0,
    speedUpdateInterval: null,
    lastUiUpdate: 0
  };
}

// --- File Sending Logic ---
document.getElementById("sendFileBtn").onclick = async () => {
  const fileEl = document.getElementById("fileInput");
  if (!fileEl || !fileEl.files || fileEl.files.length === 0) {
    alert("Choose a file first");
    return;
  }
  if (!dataChannel || dataChannel.readyState !== "open") {
    appendMessage("⚠️ Data channel not open yet.");
    return;
  }
  const file = fileEl.files[0];
  await sendFile(file);
};

async function sendFile(file) {
  const chunkSize = 64 * 1024;
  const totalChunks = Math.ceil(file.size / chunkSize);

  const meta = {
    type: "file_start",
    fileName: file.name,
    fileSize: file.size,
    chunkSize,
    fileType: file.type || "application/octet-stream"
  };
  dataChannel.send(JSON.stringify(meta));
  log(`Sending file: ${file.name}, ${formatFileSize(file.size)}, ${totalChunks} chunks`);

  let offset = 0, idx = 0;
  const start = Date.now();

  try {
    while (offset < file.size) {
      // Backpressure management
      if (dataChannel.bufferedAmount > dataChannel.bufferedAmountLowThreshold) {
        await new Promise(res => {
          const resume = () => {
            dataChannel.removeEventListener("bufferedamountlow", resume);
            res();
          };
          dataChannel.addEventListener("bufferedamountlow", resume);
        });
      }

      const end = Math.min(offset + chunkSize, file.size);
      const slice = file.slice(offset, end);
      const arrayBuffer = await slice.arrayBuffer();

      // Create framed chunk
      const header = new ArrayBuffer(CHUNK_HEADER_BYTES);
      const dv = new DataView(header);
      dv.setUint32(0, CHUNK_MAGIC, false);
      dv.setUint32(4, idx, false);
      dv.setUint32(8, arrayBuffer.byteLength, false);

      const combined = new Uint8Array(CHUNK_HEADER_BYTES + arrayBuffer.byteLength);
      combined.set(new Uint8Array(header), 0);
      combined.set(new Uint8Array(arrayBuffer), CHUNK_HEADER_BYTES);

      dataChannel.send(combined.buffer);

      offset += arrayBuffer.byteLength;
      idx++;

      // Update progress
      const elapsed = Math.max(0.001, (Date.now() - start) / 1000);
      const speed = formatSpeed(offset / elapsed);
      const progress = Math.round((offset / file.size) * 100);
      document.getElementById("fileStatus").innerText =
        `Sending ${file.name}... ${progress}% (${speed})`;
    }

    // Send completion signal
    dataChannel.send(JSON.stringify({ type: "file_end", fileName: file.name }));

    const elapsed = (Date.now() - start) / 1000;
    appendMessage(`✅ Sent ${file.name} (${formatFileSize(file.size)}) in ${elapsed.toFixed(1)}s`);
    document.getElementById("fileStatus").innerText = `File sent: ${file.name}`;

  } catch (err) {
    log("sendFile error: " + err.message);
    appendMessage("❌ Error sending file: " + err.message);
  }

}

// --- Chat Functionality ---
document.getElementById("sendBtn").onclick = () => {
  const input = document.getElementById("msgInput");
  const msg = input.value.trim();
  if (!msg) return;

  if (!dataChannel || dataChannel.readyState !== "open") {
    appendMessage("⚠️ Data channel not open, cannot send chat");
    return;
  }

  const chatMessage = {
    type: "chat",
    message: msg,
    sender: myName,
    timestamp: Date.now()
  };

  dataChannel.send(JSON.stringify(chatMessage));
  appendMessage(`${myName}: ${msg}`);
  input.value = "";
};

// Enter key support for chat
document.getElementById("msgInput").addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    document.getElementById("sendBtn").click();
  }
});

// Initialize UI state
document.getElementById("startBtn").disabled = true;
appendMessage(`🎮 Welcome! Your name is: ${myName}`);
