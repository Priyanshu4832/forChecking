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

//new added
let pendingCandidates = [];

// Enhanced RTC configuration for better connectivity
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // { urls: "stun:stun2.l.google.com:19302" },
    // { urls: "stun:stun3.l.google.com:19302" },
    // { urls: "stun:stun4.l.google.com:19302" },
    // { urls: "stun:stun.services.mozilla.com:3478" }
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
  isInitiator = false;
}




//new added
// Process queued ICE candidates
function processPendingCandidates() {
  if (!pc) return;
  
  while (pendingCandidates.length > 0) {
    const candidate = pendingCandidates.shift();
    pc.addIceCandidate(new RTCIceCandidate(candidate))
      .then(() => log("Queued ICE candidate added"))
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
  
  try {
    resetConnection();
    pc = new RTCPeerConnection(RTC_CONFIG);
    
    // Create data channel (only initiator creates it)
    dataChannel = pc.createDataChannel("filetransfer", { 
      ordered: true,
      maxRetransmits: null // reliable delivery
    });
    setupDataChannelHandlers();

    // Set up ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        log("Sending ICE candidate");
        socket.emit("candidate", event.candidate);
      } else {
        log("ICE gathering complete");
      }
    };
    
    pc.onconnectionstatechange = () => {
      log(`PC connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        appendMessage("❌ Connection failed. Try again.");
      } else if (pc.connectionState === 'connected') {
        appendMessage("✅ P2P connection established!");
      }
    };
    
    pc.oniceconnectionstatechange = () => {
      log(`ICE connection state: ${pc.iceConnectionState}`);
    };

    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", offer);
    appendMessage("📤 Offer created & sent to paired peer.");
    
  } catch (err) {
    log("Start error: " + err.message);
    appendMessage("❌ Error starting connection: " + err.message);
  }
};

// Handle incoming offer (answerer)
socket.on("offer", async (offer) => {
  if (isInitiator) {
    log("Ignoring offer - we are the initiator");
    return;
  }
  
  log("Received offer — answering");
  try {
    resetConnection();
    pc = new RTCPeerConnection(RTC_CONFIG);
    
    // Set up data channel handler for incoming channel
    pc.ondatachannel = (event) => {
      log("Received data channel");
      dataChannel = event.channel;
      setupDataChannelHandlers();
    };

    // Set up ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        log("Sending ICE candidate (answerer)");
        socket.emit("candidate", event.candidate);
      }
    };
    
    pc.onconnectionstatechange = () => {
      log(`PC connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        appendMessage("❌ Connection failed. Try again.");
      } else if (pc.connectionState === 'connected') {
        appendMessage("✅ P2P connection established!");
      }
    };

    // Set remote description and create answer
    //old
    // await pc.setRemoteDescription(new RTCSessionDescription(offer));
    // const answer = await pc.createAnswer();
    // await pc.setLocalDescription(answer);
    // socket.emit("answer", answer);
    // appendMessage("📤 Answer created & sent.");


    //new added
    // Set remote description and create answer
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    processPendingCandidates(); // ADD THIS LINE
    const answer = await pc.createAnswer();
    
  } catch (err) {
    log("Offer handling error: " + err.message);
    appendMessage("❌ Error handling offer: " + err.message);
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
    //old
    // await pc.setRemoteDescription(new RTCSessionDescription(answer));
    // appendMessage("📥 Answer received - connection establishing...");

    //new added
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    processPendingCandidates(); // ADD THIS LINE
    appendMessage("📥 Answer received - connection establishing...");
  } catch (err) {
    log("Error applying answer: " + err.message);
    appendMessage("❌ Error applying answer: " + err.message);
  }
});

// Handle ICE candidates
//new added

// Handle ICE candidates
//old
// socket.on("candidate", async (candidate) => {
//   try {
//     if (!pc) { 
//       log("Candidate received but no PC yet - queuing"); 
//       pendingCandidates.push(candidate);
//       return; 
//     }
    
//     if (pc.remoteDescription) {
//       await pc.addIceCandidate(new RTCIceCandidate(candidate));
//       log("ICE candidate added");
//     } else {
//       // Queue candidate until remote description is set
//       pendingCandidates.push(candidate);
//       log("Remote description not set - candidate queued");
//     }
//   } catch (err) {
//     log("addIceCandidate error: " + err.message);
//   }
// });



socket.on("offer", async (offer) => {
  if (isInitiator) {
    log("Ignoring offer - we are the initiator");
    return;
  }
  
  log("Received offer — answering");
  try {
    resetConnection();
    pc = new RTCPeerConnection(RTC_CONFIG);
    
    // Set up data channel handler for incoming channel
    pc.ondatachannel = (event) => {
      log("Received data channel");
      dataChannel = event.channel;
      setupDataChannelHandlers();
    };

    // Set up ICE candidate handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        log("Sending ICE candidate (answerer)");
        socket.emit("candidate", event.candidate);
      }
    };
    
    pc.onconnectionstatechange = () => {
      log(`PC connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        appendMessage("❌ Connection failed. Try again.");
      } else if (pc.connectionState === 'connected') {
        appendMessage("✅ P2P connection established!");
      }
    };

    // Set remote description and create answer
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    processPendingCandidates();
    const answer = await pc.createAnswer();
    
    // ==== MISSING LINES - ADD THESE ====
    await pc.setLocalDescription(answer);
    socket.emit("answer", answer);
    appendMessage("📤 Answer created & sent.");
    // ===================================
    
  } catch (err) {
    log("Offer handling error: " + err.message);
    appendMessage("❌ Error handling offer: " + err.message);
  }
});



//old
// socket.on("candidate", async (candidate) => {
//   try {
//     if (!pc) { 
//       log("Candidate received but no PC yet - queuing"); 
//       return; 
//     }
//     if (pc.remoteDescription) {
//       await pc.addIceCandidate(new RTCIceCandidate(candidate));
//       log("ICE candidate added");
//     } else {
//       log("Remote description not set yet - candidate dropped");
//     }
//   } catch (err) {
//     log("addIceCandidate error: " + err.message);
//   }
// });




// --- Data Channel Management ---
function setupDataChannelHandlers() {
  if (!dataChannel) return;
  
  dataChannel.onopen = () => {
    log("DataChannel opened");
    appendMessage("✅ Data channel ready — you can send files and chat!");
  };
  
  dataChannel.onclose = () => {
    log("DataChannel closed");
    appendMessage("❌ Data channel closed");
  };
  
  dataChannel.onerror = (err) => {
    log("DataChannel error: " + (err && err.message ? err.message : err));
    appendMessage("❌ Data channel error occurred");
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
    chunkSize: msg.chunkSize || 64*1024,
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

function handleFramedChunk(arrayBuffer) {
  if (!receiving.active) return;
  if (arrayBuffer.byteLength < CHUNK_HEADER_BYTES) return;

  const dv = new DataView(arrayBuffer, 0, CHUNK_HEADER_BYTES);
  const magic = dv.getUint32(0, false);
  if (magic !== CHUNK_MAGIC) return;
  
  const idx = dv.getUint32(4, false);
  const len = dv.getUint32(8, false);

  if (arrayBuffer.byteLength < CHUNK_HEADER_BYTES + len) {
    log(`Chunk ${idx} length mismatch`);
    return;
  }

  const chunkData = arrayBuffer.slice(CHUNK_HEADER_BYTES, CHUNK_HEADER_BYTES + len);

  if (!receiving.chunks.has(idx)) {
    receiving.chunks.set(idx, chunkData);
    receiving.receivedBytes += len;
    
    // Update speed display
    const now = Date.now();
    if (!receiving.lastUiUpdate || now - receiving.lastUiUpdate > 200) {
      updateReceiveSpeed();
      receiving.lastUiUpdate = now;
    }
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
      if (dataChannel.bufferedAmount > 512 * 1024) {
        await new Promise(r => setTimeout(r, 10));
        continue;
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
      document.getElementById("fileStatus").innerText = `Sending ${file.name}... ${progress}% (${speed})`;
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
