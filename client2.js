// client.js — robust P2P file transfer with Pokémon pairing
console.log("client.js — pairing + file transfer");

// // Check for WebRTC support
// function checkWebRTCSupport() {
//     if (!window.RTCPeerConnection) {
//         alert("Your browser doesn't support WebRTC. Please use a modern browser like Chrome, Firefox, Safari, or Edge.");
//         return false;
//     }

//     // Special check for Safari
//     const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
//     if (isSafari) {
//         const version = parseInt((navigator.userAgent.match(/version\/(\d+)/i) || [])[1] || "0");
//         if (version < 11) {
//             alert("Please update your Safari browser to version 11 or later for better WebRTC support, or use Chrome/Firefox for best experience.");
//         }
//         // Add Safari-specific console warning
//         console.log("Safari detected. Using Safari-optimized WebRTC configuration.");
//     }
//     return true;
// }

// Check for required features
// function checkBrowserSupport() {
//     const requirements = {
//         webrtc: !!(window.RTCPeerConnection),
//         datachannel: !!(window.RTCPeerConnection && RTCPeerConnection.prototype.createDataChannel),
//         websocket: !!(window.WebSocket),
//         promises: !!(window.Promise),
//         webstorage: !!(window.localStorage),
//         file: !!(window.File && window.FileReader && window.FileList && window.Blob),
//     };
    
//     const missing = Object.entries(requirements)
//         .filter(([_, supported]) => !supported)
//         .map(([name]) => name);
    
//     if (missing.length > 0) {
//         alert(`Your browser is missing required features: ${missing.join(', ')}. Please use a modern browser.`);
//         return false;
//     }
//     return true;
// }

// // Run checks immediately
// if (!checkBrowserSupport() || !checkWebRTCSupport()) {
//     document.body.innerHTML = '<h1>Browser Not Supported</h1><p>Please use a modern browser like Chrome, Firefox, Safari, or Edge.</p>';
// }

// --- Signaling socket ---
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

log(`👤 Your name: ${myName}`);
socket.emit("join", myName);

// Update dropdown of available peers
socket.on("available-peers", (list) => {
  const sel = document.getElementById("peerSelect");
  if (!sel) return;
  sel.innerHTML = "";
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
});

socket.on("connect-error", (msg) => {
  appendMessage(`❌ Connect error: ${msg}`);
});

// Pair button
document.getElementById("pairBtn").onclick = () => {
  const target = document.getElementById("peerSelect").value;
  if (!target) {
    alert("No peer selected");
    return;
  }
  socket.emit("connect-request", { from: myName, to: target });
};

// --- Globals ---
let pc = null;
let dataChannel = null;
let receiving = {
  active: false,
  meta: null,
  chunks: new Map(),
  receivedBytes: 0
};

// Detect if running on Safari
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

const RTC_CONFIG = {
  iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
        { urls: "stun:stun4.l.google.com:19302" },
        // Additional STUN servers for better connectivity
        { urls: "stun:stun.services.mozilla.com:3478" },
        { urls: "stun:stun.xten.com:3478" },
        // Add your TURN servers here if available
        // {
        //   urls: "turn:your-turn-server.com:3478",
        //   username: "username",
        //   credential: "credential"
        // }
    ],
  iceTransportPolicy: 'all',
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
  // Safari-specific optimizations
 // sdpSemantics: isSafari ? 'plan-b' : 'unified-plan',
  // Enable all potential ICE candidates
  iceTransportPolicy: 'all',
  // Increase chances of connection in restricted networks
  certificates: undefined,
  // Better handling of Safari's WebRTC implementation
  optional: [
    { DtlsSrtpKeyAgreement: true },
    { RtpDataChannels: true }
  ]
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


// Reset connection
function resetConnection() {
  if (dataChannel) {
    try { dataChannel.close(); } catch(e){}
    dataChannel = null;
  }
  if (pc) {
    try { pc.close(); } catch(e){}
    pc = null;
  }
  receiving = { active: false, meta: null, chunks: new Map(), receivedBytes: 0 };
}

// --- Create / start connection (caller/offerer) ---
document.getElementById("startBtn").onclick = async () => {
  if (!pairedPeer) {
    alert("Pair with someone first!");
    return;
  }
  log("Start clicked — creating PeerConnection");
  try {
    resetConnection();
    pc = new RTCPeerConnection(RTC_CONFIG);

    dataChannel = pc.createDataChannel("filetransfer", { ordered: true });
    setupDataChannelHandlers();

    pc.onicecandidate = (ev) => {
      if (ev.candidate) socket.emit("candidate", ev.candidate);
    };
    pc.onconnectionstatechange = () => {
      log(`PC state: ${pc.connectionState}`);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", offer);
    appendMessage("Offer created & sent.");
  } catch (err) {
    log("Start error: " + err.message);
  }
};

// --- Handle incoming offer (answerer) ---
socket.on("offer", async (offer) => {
  log("Received offer — answering");
  try {
    resetConnection();
    pc = new RTCPeerConnection(RTC_CONFIG);

    pc.ondatachannel = (ev) => {
      dataChannel = ev.channel;
      setupDataChannelHandlers();
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) socket.emit("candidate", ev.candidate);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("answer", answer);
    appendMessage("Answer created & sent.");
  } catch (err) {
    log("Offer handling error: " + err.message);
  }
});

// --- Handle incoming answer ---
socket.on("answer", async (answer) => {
  try {
    if (!pc) { log("No pc when answer arrived"); return; }
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    appendMessage("Connection established.");
  } catch (err) {
    log("Error applying answer: " + err.message);
  }
});

// --- ICE candidates ---
socket.on("candidate", async (candidate) => {
  try {
    if (!pc) { log("candidate received but no pc yet"); return; }
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    log("addIceCandidate error: " + err.message);
  }
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
});

socket.on('reconnect', (attemptNumber) => {
    log(`Reconnected after ${attemptNumber} attempts`);
    appendMessage('✅ Reconnected to server');
    if (myName) {
        socket.emit("join", myName);
    }
});

socket.on('reconnect_attempt', (attemptNumber) => {
    log(`Reconnection attempt ${attemptNumber}`);
});

socket.on('reconnect_error', (error) => {
    log('Reconnection error: ' + error);
    appendMessage('⚠️ Reconnection failed. Please refresh the page.');
});

socket.on('error', (error) => {
    log('Socket error: ' + error);
    appendMessage('⚠️ Connection error occurred.');
});
// --- Data channel helpers ---
function setupDataChannelHandlers() {
  if (!dataChannel) return;
  dataChannel.onopen = () => {
    log("DataChannel open");
    appendMessage("✅ Data channel ready — you can send files.");
  };
  dataChannel.onclose = () => {
    log("DataChannel closed");
    appendMessage("❌ Data channel closed");
  };
  dataChannel.onerror = (err) => {
    log("DataChannel error: " + (err && err.message ? err.message : err));
  };

  dataChannel.onmessage = async (event) => {
    try {
      if (typeof event.data === "string") {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { appendMessage("Peer: " + event.data); return; }
        if (msg.type === "chat") {
          const sender = msg.sender || (pairedPeer || "Peer");
          appendMessage(`${sender}: ${msg.message}`);
        } else if (msg.type === "file_start") {
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
          
          // Start speed updates every second
          if (receiving.speedUpdateInterval) {
            clearInterval(receiving.speedUpdateInterval);
          }
          receiving.speedUpdateInterval = setInterval(updateTransferSpeed, 1000);
          
          appendMessage(`📥 Receiving ${receiving.meta.fileName} (${formatFileSize(receiving.meta.fileSize)})`);
          updateTransferSpeed(); // Initial update
        } else if (msg.type === "file_end") {
          log("file_end received — assembling");
          await finalizeReceive();
        } else {
          log("Unknown control message: " + JSON.stringify(msg));
        }
        return;
      }

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
};

// --- Chunk handling & reassembly ---
function handleFramedChunk(arrayBuffer) {
  if (!receiving.active) return;
  if (arrayBuffer.byteLength < CHUNK_HEADER_BYTES) return;

  const dv = new DataView(arrayBuffer, 0, CHUNK_HEADER_BYTES);
  const magic = dv.getUint32(0, false);
  if (magic !== CHUNK_MAGIC) return;
  const idx = dv.getUint32(4, false);
  const len = dv.getUint32(8, false);

  const chunkData = arrayBuffer.slice(CHUNK_HEADER_BYTES, CHUNK_HEADER_BYTES + len);

  if (!receiving.chunks.has(idx)) {
    receiving.chunks.set(idx, chunkData);
    receiving.receivedBytes += len;
    
    // Update speed display more frequently for better responsiveness
    // But don't update UI too often to avoid performance issues
    const now = Date.now();
    if (!receiving.lastUiUpdate || now - receiving.lastUiUpdate > 200) {
      updateTransferSpeed();
      receiving.lastUiUpdate = now;
    }
  }
}

// Function to update and display transfer speed
function updateTransferSpeed() {
  if (!receiving.active || !receiving.startTime) return;
  
  const now = Date.now();
  const elapsedTime = (now - receiving.startTime) / 1000; // in seconds
  
  // Calculate current speed (bytes per second)
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
  
  // Update the display
  const progress = Math.round((receiving.receivedBytes / receiving.meta.fileSize) * 100);
  const currentSpeedText = formatSpeed(receiving.currentSpeed);
  const averageSpeedText = formatSpeed(receiving.averageSpeed);
  const elapsedTimeText = formatTime(elapsedTime);
  
  document.getElementById("fileStatus").innerHTML = `
    Receiving ${receiving.meta.fileName}... ${progress}%<br>
    Speed: ${currentSpeedText} (Avg: ${averageSpeedText})<br>
    Time: ${elapsedTimeText}
  `;
  
  // Update for next calculation
  receiving.lastUpdateTime = now;
  receiving.lastBytes = receiving.receivedBytes;
}

// Helper function to format time (seconds to MM:SS)
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

async function finalizeReceive() {
  if (!receiving.active || !receiving.meta) return;
  
  // Clear the speed update interval
  if (receiving.speedUpdateInterval) {
    clearInterval(receiving.speedUpdateInterval);
    receiving.speedUpdateInterval = null;
  }
  
  const meta = receiving.meta;
  const expected = meta.totalChunks;

  if (receiving.chunks.size !== expected) {
    appendMessage(`⚠️ Missing chunks: got ${receiving.chunks.size}/${expected}`);
  }

  const parts = [];
  for (let i = 0; i < expected; i++) {
    const c = receiving.chunks.get(i);
    if (c) parts.push(c);
    else { 
      appendMessage(`❌ Missing chunk ${i}`); 
      document.getElementById("fileStatus").innerText = `Failed to receive ${meta.fileName} - missing chunks`;
      return; 
    }
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

  // Display final statistics
  const totalTime = (Date.now() - receiving.startTime) / 1000;
  const averageSpeed = receiving.receivedBytes / totalTime;
  
  document.getElementById("fileStatus").innerHTML = `
    ✅ File received: ${meta.fileName}<br>
    Average speed: ${formatSpeed(averageSpeed)}<br>
    Total time: ${formatTime(totalTime)}
  `;
  
  appendMessage(`📁 File ready: ${meta.fileName} (${formatFileSize(blob.size)})`);

  // Reset receiving object with all properties
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

// --- File sending ---
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
// ...existing code...
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

  let offset = 0, idx = 0;
  const start = Date.now(); // <-- FIX: set start timestamp

  // Optional: use bufferedAmountLowThreshold + handler when available
  if (typeof dataChannel.bufferedAmountLowThreshold === "number") {
    dataChannel.bufferedAmountLowThreshold = 256 * 1024;
  }

  try {
    while (offset < file.size) {
      // backpressure: wait while bufferedAmount is high
      if (dataChannel.bufferedAmount > 512 * 1024) {
        // try to wait for bufferedamountlow if supported
        if (typeof dataChannel.onbufferedamountlow === "function") {
          await new Promise((res) => {
            const handler = () => { dataChannel.onbufferedamountlow = null; res(); };
            dataChannel.onbufferedamountlow = handler;
            // fallback timeout
            setTimeout(() => { dataChannel.onbufferedamountlow = null; res(); }, 200);
          });
        } else {
          await new Promise(r => setTimeout(r, 20));
        }
        continue;
      }

      const end = Math.min(offset + chunkSize, file.size);
      const slice = file.slice(offset, end);
      const arrayBuffer = await slice.arrayBuffer();

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

      const elapsed = Math.max(0.001, (Date.now() - start) / 1000);
      const speed = formatSpeed(offset / elapsed);
      const progress = Math.round((offset / file.size) * 100);
      const fsEl = document.getElementById("fileStatus");
      if (fsEl) fsEl.innerText = `Sending ${file.name}... ${progress}% (${speed})`;
    }

    dataChannel.send(JSON.stringify({ type: "file_end", fileName: file.name }));
    appendMessage(`✅ Sent ${file.name} (${formatFileSize(file.size)})`);
    const fsEl2 = document.getElementById("fileStatus");
    if (fsEl2) fsEl2.innerText = `File sent: ${file.name}`;
  } catch (err) {
    log("sendFile error: " + (err && err.message ? err.message : err));
    appendMessage("❌ Error sending file: " + (err && err.message ? err.message : err));
  }
}
// ...existing code...

// --- Chat send ---
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
    sender: myName,        // include our name
    timestamp: Date.now()
  };

  dataChannel.send(JSON.stringify(chatMessage));
  appendMessage(`${myName}: ${msg}`);
  input.value = "";
};


// Enter key support
document.getElementById("msgInput").addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    document.getElementById("sendBtn").click();
  }
});


